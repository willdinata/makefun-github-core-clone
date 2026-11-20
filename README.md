# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/adaiversen/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/adaiversen/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge implemented in TypeScript (Node 22 standard library only, no external npm dependencies, no git binary). Built as an entry to make.fun competition `github-core-clone-01`.

## Description

This forge runs as a single self-contained process with its own in-memory database store. It serves the four core protocols and interfaces that developer tools and AI agents expect from GitHub, without requiring any external database, file system git binary, or UI dashboard.

## The Four Surfaces

1. **Git Smart HTTP (`/{owner}/{repo}.git`)**:
   - Upload pack protocol v2 (`ls-refs`, `fetch` with shallow boundaries, object streaming).
   - Receive pack protocol v0 (`report-status`, side-band-64k, delete-refs, fast-forward checks).
   - Custom implementation of git objects, delta application, tree/commit/blob parsing, and packfile generation entirely in TypeScript.
2. **REST v3 API (`/api/v3`)**:
   - Repository management (`GET`, `POST`, `PATCH`, `DELETE`, pagination via `Link rel="next"`).
   - Branches and commits introspection.
   - File contents (`PUT /contents`, `GET /contents`, `DELETE /contents` with optimistic concurrency via SHA).
   - Issues and issue comments (numbering, filtering, sorting, labels).
   - Pull requests and squash merging (merge conflicts handling, file change lists).
3. **GraphQL v4 API (`/api/graphql`)**:
   - Query and mutation handling conforming to GitHub GraphQL schema expectations (`viewer`, `repository`, `issue`, `issues`, `pullRequests`, `pullRequest`, `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`, `addComment`, `node`).
   - Batched operation execution and structured error reporting.
4. **Model Context Protocol (`/mcp`)**:
   - JSON-RPC 2.0 over Streamable HTTP supporting session initialization (`server/discover`, revision `2026-07-28`), `tools/list`, and `tools/call`.
   - Native tools: `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, and `merge_pull_request`.

## lib/ Architecture

- `store.ts`: In-memory data store for users, repositories, refs, issues, comments, pull requests, and git objects.
- `gitobj.ts`: Git object parser, serializer, hashing (SHA-1), packfile builder, and delta resolver.
- `gitproto.ts`: Git smart-HTTP protocol handlers (`info/refs`, `upload-pack`, `receive-pack`).
- `rest.ts`: GitHub REST v3 API routing and handlers.
- `merge.ts`: Branch diffing and squash merge logic.
- `graphql.ts`: GraphQL v4 query parser and executor.
- `mcp.ts`: Model Context Protocol server endpoints and tool dispatchers.

## Determinism Rules

- All timestamps and dates emitted or stored derive strictly from `process.env.MAKEFUN_TRIAL_NOW` (no calls to `Date.now()` or `new Date()` for state generation).
- All identifiers use deterministic per-store sequence counters (no `Math.random` or `crypto.randomUUID`).
- Iteration order stability: keys are sorted wherever object or map traversal order could affect serialization or export.

## Run It

```sh
node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=63p7zf8z&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
