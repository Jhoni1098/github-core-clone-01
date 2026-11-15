# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Jhoni1098/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Jhoni1098/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process, stdlib only, no git binary, no database: git smart HTTP (v2 upload-pack, v0 receive-pack), REST v3, GraphQL v4 and MCP over one in-memory store snapshotted to disk. Written from scratch for [the contest](https://make.fun/bounty/github-core-clone-01).

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its own. There is nothing to install: the program imports `node:http`, `node:crypto`, `node:zlib`, `node:fs`, `node:path` and its own `app.ts` only, and the trial has no package manager and no internet.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send (viewer, repository, node, `__type`, issues/pull-request connections, create/close/merge mutations, batched operations) |
| `POST /mcp` | Model Context Protocol over streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` (create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request) |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` (v2 ls-refs/fetch with shallow support, v0 fetch, receive-pack with report-status and non-fast-forward refusal) |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; `/healthz` is the boot probe and takes none.

## Design notes

- **Own git object model.** SHA-1 blobs, trees (git sort order), commits and tags are built and parsed in `app.ts`, with a plain-object pack writer and a delta-resolving pack reader (OFS/REF deltas, zlib streams). Pushes are validated for fast-forward only; the pack is unpacked and refs updated atomically.
- **One store, four surfaces.** Repositories, issues, pull requests and comments live in one in-memory store; REST, GraphQL and MCP all read and write it, so a pull request merged through MCP is visible to `gh` immediately. The store is snapshotted to `FORGE_DATA_DIR` (default `/tmp/github-forge-data`) every 15 s while dirty and loaded on boot.
- **Deterministic.** Commit timestamps come from a counter, never the wall clock, so the same requests in the same order produce the same objects.

## The lifecycle (main.ts)

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with `server.address().port`. Never bind 8080: that is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers `{"done":false}` while the suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never exit before it says `true`.
4. **Exit 0** when it does.

## Layout

- `main.ts`: the lifecycle above. Keep it as it is.
- `app.ts`: the server — the whole forge in one file.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

---

<sub>Entered on [make.fun](https://make.fun/?ref=nd0791d4&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
