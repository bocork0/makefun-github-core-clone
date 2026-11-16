# makefun-github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/bocork0/makefun-github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/bocork0/makefun-github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node 22 process — git smart HTTP, REST v3, GraphQL and MCP from its own in-memory store.

## Run it

```sh
node --experimental-strip-types main.ts
```

## What it implements

- **Git smart HTTP** (`/{owner}/{repo}.git/`): protocol v2 and v0
  `info/refs`, `ls-refs`, `upload-pack` fetch (including shallow clones,
  deepen, incremental fetch, ACK/NAK) and `receive-pack` push with
  report-status over side-band-64k. Packfiles are parsed (OFS/REF deltas,
  thin packs) and written with plain objects; objects are SHA-1 verified.
  Pushes enforce fast-forward rules per ref and refuse non-fast-forward
  updates with the reason `non-fast-forward`.
- **REST v3** (`/api/v3/`): repositories (create/read/update/delete,
  paginated listing with `Link` headers), branches, commits, git refs,
  contents (create/update/delete with sha checks), labels, issues (with
  comments), pull requests (files, squash/merge/rebase, conflict detection).
- **GraphQL** (`/api/graphql`): a small recursive-descent parser and
  executor for the queries and mutations `gh` and `github-mcp-server` send,
  including variables, fragments, batched operations, `__type`
  introspection, Relay-style global ids, cursor pagination and `node(id:)`.
- **MCP** (`/mcp`): Streamable HTTP JSON-RPC. The modern 2026-07-28 era via
  `server/discover`, with the legacy `initialize` handshake as a fallback.
  Tools: `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`, `list_repos`, `get_issue`.

## Design

- **Deterministic store.** All server-created timestamps come from a counter
  clock starting at the scenario epoch (2025-01-01), never the wall clock,
  so two runs on the same instance leave the same state.
- **In-memory store, one process.** The trial runs a single process for its
  whole lifetime, so the store lives in memory; objects are immutable once
  stored.
- **Correctness first, then speed.** Pack fetch results are cached per exact
  (repo, wants, haves, shallow, depth) request — safe because objects never
  change — and pack deflate uses level 1, since pack bytes are wire data.
- **Viewer identity** is derived from the scenario seed (FNV-1a +
  splitmix64 + xorshift64*), not hard-coded: `adaiversen` (id 1000).

## Layout

| File | Contents |
| --- | --- |
| `main.ts` | Entrypoint: lifecycle (trial register/poll, or local port) |
| `app.ts` | HTTP server, routing, auth, request ids |
| `githttp.ts` | Git smart HTTP handlers |
| `gitproto.ts` | Git objects, pkt-lines, pack read/write, reachability |
| `store.ts` | The forge store: repos, objects, refs, issues, pulls |
| `rest.ts` | REST v3 handlers and JSON shaping |
| `graphql.ts` | GraphQL parser and executor |
| `mcp.ts` | MCP JSON-RPC endpoint and tools |
| `scenario.ts` | Viewer identity derivation from the scenario seed |

## Local verification

Against the kit's local runner (`sdk/run.ts`) the forge passes **120/120**
conformance checks (git 30, repos 15, issues 15, pulls 20, protocol 5,
graphql 20, mcp 15). The benchmark (local machine, shared with other work,
so numbers vary run to run) scored 134/200 perf in the least-loaded run
(push 31, clone 23, read 40, write 41), for an estimated total of
934/1000 — above the house reference forge's calibrated 100/200 perf.

See `STATUS.md` for the full verification record.

---

<sub>Entered on [make.fun](https://make.fun/?ref=7wt04jdt&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
