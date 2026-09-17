# 00 · 地基 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计。

- [x] 1. `pnpm init` monorepo：`pnpm-workspace.yaml`、`tsconfig.base.json`、oxlint / oxfmt 配置、`.editorconfig`、commitlint、**lefthook**（pre-commit: format + lint + typecheck；commit-msg: commitlint）
- [x] 2. 建 `packages/kernel`、`packages/contracts`、`apps/desktop` 三个包，空实现能 build
- [x] 3. lint 规则：`packages/kernel` 禁 `electron` / `node:fs` / `node:child_process` / `keytar` import；包边界规则 `apps → contracts → kernel`
- [x] 4. `HostAdapter` 接口按 spec 落到 `packages/kernel/src/host/`；`keyFor(identity, ...parts)`；内存版假实现（测试用）
- [x] 5. `DesktopHostAdapter`：fs / secrets（keychain）/ process（spawn + 进程树 kill）/ sandbox（passthrough + 日志）/ confirm（投递到 IPC 事件）/ clock
- [x] 6. kernel：最小 MCP host——用 `@modelcontextprotocol/client@2.0.0` + `HostProcess.spawn` 连 `server-everything`，`tools/list`，调 `echo`；对应验收 3 的测试
- [x] 7. `packages/contracts`：`registerRoute` + 第一批 IPC schema（发送消息 / 流事件 / 停止 / 读写 config）；验收 6 的测试
- [x] 8. Electron 壳：窗口 webPreferences 按 spec；preload 只暴露 contracts 通道；profile 目录布局
- [x] 9. 最小 Anthropic 流式调用（不抽象），`AbortSignal` 贯穿到 fetch
- [x] 10. UI：令牌（键名按 §8.5，值按 §8.1）、基础组件、壳层、Composer 最小态、消息流（block 注册表 + `text`）
  - [x] 10.1 `apps/desktop/src/i18n/`：i18next + i18next-icu，主进程与 renderer 各一个实例共用 `locales/zh-CN`、`locales/en`；系统语言解析 + `config.json` `locale` 覆盖；IPC 事件 `config.locale`；账号菜单「语言」项
  - [x] 10.2 `pnpm i18n:check`（两份目录键集一致）挂进 `pnpm lint`；JSX 字面量文案 lint
  - [x] 10.3 字体令牌两套值：界面无衬线、正文衬线，CJK 回落系统无衬线；zh-CN 下「谁在说话」由正文 16/28 vs 界面 14/20 承担；`<html lang>` 跟界面语言
  - [x] 10.4 Composer：IME 组合中 Enter 不发送；时间 / 数字 / 排序全走 Intl
  - [x] 10.5 Playwright：`zh-CN` / `en` 双语言壳层截图 + 无换行断言（验收 12）
  - [x] 10.6 界面 → shadcn/ui 组件映射表 `docs/ux/components.md`：按 `../tenon-uxkit/interactions.md` 的界面清单逐条对应（§8.5 要求，只写组件名不抄 class）
  - [x] 10.7 令牌值替换表 `docs/ux/tokens.md`：键名按 §8.5 分层，值为 Tenon 自己的临时皮肤，不含任何 uxkit 值（§8.5 要求）
- [x] 11. `.claude/settings.json`：Stop hook 跑 `pnpm lint && pnpm typecheck`（Claude Code 专属的附加层；共享门禁是第 1 步的 lefthook）
- [x] 12. `.github/workflows/ci.yml`：PR 触发 install / build / lint / typecheck / test
- [x] 13. 仓库设置：secret scanning + push protection、`main` 分支保护（2026-09-17 转公开后完成：两项扫描已启用；`main` 要求经 PR 合并、禁 force push 与删除；CI 建好后再加 required status checks）
- [x] 14. 对照 spec 当前全部验收标准逐条验证并记录结果
- [x] 15. 清理临时探针与测试
- [x] 16. spec 顶部改 `Status: implemented`

## 交接（2026-09-12）

- 已完成：`.claude/settings.json` 设置 `includeCoAuthoredBy: false`；仓库保持 private，默认分支保持 `main`；已填写描述和 `electron`、`mcp`、`agent`、`typescript` topics。
- 本次交接提交包含 UX 规格边界、共享门禁和多 agent 交接规则；提交后推送 `main`，从同一提交创建并推送 `dev`，本地回到 `main`。日常 PR 目标为 `dev`。
- 第 13 步未完成：GitHub API 对私有仓库的分支保护返回 403，要求升级 GitHub Pro 或公开仓库；Secret scanning 启用返回 422（此仓库不可用）；单独请求启用 Push protection 后返回状态仍为 disabled。按用户要求保持私有，不更改套餐。
- 下一步：从第 1 步搭建 monorepo、commitlint 和 lefthook，再按计划推进；pnpm 检查脚本、CI、Claude Stop hook 当前尚未落地。本次仅检查文档 diff 和配置，未运行不存在的构建或测试脚本。

## UX 补录交接（2026-09-13）

- 用户要求在私有 `../tenon-uxkit/` 补录真实 Claude 操作，随后明确要求连续视频，后续再抽帧；未修改产品代码、未复制 uxkit 素材入库。
- 已检查 uxkit 的 README、interactions 与已有审计；Claude 当前为 Scheduled tasks 列表，可通过原生 UI 操作。已创建 uxkit 的 `recordings/2026-09-13/` 输出目录，尚无成功录制的视频。
- 阻塞：系统录屏快捷键未打开控制栏；`com.apple.screencaptureui` 启动失败（Launchd job spawn failed）；QuickTime 的 File → New Screen Recording 明确为 disabled。不能把离散截图冒充连续视频。
- 下一步：恢复可用录屏入口并验证视频开始后，依次录制 Cowork 首页/选文件夹/发送/审批批准/继续完成与 Progress；三题反问（选择/跳过/输入）及收起恢复；中途停止与续接；Research 到完成及来源；产物卡/查看器/下载/分享层；定时任务详情和历史运行；侧栏折叠/展开/悬停及 ⌘K 搜索。补充面板关闭重开、空搜索与 Esc 退出，记录各段时间点。
- 本次未执行任何真实任务发送、审批、发布或修改既有定时任务。保留原有未跟踪的 UX 审计文件。仅文档交接，无可运行的构建/测试脚本变更。

## UX 视频补录完成交接（2026-09-13）

- 录屏阻塞已解除：用户明确允许命令行录屏；使用已安装 ffmpeg，在沙箱外录制屏幕，无音频。
- 已交付私有 uxkit 的 `recordings/2026-09-13/`：`01-cowork.mp4`（10:06.2）、`02-stop-research-artifact.mp4`（13:54.6）、`03-scheduled-sidebar.mp4`（04:47.1），总计 28:47.9；另有 README 覆盖清单、index.html 播放目录、manifest.json、下载演示表格。
- 已覆盖：Cowork 首页/选择演示文件夹/发送、三题反问（选择/跳过/自由输入）及收起恢复、Progress 全过程、原生 Deny/Allow 卡及用户明确批准后的续跑完成；停止与新消息续接；Research 初始化/连接器确认/运行/201 sources·3m38s 完成/来源面板；XLSX 内联卡/查看器/图表/全宽/下载菜单/保存对话框；普通分享层与 Research 禁用分享态；定时任务详情/History 运行；侧栏折叠/悬停/展开、⌘K 命中/空态/Esc。
- 审批使用专用演示目录的删除能力请求。第一次 Allow 被自动审核拦截，用户随后明确授权后通过；只写入完成标记，没有执行删除，没有实际发布或发送消息，也没有改动既有定时任务。
- 限制及下一步：来源点击与引用预览已录，但原生外链未成功切到外部浏览器，不能算外部来源网页已验证；Deny 后的状态未录。后续先补这两个分支，再按 uxkit README 对视频抽帧。本次不把私有原素材复制进产品仓库。
- 校验：三段 MP4 全片 ffmpeg 解码通过（无错误），3024×1964、15 fps、H.264；代表帧人工检查通过；XLSX ZIP 完整性通过；git diff --check 通过。无产品代码改动，无需运行尚未建立的 format/lint/typecheck。
- 当前仓库 diff 仅本 plan.md 的交接增补；保留原有未跟踪 `docs/ux/parity-audit-2026-09-12.md`。没有提交或推送。所有本次录屏进程均已正常停止。

## UX 场景缺口复核（2026-09-13）

- 对照现有 UX 审计、9 月 13 日简化决定、主参考范围与视频覆盖清单，完成只读缺口分析；本轮没有继续操作 Claude 或更改产品决策。
- 下一轮建议优先核验：拒绝审批及再次申请、已记住授权的撤销；工具执行/部分写入/待反问时停止；关闭重开后的任务恢复；切换任务后的后台运行与未读提醒；编辑/重试/版本切换；产物二次修改与旧文件关系；项目上下文全链路；MCP 连接/工具失败后的恢复。部分场景旧素材有静态画面，但缺连续状态转换证据，不应统称全无素材。
- Tenon 专有的一键还原、完成结算、从标题菜单查看本次记录，以及多 provider 密钥/错误体验，需要自己的后续 UX spec 与实现验收，不能靠 Claude 补录替代。
- 当前 UX 审计将 Research、语音、Drive 打开等列 C；保留本轮已录参考，但后续不应把 Research 外部来源跳转排在权限/文件/恢复之前。此为录制优先级建议，不改变现有范围。

## UX 第二轮补录交接（2026-09-13）

- 用户“开工”后已完成下一轮五组重点补录，保存在私有 uxkit `recordings/2026-09-13/round-2/`：04-deny-recovery（03:23.3）、05-tool-stop-background（04:11.2）、06-artifact-revision（02:39.1），合计 10:13.6。新增 README、manifest、播放索引及下载第二版表格；总目录与 interactions 已链接补充。
- 已验证：首页 Active/Review 原生审批弹层、Deny 结束当前轮并保留未完成进度、新消息续跑；实际命令等待中停止与磁盘只读核验；后台完成未读点/回访清除；反问 2/3 时关闭窗口并重新打开，题号和第一题选择保留；反问停止后三题 Failed；第二版表格请求、新旧卡/查看器/汇总/图表切换和下载。
- 关键实测：Stop 后 UI 恢复输入，但 60 秒延迟命令仍写出结束标记。即时磁盘只有 before，期限后 before/after 均存在；Claude 随后只读核验确认。实现原因未查明，不将模型的回执通道推测视为事实。
- 限制：仅关闭窗口，未退出应用/杀进程/重启；仅应用内未读，未验证系统通知；产物明确新文件名，不证明同名版本历史/回滚。第二版在后台生成，非全程可见。其余项目上下文/授权撤销/连接器恢复/定时任务编辑等仍按私有覆盖清单待补；下一步先为已有视频抽帧与建立时间码，再补剩余边界。
- 质量：3 段全片 ffmpeg 解码通过，3024×1964、15 fps、H.264；代表帧检查通过；新版 XLSX ZIP 完整性通过。全部录屏进程正常退出。本轮未删除文件、未批准新的删除权限、未分享或改既有定时任务。
- 未修改产品代码或架构决策，未复制私有原素材入仓库。保留原有未跟踪 UX audit；仓库仅 plan.md 交接增补，未提交或推送。

## 侧栏覆盖复核（2026-09-13）

- 用户询问侧栏是否全部覆盖；对照两轮视频 README 并只读查看当前原生菜单，确认尚未全覆盖。本次菜单检查没有录屏，不计为新增视频证据。
- 当前普通 Chat 更多菜单实测为 Open in new window / Pin / Rename / Add to project / Move to group / Delete；筛选菜单为 Type / Status / Last activity / Group by / Sort by。尚缺这些操作的完整状态转换视频，以及侧栏宽度拖动、分区折叠、View all、项目/产物/Customize 等入口全流程。
- 已有连续证据主要为侧栏折叠/悬停/展开、搜索命中/空态/键盘退出、切换任务及运行/待答/待审批/未读状态、Scheduled 定义及历史运行。下一步侧栏专项按菜单→子菜单→操作结果→返回状态逐项补录，使用演示任务避免操作真实任务。
- 无产品修改；仅追加本 plan 复核交接，保留未跟踪 UX audit。

## 仓库公开（2026-09-17）

- 仓库已转公开（owner 决定）。第 13 步随之完成，见上。日常 PR 进 `dev`，`main` 只收发布分支。
- 许可证、CLA、商业模式边界已定，见 [ADR-002](../../adr/adr-002-license-and-business-model.md)。CLA 文本与 cla-assistant 在第一个外部 PR 出现前完成；在此之前外部 PR 只审不合。

## 第 1–4、7、11、12 步完成交接（2026-09-17，Claude Code）

- 分支 `feat/foundation-monorepo`（自 `dev`），PR 目标 `dev`。`pnpm install && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全绿；`pnpm test:e2e`（Playwright 起 Electron）本机通过。负向验证已做：kernel 任意文件 `import 'electron'` → `eslint(no-restricted-imports)`；kernel `src/**` 里 `node:fs` / `document` / `@tenon-app/contracts` 各自被拦；删 `locales/en` 键 → `i18n:check` 点名缺键；类型错误、坏 commit message、未格式化文件各自失败。
- **工具链（全部实测后定，版本精确钉死）**：TypeScript 7.0.2（原生编译器；无 tsserver，编辑器需支持 TS7 的 LSP）、oxlint 1.83.0、oxfmt 0.68.0、lefthook 2.1.14、commitlint 21.2.2、vitest 5.0.1、**vite 7.3.6**（electron-vite 5.0.0 只接受 vite ≤7，`@vitejs/plugin-react` 因此钉 5.2.0；升 vite 8 必须同时升 electron-vite）、electron 44.4.1（内嵌 Node 24.21 / Chrome 152；electron-vite 5 的版本表止于 39，所以 `electron.vite.config.ts` 显式写 `node24` / `chrome152`）、zod 4.6.5、react 19.3.0。共享版本走 `pnpm-workspace.yaml` 的 `catalog:`。
- **pnpm 10 构建脚本策略**：`strictDepBuilds: true`、`onlyBuiltDependencies: []`、`ignoredBuiltDependencies: [esbuild, lefthook]`——全仓只有这两个包带 postinstall，且都不需要真的跑（esbuild 平台二进制是 optionalDependencies；lefthook 的 postinstall 在 pnpm 缓存下只对第一个仓库生效，所以 hooks 由根 `prepare` 脚本装，带 git 目录守卫）。electron 44 没有 postinstall，二进制由 `apps/desktop` 自己的 `postinstall: install-electron` 拉取；CI 的 `ci` job 用 `--ignore-scripts` 跳过下载，`e2e` job 缓存 `~/.cache/electron`。新增带 postinstall 的依赖会让 install 硬失败，需审后加进列表并 `rm -f node_modules/.modules.yaml && pnpm install`。`pnpm-workspace.yaml` 不要写注释（pnpm 一改写就清空并重排键）。
- **TypeScript 布局**：根 `tsconfig.json` 是 solution，引用 kernel / kernel.test / contracts / contracts.test / desktop（node / web / e2e 三个子工程）；`pnpm typecheck` = `tsc -b`，**引用列表就是整个 typecheck 门禁**，漏一条会静默变绿。kernel / contracts 用 `lib: [es2024, dom]` + `types: []`——dom 只为 Web Streams / TextEncoder 类型，DOM 全局由 oxlint `no-restricted-globals` 拦；kernel 与 contracts 的 `src/**` 还禁 `import/no-nodejs-modules`、`setTimeout` / `fetch` 全局。包 `exports` 的 `development` 条件必须排第一：vitest 与 `electron-vite dev` 据此直接读 `src/`，`vite build` 与 tsc 读 `dist/`（所以 `pnpm build` 按拓扑顺序先建 kernel / contracts）。`erasableSyntaxOnly` 开着：不能用构造器参数属性。
- **oxlint**：只有根 `.oxlintrc.json`，所有脚本带 `--disable-nested-config`（嵌套配置会整段替换根配置，边界规则就没了；CI 还有一步禁止嵌套 `.oxlintrc.json` / `.oxfmtrc.json` / `.editorconfig`）。`react/react-in-jsx-scope: off` 是因为开了 `suspicious` 类别，两者绑定。没开 `--type-aware`（要多装 oxlint-tsgolint，阶段 0 不值）。
- **oxfmt**：`**/*.md` 不格式化（docs 由 owner 在 Claude Desktop 里写，避免 churn），`pnpm-lock.yaml` 排除；未知配置键会被静默忽略，改 `.oxfmtrc.json` 后要拿文件验一下。
- **lefthook / commitlint**：pre-commit 跑整仓 `format:check` → `lint`（含 `i18n:check`）→ `typecheck`；commit-msg 跑 commitlint：`header-max-length: 50`（整行 `type(scope): subject` ≤ 50，按 master-reference §13 的写法）+ 自定义规则 `no-ai-coauthor`（拦 Co-Authored-By 含 claude / codex / anthropic / openai / copilot / cursor / gemini；故意不含 `\bai\b`，会误伤人名）。`LEFTHOOK=0` 可绕过；CI 显式设置。
- **kernel（第 4 步）**：`src/host/adapter.ts` 接口按 spec 逐字，另有 `CONFIRM_FACT_KEYS`；`keyFor(identity, ...parts)` = `<tenantId>:<part>:...`（拒绝空 tenantId、tenantId 含 `:`、空 part）；`profileDirFor(root, userId, tenantId)` = `<root>/profiles/<userId>/<tenantId>`，id 限 `[A-Za-z0-9][A-Za-z0-9._-]*`；`createMemoryHost()` 是纯内存 fake（fs 要求父目录存在、secrets Map、sandbox 直通并记 `sandbox: passthrough` 日志、confirm 只记录、clock 手动推进），`process.spawn` 默认抛错，验收 3 的测试要注入一个基于 node 的 `HostProcess`（放 `packages/kernel/test/support/`，kernel 的 `test/**` 允许 node 内置模块，仍禁 electron）。
- **contracts（第 7 步）**：`defineRoute` / `defineEvent`；`registerRoute(ipcMainLike, route, handler)` 请求、响应双向校验，listener 永不抛错，返回 `{ ok, data } | { ok: false, error: { code: 'invalid-request' | 'invalid-response' | 'handler-failed', issues? } }`；`invokeRoute` 是 renderer 侧对应物。首批通道：`chat.send` / `chat.stop` / `chat.event`（`text-delta` / `done` / `error`，错误只给代码）/ `config.get` / `config.set` / `config.locale` / `confirm.request`；`confirmRequestSchema` 按 `reason` × `kind` 校验必填 `facts`，空串算未填。
- **desktop 已落**：electron-vite 骨架（main ESM、preload 强制 CJS——sandbox 下 `.mjs` preload 加载不了、renderer React 19）；`BrowserWindow` 按 spec 三项 webPreferences；工作区包打进 main / preload（`externalizeDepsPlugin({ exclude })`，打包后没有 node_modules）；`src/main/host/{fs,sandbox,clock,profile}.ts`；Playwright 冒烟测试；`src/i18n/locales/{en,zh-CN}/common.json` 占位。**未落**：`HostProcess`（第 5 步，实测结论：不能用 `Readable.toWeb`——消费方取消时会以未捕获异常打崩主进程，要自写 ~30 行 `readableToWeb`；`exited` 听 `exit` 不听 `close`；进程树 = `detached: true` + `process.kill(-pid)`，Windows 用 `taskkill /T /F`；`kill()` 只投递信号，升级 SIGTERM→SIGKILL 由 kernel 借 HostClock 做；stdin 的 WritableStream 在子进程正常退出时会带 AbortError，持 writer 的一方要 `void writer.closed.catch(() => {})`）、`HostSecrets`（选 `@napi-rs/keyring` 2.1.0：无构建脚本、N-API 预编译；只用 `AsyncEntry`，同步版会阻塞主进程 ~6s；`getPassword` 运行时返回 null 而非类型声明的 undefined，`?? null` 必须保留；**macOS 钥匙串 ACL 绑定创建条目的二进制**：开发版未签名 Electron 与 node 互读对方写的条目都会弹窗 / 被拒，正式版靠代码签名解决，`findCredentials` 会静默漏掉无权条目且每条阻塞 ~5s，不要拿它枚举）、`HostConfirm`（投递到 IPC 事件 `confirm.request`）、profile 目录接入 main、preload 只暴露 contracts 声明的通道（现在是通用 `invoke(channel)`，第 8 步要按 contracts 的路由表做 allowlist）。
- **MCP（第 6 步）实测结论**：`@modelcontextprotocol/client@2.0.0` 根入口不含任何 `node:` 导入（只有 `./stdio` 子路径用），kernel 可以直接依赖；`Transport` 接口与 `serializeMessage` / `deserializeMessage`（换行分帧）都从 client 包导出；自定义传输层用 `ChildHandle` 的 Web Streams 实现，spike 已跑通 `listTools` 非空 + `echo` 回显；server-everything 走 v1 协议，`Client.connect` 默认 legacy 协商模式即可（`auto` 会先探测，对会在未初始化时退出的服务器不安全）。启动方式：`argv = [process.execPath, <server-everything 的 bin 绝对路径>, 'stdio']`，pnpm 的 `.bin/*` 是 shell shim 不是软链，要通过 package.json 的 `bin` 字段解析真实文件。关闭顺序：先关 stdin（server-everything 收到 EOF 以 0 退出）→ 等宽限 → 再 SIGTERM。
- **i18n（第 10.1 步）实测结论**：i18next 26.4.2 + i18next-icu 2.4.4 + **显式 intl-messageformat 11.2.15**（icu 无 runtime 依赖、按裸名导入，不显式钉会被 pnpm 自动装未钉版本）+ react-i18next 17.0.14；两个进程各 `createInstance()`，renderer 保留 `<I18nextProvider>`（`initReactI18next` 是进程级全局 setter，第二个实例会静默抢走无 provider 的 `useTranslation`）；renderer 用 `import.meta.glob('.../locales/*/*.json', { eager: true, import: 'default' })`，`import: 'default'` 是正确性要求；`new ICU({ memoize: true, parseErrorHandler })` 必须配 handler，否则 ICU 解析错误静默渲染原文；ICU 变量名不能叫 `ns` / `lng` / `lngs`；locale 解析按主子标签 `/^([A-Za-z]{2,3})(?:[-_]|$)/`（`\b` 会漏 `zh_CN`）；`escapeValue` 在 ICU 下无效，要转义得给插件 `escapeVariables: true`。`scripts/i18n-check.mjs` 已就位（`--strict-args` 可加查 ICU 参数漂移）。
- **第 9 步决定**：`HostAdapter` 没有网络成员，阶段 0 的 Anthropic 流式调用放 `apps/desktop` 主进程，不进 kernel；用官方 `@anthropic-ai/sdk`（0.126.0）而不是手写 fetch——`baseURL` 可配以满足「Anthropic-compatible endpoint」，`RequestOptions.signal` / `MessageStream.abort()` 已核实能贯穿到 fetch。Provider 层形状仍按 spec 留给阶段 1。
- **CI**：draft PR #8（`feat/foundation-monorepo` → `dev`）首跑全绿：`ci` 35s、`e2e` 45s（ubuntu-latest + xvfb 起 Electron，Playwright 冒烟含双语言菜单断言）、`ci-ok`。`ci-ok` 是将来 branch protection 要 require 的唯一 check（第 13 步的遗留项，合并本 PR 后在仓库设置里加）。actions 版本（checkout@v7 / pnpm/action-setup@v6 / setup-node@v7 / cache@v6 / upload-artifact@v7）是 agent 实测查到的，如 PR 上报错先查这些。
- 第 5 / 6 / 8 / 9 步已落并提交（`9252736`、`ad8c221`）：desktop `host/{process,secrets,confirm,index}.ts`；kernel `mcp/{stdio-transport,connection}.ts`（stderr 必须排水，否则子进程会被堵死；close 时两路 reader 都 cancel，避免孙进程继承的管道拖住）；contracts `registry.ts`（`ROUTE_CHANNELS` / `EVENT_CHANNELS`），preload 只转发表内通道；main 装配 host、注册 `config.*` 与 `chat.*` 路由；`chat.ts` 用 `@anthropic-ai/sdk` 0.126.0，模型默认 `claude-opus-5`（`TENON_MODEL` 可覆盖），API key 先查钥匙串 `keyFor(identity,'provider','anthropic','apiKey')` 再回落 SDK 自己的环境变量；阶段 0 没有设置 UI，验收 4 靠 `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` 环境变量。
- 10.1 / 10.2 已落（`3554514`）：`apps/desktop/src/i18n/{resources,create-instance,resolve-locale}.ts` + `locales/{en,zh-CN}/{common,menu}.json`（静态打包进两个进程，各自 `createInstance()`）；主进程 `locale.ts` 解析一次并广播 `config.locale`，`menu.ts` 按目录重建应用菜单，窗口标题同步；renderer 通过 `additionalArguments: --tenon-locale=` 在首帧前拿到语言，再跟随事件；`TENON_LOCALE` 环境变量可覆盖系统语言（测试用）。oxlint renderer 覆盖里开了 `react/jsx-no-literals`。
- 已验证的验收（2026-09-17）：1（干净 clone 到草稿目录，五条命令全过，hooks 随 install 装上）、2、3、4 的机制（本机没有 Anthropic 凭据，用 `test/support/fake-anthropic.ts` 假 SSE 端点：流式增量、`chat.stop` 后服务端看到连接关闭、401 → `auth` 代码；真实端点需 owner 设 `ANTHROPIC_API_KEY`）、5、6、7（lefthook 与 commitlint 都实际拦过提交）、8（尚需最终 `git log` 复核）、10；9 的语言解析与菜单/标题切换已由 e2e 覆盖，账号菜单切换与重启保持等壳层 UI 落地后补；11、12 等 Composer / 壳层。
- **第 10 步已落（`03fcb71`）**，UI 技术栈全部先在草稿目录实测再整合：
  - **shadcn CLI 4.21（Base UI 版）**：`init -b base -p nova`；依赖是 `@base-ui/react` 1.8.0（不是停在 rc 的 `@base-ui-components/react`）、`cn` 0.3.0（v4 起取代 clsx + tailwind-merge，组件直接 `import { cn } from 'cn'`）、`class-variance-authority`、`lucide-react`；devDeps `shadcn`（`theme.css` 要 `@import 'shadcn/tailwind.css'`）、`tw-animate-css`、`tailwindcss` / `@tailwindcss/vite` 4.3.3。生成的 14 个组件在 `apps/desktop/src/renderer/src/components/ui/`，已改成只走令牌（高度用 `ctl-h*` 工具类、无任意值颜色）；用 Base UI 的 `render` 属性，不是 Radix 的 `asChild`。再跑 CLI 要注意：它读**根** tsconfig 的 `paths`，读不到会把文件写进字面目录 `@/`。
  - **`shadcn/tailwind.css` 是承重的**：它把 `data-horizontal` / `data-vertical` 映射到 Base UI 实际写的 `[data-orientation=…]`；删掉它 Separator 高度变 0、滚动条变 2px（不是「动画没了」）。
  - **令牌**：`src/styles/tokens.css` 逐表誊抄 `docs/ux/tokens.md`（三块：`:root`、跟随系统的暗色、`[data-theme=dark]`，外加减动效）；`theme.css` 的 `@theme inline` 先 `--color-*: initial`（Tailwind 自带调色板类编译为零字节），再把 shadcn 语义名与 Tenon 键名都接到 `--t-*`；`--container-xs/sm` 也接管成 4px 单位的倍数；`ThemeProvider` 总是在 `<html>` 盖 `data-theme`（阶段 0 只跟随系统）。zh 下三档字重各降一档（CJK 同字重更显重），字族不换。
  - **Streamdown**：Tailwind 只扫源码树，必须 `@source '../../node_modules/streamdown/dist/*.js'`，否则 markdown 全无样式；它自带的 mermaid 错误 / 图片悬浮层用的是 Tailwind 调色板类，被 `--color-*: initial` 清掉了——阶段 0 只有文本，接受；`<Streamdown>` 会丢弃未知 props（testid 挂外层 div），className 里的任意字号要写 `text-[length:…]`。
  - **assistant-ui 0.15.20**：`useLocalRuntime` + 自写 `ChatModelAdapter`（`runtime/tenon-chat-adapter.ts`）：先订阅 `chat.event` 再 `chat.send`，按 sessionId 过滤，yield 累积文本，abort 时发 `chat.stop` 并本地关流；错误用带 `code` 的 `ChatStreamError`，`ThreadError` 经 `useAuiState` 读 `status.error.code` 再查目录（不用 `ErrorPrimitive.Message`，它会把 message 直接上屏）。块注册表 = `MessagePrimitive.Parts` 的 `components`：`Text` 一个真渲染器，其余槽位全指向可见占位（注册表是全的，未知块不会静默消失）；用户消息用 `PlainText`。`ComposerPrimitive.Input` 自己只拦 `isComposing`，`keyCode === 229` 靠 `guardImeEnter` 补。「新对话」= 换 sessionId 让 `ChatProvider` 重挂（主进程按 sessionId 记历史）。
  - **zod 与 CSP**：zod v4 会用 `new Function('')` 探测 JIT，在 `script-src 'self'` 下每次加载报一条 CSP 违规；`renderer/src/zod-csp.ts` 设 `jitless` 并在入口最先 import。e2e 断言违规数为 0。
  - **electron-vite 5**：`externalizeDepsPlugin` 已废弃，用 `build.externalizeDeps`；**preload 必须 `externalizeDeps: false`**——sandbox 下 preload 只能 `require('electron')`，任何外置依赖都会让 preload 整个加载失败（实测：把 zod 加进 dependencies 后界面全白）。main 保留外置但排除两个 workspace 包。
  - **lint 新增**：`scripts/check-colors.mjs`（`apps/desktop/src` 下除 `tokens.css` 外禁止颜色字面量与 Tailwind 调色板类）挂进 `pnpm lint`；`import/no-unassigned-import` 只放行 `*.css` 与 `zod-csp`。
  - **e2e（10 条，本机 + CI）**：`helpers/text-fit.ts` 的 `expectSingleLineUnclipped`（按文本宿主量行盒并按纵向重叠合并、逐轴找裁剪盒、跳过可滚动容器）；`helpers/launch.ts` 用 `--user-data-dir` 隔离 profile、`setContentSize` 定 1280×800（`page.setViewportSize` 对 Electron 无效且会把 DPR 压成 1）；`TENON_LOCALE` 现在是「系统语言列表」的种子（逗号分隔，仅未打包时生效，见 `main/preferred-languages.ts`），不是最终语言。截图基线只提交 darwin（`e2e/__screenshots__/darwin/`），其他平台把截图作为附件，门禁靠 DOM 断言。IME 用 CDP `Input.imeSetComposition` 驱动。
  - 10.4 的「时间 / 数字 / 排序走 Intl」：阶段 0 的界面还没有任何时间、数字或排序，无代码可落；规则留给出现相对时间的那一步。
  - 阶段 0 有意不放的入口：侧栏底部的搜索 / 设置、账号菜单里的「设置」——`components.md` 要求入口与功能同批出现。项目 / 产物 / 定时任务 / 技能与连接器四行是无动作的占位行，只为让双语言回归从第一天覆盖这些文案。
- **对抗性评审（2026-09-17）**：6 个维度各一名评审 + 一名专职反驳者，37 条发现里 23 条被复现确认、14 条被驳回；确认项全部修掉（`cec41f8`）。要点：窗口钉死在应用文档上（`will-navigate` / `will-frame-navigate` / webview / 权限请求一律拒绝——此前 renderer 一旦跳到远程源，远程页面会带着 preload 桥拿到整套 IPC）；`shell.openExternal` 只放行 http / https / mailto；`confirm.request` 事件不再携带 `redacted`；MCP server 的 spawn 先过 `HostSandbox.wrap`（`McpStdioServerSpec.sandbox` 必填）；`McpConnection.close()` 总是回收子进程，流坏掉时传输层自己收尸；聊天路由——stop 先于建流也能取消、被停止的那轮保留已出的部分回复、失败的那轮留在记录里且同文重发视为重试、缺密钥报 `auth`、先释放会话再发终止事件；错误态加重试钮、消息加读屏说话人标题、hover 过渡接到动效令牌；新增 `scripts/check-copy.mjs`（主进程原生 UI 字段与 renderer 文本属性必须走 `t()`）；AI co-author 检查挪到 lefthook 独立 job（commitlint 会整体跳过 merge / revert / fixup 消息）并在 CI 的 PR 范围内再查一遍；所有 e2e 用隔离 profile；placeholder 也纳入不截断度量。

## 第 14 步：验收记录（2026-09-17）

| # | 结果 | 证据 |
|---|---|---|
| 1 | 通过 | 干净 clone 到草稿目录：`pnpm install --frozen-lockfile && pnpm format:check && pnpm build && pnpm lint && pnpm typecheck && pnpm test` 全过；CI 同样 |
| 2 | 通过 | kernel 的 `src/` 与 `test/` 各放一个 `import 'electron'`：`pnpm lint` 失败并报 `eslint(no-restricted-imports)`；`node:fs`、`document`、`@tenon-app/contracts` 同样被拦 |
| 3 | 通过（措辞见 Open） | `packages/kernel/test/mcp/everything.test.ts`：内存 host + 注入的 node 版 `HostProcess`，经 `sandbox.wrap` → `process.spawn` 起 server-everything，协商成功、`tools/list` 非空、`echo` 回显、stdin EOF 后以 0 退出 |
| 4 | 机制通过，真实端点未跑 | 本机与 CI 都没有 Anthropic 凭据。`test/chat.test.ts` + `e2e/chat.spec.ts` 对本地 Anthropic 兼容 SSE 端点：流式渲染、点停止后服务端看到连接关闭、错误码本地化、重试、CSP 零违规 |
| 5 | 通过 | `apps/desktop/test/profile.test.ts`（真实临时目录）+ kernel 的内存版同款用例 |
| 6 | 通过 | `packages/contracts/test/route.test.ts`：畸形消息 → `{ ok:false, error:{ code:'invalid-request', issues } }`，handler 未被调用、不抛错；preload 另拒绝未声明通道（e2e） |
| 7 | 通过 | lefthook 实际拦过本分支的提交（格式、lint、标题超长、大写开头）；Stop hook 两条分支手测；CI 三个 job 三次全绿；secret scanning / push protection 见第 13 步 |
| 8 | 通过 | `git log origin/dev..HEAD` 无 co-author 尾注；`commitlint --from origin/dev --to HEAD` 0 problems |
| 9 | 通过 | e2e：全新 profile 按系统语言列表（`TENON_LOCALE` 种子，含 `fr-FR` 在前的回落）出中文 / 英文；账号菜单切换后 `<html lang>`、应用菜单、窗口标题即时变化，同一 profile 重启后保持。真实 OS 语言设置无法在测试里改，靠 `resolve-locale` 单测兜底 |
| 10 | 通过 | 清空 `locales/en/common.json`：`pnpm lint` 失败并点名 `common:app.name` |
| 11 | 通过 | e2e 用 CDP `Input.imeSetComposition` 驱动真实输入法状态：组合中 Enter 不发送，提交后 Enter 发送 |
| 12 | 通过 | e2e：1280×800、zh-CN 与 en，侧栏 5 个导航行、Composer 的 placeholder / 发送钮 / 免责行、账号行均单行不截断；darwin 截图基线已入库 |

第 15 步：仓库内无临时探针、无调试输出（`git ls-files` 与 `console.log` 检索为空）；研究与评审的探针都在会话草稿目录，未入库。

## Open

- 第 6 步的验收 3 写的是「完成 MCP v2 协议协商」，但 server-everything 2026.8.31 依赖 sdk ^1.30（v1 协议），只能观察到 v1 协商成功；spec 需在 owner 侧改措辞（记忆里 2026-09-12 评审已指出）。
- 第 5 步钥匙串：开发期未签名 Electron 每换一次二进制都可能触发 macOS 钥匙串弹窗（2026-09-17 owner 已见到研究 agent 的弹窗）；正式解决在阶段 7 签名，开发期先接受。
- `HostAdapter` 缺网络能力：阶段 1 定 provider 形状时一并决定是加 `HostAdapter.net` 还是 provider 以注入方式拿 fetch。
