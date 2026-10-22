# Tenon

A desktop agent workbench built on a host-independent agent kernel. Point it at a folder and the agent reads, edits and runs commands there. Changes ask for your approval first, an eight-layer permission engine decides what may run, and each step is appended to a session tape that survives crashes and restarts.

Electron + TypeScript · macOS and Linux · Apache-2.0

> 中文：桌面端大模型 agent 工作台。工具调用逐次审批、8 层权限判定、MCP 连接与 OAuth、会话落盘与崩溃恢复。

<!-- TODO screenshot: one conversation with an approval card open, saved as docs/assets/approval-card.png. The model picker must not show a vendor model name. -->

## What works today

- **Agent loop**: read, write, edit, shell, glob, grep, web fetch, web search, sub-agents, and asking you a question. Stop ends a running command's whole process tree.
- **Per-call approval**: a built-in tool call that changes something shows a card first, and approving covers only that one file, command or site for this session. Connector tools ask too, unless you set one to always allow. Cards survive an app restart, and approving resumes the same paused run.
- **Permission engine**: eight layers evaluated together, then merged as deny > must-ask > allow. Once a session has touched private data and read untrusted content, fetching a URL that neither you nor a search result supplied must ask first. Web fetch is pinned to one checked address, so private ranges and DNS rebinding are refused.
- **MCP host**: stdio and Streamable HTTP servers, plus OAuth sign-in that refuses a mismatched issuer and keeps tokens in the OS keychain. A server's read-only hint never skips approval, and a changed tool definition cancels "always allow".
- **Session tape**: an append-only SQLite log of every fact. Conversations come back after a restart, and interrupted runs recover at launch.
- **Model endpoints**: built-in providers, plus custom vendors on either supported wire protocol, set up in Settings.

**Sandbox (phase 4a, in final acceptance).** Shell commands run inside the OS sandbox (Seatbelt on macOS, bubblewrap on Linux): they can write to your working folders and reach no network until you add a site under Settings → Permissions & network. When something is blocked, a receipt shows what was stopped and lets you allow that site for the task, allow one write location, or allow one unrestricted rerun, which asks again before it runs.

## How it is tested

- **4,400+ unit and integration tests** (Vitest), and **250+ end-to-end tests** that drive the real Electron app with Playwright.
- **Fault injection**: 200 seeded stop points (while streaming, while a tool runs, while waiting for approval) and 200 simulated crash points, on each wire protocol. In every case, each tool call still ends with exactly one result.
- **Agent evals**: 20 tasks run with a real model. Each is graded by a check script that reads only the workspace files and the tape, never the model's account of what it did.
- **CI on every PR**: format, lint, typecheck, unit tests, build and the eval gate; end-to-end tests on Linux; the sandbox black-box suite on Linux and macOS.
- **Spec first**: each phase has a spec with numbered acceptance criteria and a plan that tracks it step by step; from phase 2 on, every step records its test runs and the mutations (deliberately broken code) that had to turn a test red ([docs/architecture](docs/architecture/)).

## Quick start

```sh
pnpm install   # Node >= 22.12, pnpm >= 10.30; also installs git hooks and downloads Electron
pnpm dev       # opens the app; add a model endpoint and key in Settings
pnpm check     # format, lint, typecheck, unit and integration tests
```

End-to-end: `pnpm build && pnpm test:e2e`. Tenon runs from source; details are under [Working on it](#working-on-it).

## Roadmap

- Rest of phase 4: a file bridge with snapshots and one-click restore (4b), approval modes (4c), and a task-mode UI (4d).
- Phase 5: the extension layer (skills, plugins, MCP Apps, Artifacts).
- Phase 6b: a multi-tenant cloud host.

Full reference: [`docs/architecture/master-reference.md`](docs/architecture/master-reference.md).

## Layout

```
packages/kernel      agent loop, providers, tape, permission broker, MCP host — host-independent
packages/contracts   zod schemas for IPC and the desktop↔server bridge frames
apps/desktop         Electron host
apps/server          multi-tenant cloud host (phase 6b)
examples/plugins     sample plugins for the marketplace flow (phase 5)
docs/                architecture, ADRs, mechanism notes on the projects we learn from
```

## Working on it

Read `AGENTS.md` and `docs/spec-driven-dev.md`. Coding agents (Claude Code, Codex) read the same files.

```sh
pnpm install          # Node >= 22.12, pnpm >= 10.30; installs git hooks and the Electron binary
pnpm dev              # desktop app with hot reload
pnpm check            # format:check, lint, typecheck, unit tests
pnpm build && pnpm test:e2e
```

Keys added in Settings go to the OS keychain. For development you can instead copy `.env.example` to `.env.local` (gitignored, ignored by packaged builds); `pnpm dev` picks it up. `pnpm test:live` and `pnpm eval` call a real endpoint and cost tokens, so CI never runs them. When starting Electron from inside an Electron-hosted terminal, unset `ELECTRON_RUN_AS_NODE` first.

## Name

A tenon is the part of a joint that holds by shape, not by glue — the kernel, contracts and permission gates are meant to fit that way.
