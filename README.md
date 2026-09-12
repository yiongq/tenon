# Tenon

A desktop agent workbench — one agent kernel, three surfaces (chat, long-running local work, coding), local sandboxing, MCP host, plugins, and later a multi-tenant cloud host.

Built with Electron + TypeScript. Apache-2.0.

> Early stage. Nothing runnable yet — the repository currently holds the architecture and the phase-0 spec. See `docs/architecture/master-reference.md` for the full reference and `docs/architecture/00-foundation/spec.md` for what is being built first.

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

## Name

A tenon is the part of a joint that holds by shape, not by glue — the kernel, contracts and permission gates are meant to fit that way.
