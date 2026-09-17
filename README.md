# Tenon

A desktop agent workbench — one agent kernel, three surfaces (chat, long-running local work, coding), local sandboxing, MCP host, plugins, and later a multi-tenant cloud host.

Built with Electron + TypeScript. Apache-2.0.

> Early stage. Phase 0 (the foundation) runs: a sandboxed Electron shell that streams a chat reply, a kernel that can drive an MCP stdio server through its host adapter, and the gates around them. No agent loop, permissions or sandbox yet. See `docs/architecture/master-reference.md` for the full reference and `docs/architecture/00-foundation/spec.md` for what phase 0 covers.

## Layout

```
packages/kernel      agent loop, providers, tape, permission broker, MCP host — host-independent
packages/contracts   zod schemas for IPC, the desktop↔server bridge, and the plugin format
apps/desktop         Electron host
apps/server          multi-tenant cloud host (later phase)
examples/plugins     sample plugins for the marketplace flow
docs/                architecture, ADRs, mechanism notes on the projects we learn from
```

## Working on it

Read `AGENTS.md` and `docs/spec-driven-dev.md`. Coding agents (Claude Code, Codex) read the same files.

```sh
pnpm install          # Node >= 22.12, pnpm 10; installs git hooks and the Electron binary
pnpm dev              # desktop app with hot reload
pnpm check            # format:check, lint, typecheck, unit tests
pnpm build && pnpm test:e2e
```

The phase-0 chat talks to the Anthropic API (or a compatible endpoint): export `ANTHROPIC_API_KEY`, and optionally `ANTHROPIC_BASE_URL` / `TENON_MODEL`, before `pnpm dev`. When starting Electron from inside an Electron-hosted terminal, unset `ELECTRON_RUN_AS_NODE` first.

## Name

A tenon is the part of a joint that holds by shape, not by glue — the kernel, contracts and permission gates are meant to fit that way.
