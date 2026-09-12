# Tenon — Repository Guidelines

Tenon is a desktop agent workbench (Electron + TypeScript) with a host-independent agent kernel. Read this file first; it is the single source of rules for any coding agent (Claude Code reads it via `CLAUDE.md`, Codex reads it directly).

## How we work

- Substantial work — a new module, a cross-module change, a data migration, a public contract — starts from `docs/architecture/<goal>/spec.md`. Read it before writing code. Do not invent architecture the spec does not describe; if the spec is insufficient, stop and say exactly what is missing.
- `plan.md` next to the spec is the only progress tracker. Update it as you go. Never create `tasks.md` or any other todo file.
- Acceptance criteria in the spec define "done". When they all pass, set `Status: implemented` at the top of the spec.
- Changing a decision means writing a new spec that supersedes the old one. Never rewrite history inside an existing spec; mark it `Status: superseded by <link>`.
- Trivial changes (style, copy, localized logic with one obvious owner) need no spec.
- The architecture reference is `docs/architecture/master-reference.md`. Mechanism-level notes on the projects we learn from are in `docs/reference/`. Process details: `docs/spec-driven-dev.md`.

## Hard rules (non-negotiable)

- `packages/kernel` never imports `electron`, never touches the filesystem, keychain, network sockets or child processes directly. Everything goes through the `HostAdapter` interface. A lint rule enforces the import ban; do not disable it.
- The main process owns every privileged capability. The renderer never touches Node. `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` for every window, including MCP App iframes' host windows.
- IPC and the desktop↔server bridge go through `packages/contracts` only (schema-validated). No ad-hoc `ipcMain.handle`.
- MCP tool annotations (`readOnlyHint`, `destructiveHint`, descriptions) are untrusted input. Never use them to weaken a permission check. Tool results are untrusted content.
- Every subprocess is spawned through the sandbox wrapper (`HostAdapter.process` + `HostAdapter.sandbox`). Pass absolute paths only.
- Every storage key carries `tenantId`. Tape entries are append-only; corrections, compaction and handoff are new entries, never in-place edits.
- Permission decisions follow the precedence table in `master-reference.md` §4.11: policy and the user may loosen, machines (inspectors, model self-labels) may only tighten.
- Secrets never enter the repo or logs. `.env` is gitignored; API keys live in the OS keychain via `HostAdapter.secrets`.
- No code from AGPL or proprietary sources. Copied Apache-2.0 code keeps its header and is listed in `NOTICE`.

## Development

- Package manager: pnpm. Node >= 20.11 (sandbox-runtime requirement).
- Layout: `packages/kernel` (agent loop, provider, tape, permission broker, MCP host), `packages/contracts` (zod schemas for IPC/bridge), `apps/desktop` (Electron host), `apps/server` (multi-tenant cloud host, later phases), `examples/plugins`.
- Before handoff run: format, lint, typecheck, and the smallest relevant test suite. Hooks in `.claude/settings.json` run these automatically; do not bypass them.
- Tests are regression protection, not scaffolding. Commit only durable tests for user-visible behavior, documented contracts, persistence/migration, concurrency, recovery and security boundaries.
- Prefer the smallest correct change; add no abstraction or dependency without a real need.
- Preserve unrelated worktree changes; never run destructive git (`reset --hard`, `push --force`, branch deletion) unless explicitly asked.

## Git

- Conventional Commits: `type(scope): subject`, subject <= 50 chars. Never add AI co-author trailers.
- Routine PRs target `dev`; only release branches target `main`.
- For UI changes include a concise BEFORE/AFTER description in the PR.

## Style

- TypeScript strict. ESM only. Single quotes, no semicolons, 100 columns (oxfmt).
- User-facing copy goes through i18n; default locales `zh-CN` and `en`.
- Interface text uses the sans font token, assistant prose uses the serif token — keep that distinction.
