// github-core-clone-01 entrypoint: the agent/v1 lifecycle for the forge.
//
// This file does no forging itself. It boots the server built by app.ts, tells the
// harness where to find it, and stays alive until the harness says the suite is
// finished. The harness (the "env") lives at MAKEFUN_ENV_URL, a different origin
// from this process, and the conversation with it is three moves:
//
//   1. listen on a kernel-chosen port, so we never collide with the env's 8080
//   2. POST {port} to <env>/register, so the env can dial us as its base URL
//   3. GET <env>/done on a growing interval until it answers {"done": true}
//
// Only then do we shut the server down and leave with status 0. Anything that
// fails along the way is retried with a short exponential backoff, because the
// env is a local service and a transient refusal is not a reason to give up.
// Without MAKEFUN_ENV_URL there is nobody to talk to, so we leave at once.

import { createApp } from './app.ts';

// How long a single env request may take before we treat it as failed.
const REQUEST_DEADLINE_MS = 5_000;
// First pause between done polls; it doubles after each answer, up to the cap.
const POLL_FIRST_MS = 200;
const POLL_CAP_MS = 2_000;
// How many times registration is attempted before we admit defeat.
const REGISTER_TRIES = 12;

/** Pause the process for `ms` milliseconds. */
function rest(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read a fetch Response as JSON, tolerating an empty or non-JSON body. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Send a JSON document to the env and hand back the status plus the parsed
 * body. A network error or a timeout surfaces as a thrown error so the caller
 * can decide whether to retry.
 */
async function sendJson(
  url: string,
  method: 'GET' | 'POST',
  payload?: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
  });
  return { status: response.status, body: await readJson(response) };
}

/**
 * Announce our listening port to the env. The first announcement wins: if the
 * env answers 409 it already knows a port for us, which counts as registered.
 * Anything else that is not a success is retried, with the pause doubling
 * between attempts, until the attempts run out.
 */
async function announce(envOrigin: string, port: number): Promise<void> {
  const target = `${envOrigin}/register`;
  let pause = POLL_FIRST_MS;
  for (let attempt = 1; attempt <= REGISTER_TRIES; attempt += 1) {
    try {
      const { status } = await sendJson(target, 'POST', { port });
      if (status === 200 || status === 201 || status === 204 || status === 409) return;
      console.error(`register attempt ${attempt}: env answered ${status}`);
    } catch (error) {
      console.error(`register attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (attempt < REGISTER_TRIES) {
      await rest(pause);
      pause = Math.min(pause * 2, POLL_CAP_MS);
    }
  }
  throw new Error(`could not register port ${port} with ${envOrigin}`);
}

/**
 * Ask the env, over and over, whether the suite has finished. A "false"
 * answer means keep asking; a failed ask is treated the same way, after a
 * pause. This only returns once the env answers {"done": true}.
 */
async function awaitDone(envOrigin: string): Promise<void> {
  const target = `${envOrigin}/done`;
  let pause = POLL_FIRST_MS;
  for (;;) {
    try {
      const { body } = await sendJson(target, 'GET');
      const done = typeof body === 'object' && body !== null && (body as { done?: unknown }).done === true;
      if (done) return;
    } catch (error) {
      console.error(`done poll failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await rest(pause);
    pause = Math.min(pause * 2, POLL_CAP_MS);
  }
}

/** Boot the forge, register it, wait for the suite, then leave cleanly. */
async function boot(): Promise<void> {
  const envOrigin = process.env.MAKEFUN_ENV_URL;
  if (envOrigin === undefined || envOrigin === '') {
    console.error('MAKEFUN_ENV_URL is not set; nothing to register with');
    process.exit(1);
  }

  const forge = createApp();
  await new Promise<void>((resolve, reject) => {
    forge.once('error', reject);
    forge.listen(0, () => {
      forge.off('error', reject);
      resolve();
    });
  });

  const address = forge.address();
  if (address === null || typeof address === 'string') {
    console.error('the forge did not bind to a TCP port');
    process.exit(1);
  }
  const port = address.port;
  console.log(`forge listening on port ${port}`);

  await announce(envOrigin, port);
  console.log(`registered port ${port} with ${envOrigin}`);

  await awaitDone(envOrigin);
  console.log('suite done; shutting down');

  forge.closeAllConnections?.();
  await new Promise<void>((resolve) => forge.close(() => resolve()));
}

boot()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
