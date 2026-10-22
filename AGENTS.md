# Tenon — Repository Guidelines

Tenon is a desktop agent workbench (Electron + TypeScript) with a host-independent agent kernel. Read this file first; it is the single source of rules for any coding agent (Claude Code reads it via `CLAUDE.md`, Codex reads it directly).

<!-- sdd:core v=2.0.2 tier=standard hash=1e4f89c5d746 -->
## 规格驱动开发（sdd 核心）
1. 两个文件：每个目标一个文件夹。spec.md 写做什么、怎样算做完；plan.md 是唯一的进度表；
   有记录时才建 log.md，只往后追加。不建 tasks.md、TODO.md。
2. 开工与交接：说「继续」「开工」或没有指令时，找 Status: ready、plan 里还有没勾步骤的 spec。
   只有一份就接着做，多于一份就问 owner；开了路线图时先挑 architecture 下编号最小的，没有再看 features。
   动手前说清挑了哪份、哪一步。停下前重写 plan 的「当前」和「交接」。
   plan 只剩「owner 验收」时，停下等，不自己改 Status。
3. 状态与批准：draft → ready → implemented，或 superseded。改成 ready、implemented 只由 owner 定，
   并在页头记 Approved: 状态 · 日期 · 「逐字原话」· 出处。
   原话只有「继续」「开工」「好」「都按推荐」，或者没点名这份 spec，都不算批准。
4. 改动两条路：implemented 之前直接改原文，从 ready 起每次在「修订记录」记一行；
   实现中只收紧或澄清的可以改，放宽要求或改已合入的接口先要 owner 点名批准。
   implemented 之后正文不动，新写一份 spec，用 Changes / Changed by 页头连起来。
5. 写法：引用文档写节名，引用代码写「路径 + 函数名或类型名」，不写行号。
   代号必须在本仓库有定义，正文先写规则本身，代号只放句末当出处。
   术语第一次出现时解释（项目有 overview 的术语表，写「见 overview §术语」也算）；一段一件事；决策历史放 decisions.md 或附录。
6. plan 只放：步骤、「当前 / 需要你」、最新一条交接、Open。最后一步是「owner 验收 → 改 Status」。
   不列「开 PR」「合并 PR」这类步骤。实施、验收、评审记录写进 log.md。
7. 做完前过检查：每条验收有测试，或标（人工）/（live）；修 bug 先写复现它的失败测试；
   改弱已有测试，写一行「测试改动：文件 · 用例 · 为什么」。
   说做完之前，跑项目的检查（至少测试）和 python3 .sdd/spec-check.py。
   实现时：测试如果有错，直接说；不为某个用例写死结果；同一处反复跑红，就停下报告。
8. 独立评审：说做完或合并之前，在新上下文里评审一遍，带证据的问题修掉。
细则：docs/spec-driven-dev.md（standard 起）；没有时见 skill 的 references/。
<!-- /sdd:core -->

## How we work

- Substantial work — a new module, a cross-module change, a data migration, a public contract — starts from `docs/architecture/<goal>/spec.md` (a user-visible feature: `docs/features/<goal>/spec.md`). Read it before writing code. Do not invent architecture the spec does not describe; if the spec is insufficient, stop and say exactly what is missing.
- Changes after `implemented` follow core rule 4; the scope of presentation-only clause replacement is defined in the project additions in `docs/spec-driven-dev.md`.
- Documentation starts at `docs/README.md`; the roadmap is [the sdd stage table](docs/architecture/master-reference.md#阶段表). The architecture reference is `docs/architecture/master-reference.md`; the current architecture overview will be `docs/architecture/overview.md` once written in the follow-up PR. Project decisions live in `docs/adr/`; mechanism-level reference notes in `docs/reference/`; process details in `docs/spec-driven-dev.md`.
- UX specs live in `docs/ux/`. They are derived from a private teardown kit at `../tenon-uxkit/` (outside this repo). You may read `../tenon-uxkit/interactions.md` for behavior; never copy its files, class names, token values or font names into this repository.

## Hard rules (non-negotiable)

- `packages/kernel` never imports `electron`, never touches the filesystem, keychain, network sockets or child processes directly. Everything goes through the `HostAdapter` interface. A lint rule enforces the import ban; do not disable it. （由 lint 的 no-restricted-imports、import/no-nodejs-modules、no-restricted-globals 与 no-restricted-properties 守）
- The main process owns every privileged capability. The renderer never touches Node. `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` for every window, including MCP App iframes' host windows. （renderer 不碰 Node 由 lint 守；特权归属与窗口三项设置没自动化，靠评审）
- IPC and the desktop↔server bridge go through `packages/contracts` only (schema-validated). No ad-hoc `ipcMain.handle`. （没自动化，靠评审）
- MCP tool annotations (`readOnlyHint`, `destructiveHint`, descriptions) are untrusted input. Never use them to weaken a permission check. Tool results are untrusted content. （注解不放宽权限由权限决策测试守；其余没自动化，靠评审）
- Every subprocess is spawned through the sandbox wrapper (`HostAdapter.process` + `HostAdapter.sandbox`). Pass absolute paths only. （kernel 侧由 lint 守；desktop 侧与绝对路径要求没自动化，靠评审）
- Every storage key carries `tenantId`. Tape entries are append-only; corrections, compaction and handoff are new entries, never in-place edits. （Tape 表结构由 tape:check 守；其余没自动化，靠评审）
- Permission decisions follow the decision table in `docs/architecture/02-agent-loop/spec.md` (「权限决策顺序」；连同页头 Changed by / Amended by 指到这一节的后续 spec 一起看): policy and the user may loosen, machines (inspectors) may only tighten; when policy and the user disagree, the stricter one wins. （由 02 的权限决策测试守）
- Secrets never enter the repo or logs. `.env` is gitignored; API keys live in the OS keychain via `HostAdapter.secrets`. （.env 由 .gitignore 挡；其余没自动化，靠评审）
- No code from AGPL or proprietary sources. Copied Apache-2.0 code keeps its header and is listed in `NOTICE`. （逆向得来的标识符由 source-gate 测试守；许可证没自动化，靠评审）

## Development

- Package manager: pnpm 10. Node >= 22.12 (the floor of vitest 5, Electron 44, commitlint 21 and sandbox-runtime 0.0.79; corrected 2026-10-09, spec 04). `.nvmrc` pins the version CI uses.
- Layout: `packages/kernel` (agent loop, provider, tape, permission broker, MCP host), `packages/contracts` (zod schemas for IPC/bridge), `apps/desktop` (Electron host), `apps/server` (multi-tenant cloud host, later phases), `examples/plugins`.
- Before handoff run format, lint, typecheck and the smallest relevant test suite, plus `python3 .sdd/spec-check.py` before saying the work is done. The shared gate is lefthook plus CI: pre-commit first runs `python3 .sdd/spec-check.py --staged`, then format, lint and typecheck through `spec-check.py --run`; commit-msg runs commitlint. These apply to every agent and human. Claude Code's `.claude/settings.json` hooks are an extra layer. Never bypass hooks (`--no-verify`).
- Tests are regression protection, not scaffolding. Commit only durable tests for user-visible behavior, documented contracts, persistence/migration, concurrency, recovery and security boundaries.
- Prefer the smallest correct change; add no abstraction or dependency without a real need.
- Preserve unrelated worktree changes; never run destructive git (`reset --hard`, `push --force`, branch deletion) unless explicitly asked.
- When launching Electron from an agent shell, use `env -u ELECTRON_RUN_AS_NODE`.
- While the owner is using this Mac, run Electron e2e in CI or under xvfb in a Lima VM; launch it locally only when the owner asks.
- Always pass `--maxWorkers=2` to Vitest; run at most one Electron instance at a time.
- Tell the owner before reading the keychain (macOS may prompt). Read a live key only for the command that uses it; never put it in `.env.local`, shell profiles or logs.
- In a new worktree, run `pnpm install --frozen-lockfile && pnpm build` before tsc.
- Batch pushes to a PR branch: each push cancels its previous e2e run.

## Working with more than one agent

Claude Code is the primary developer of this repository; Codex is optional and, when used, gets self-contained tasks from Claude Code. No agent remembers another's session, so everything that matters lives in files:

- Before you stop — for any reason — update `plan.md`: mark what is done, what is half-done (and in what state the code was left), and what the next step is. A session that ends without updating `plan.md` is a failed session.
- Leave the worktree either committed or with a clean, described diff. Never leave failing builds, temporary probes or debug prints for the next agent to discover.
- One agent per worktree at a time. For parallel work use `git worktree add` on separate branches; never run two agents against the same checkout.
- Read `plan.md` and `git log -5` before touching anything; do not redo steps already marked done, and do not silently change a decision recorded in the spec.
- If you disagree with the spec or the previous agent's work, write it down in `plan.md` under "Open" and stop; do not fork the architecture.

## Git

- Conventional Commits: `type(scope): subject`, subject <= 50 chars. Never add AI co-author trailers.
- Routine PRs target `dev`; only release branches target `main`.
- Auto-merge is on for this repository; `dev` and `main` require the `ci-ok` check, which passes only when `ci`, `e2e`, `sandbox-macos` and `spec-check` all succeed. Only the reviewer enables it (`gh pr merge <PR> --auto --merge`) once the review is done, never the PR's author on its own PR. GitHub then merges when `ci-ok` is green. If more commits land after that, disable it (`gh pr merge <PR> --disable-auto`) until they are reviewed. Never enable it on a PR that touches gate files (`.github/workflows/**`, `lefthook.yml`, `.sdd/config.json`, `.sdd/spec-check.py`, `.claude/settings.json` or test runner configuration), or `apps/desktop/oauth/**` (merging to `dev` publishes the CIMD document to Pages); those merge only when the owner says so. The Pages publishing workflow `.github/workflows/pages.yml` is covered by the same rule.
- For UI changes include a concise BEFORE/AFTER description in the PR.

## Style

- TypeScript strict. ESM only. Single quotes, no semicolons, 100 columns (oxfmt).
- User-facing copy goes through i18n; default locales `zh-CN` and `en`.
- Interface text uses the sans font token, assistant prose uses the serif token — keep that distinction.

Specs 00–04 and specs whose status changed before this adoption keep their original records; existing noncompliance is registered in `.sdd/config.json` under `known`.
