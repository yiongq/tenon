# 00 · 地基 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计。

- [ ] 1. `pnpm init` monorepo：`pnpm-workspace.yaml`、`tsconfig.base.json`、oxlint / oxfmt 配置、`.editorconfig`、commitlint、**lefthook**（pre-commit: format + lint + typecheck；commit-msg: commitlint）
- [ ] 2. 建 `packages/kernel`、`packages/contracts`、`apps/desktop` 三个包，空实现能 build
- [ ] 3. lint 规则：`packages/kernel` 禁 `electron` / `node:fs` / `node:child_process` / `keytar` import；包边界规则 `apps → contracts → kernel`
- [ ] 4. `HostAdapter` 接口按 spec 落到 `packages/kernel/src/host/`；`keyFor(identity, ...parts)`；内存版假实现（测试用）
- [ ] 5. `DesktopHostAdapter`：fs / secrets（keychain）/ process（spawn + 进程树 kill）/ sandbox（passthrough + 日志）/ confirm（投递到 IPC 事件）/ clock
- [ ] 6. kernel：最小 MCP host——用 `@modelcontextprotocol/client@2.0.0` + `HostProcess.spawn` 连 `server-everything`，`tools/list`，调 `echo`；对应验收 3 的测试
- [ ] 7. `packages/contracts`：`registerRoute` + 第一批 IPC schema（发送消息 / 流事件 / 停止 / 读写 config）；验收 6 的测试
- [ ] 8. Electron 壳：窗口 webPreferences 按 spec；preload 只暴露 contracts 通道；profile 目录布局
- [ ] 9. 最小 Anthropic 流式调用（不抽象），`AbortSignal` 贯穿到 fetch
- [ ] 10. UI：令牌（键名按 §8.5，值按 §8.1）、基础组件、壳层、Composer 最小态、消息流（block 注册表 + `text`）
  - [ ] 10.1 `apps/desktop/src/i18n/`：i18next + i18next-icu，主进程与 renderer 各一个实例共用 `locales/zh-CN`、`locales/en`；系统语言解析 + `config.json` `locale` 覆盖；IPC 事件 `config.locale`；账号菜单「语言」项
  - [ ] 10.2 `pnpm i18n:check`（两份目录键集一致）挂进 `pnpm lint`；JSX 字面量文案 lint
  - [ ] 10.3 字体令牌两套值：界面无衬线、正文衬线，CJK 回落系统无衬线；zh-CN 下「谁在说话」由正文 16/28 vs 界面 14/20 承担；`<html lang>` 跟界面语言
  - [ ] 10.4 Composer：IME 组合中 Enter 不发送；时间 / 数字 / 排序全走 Intl
  - [ ] 10.5 Playwright：`zh-CN` / `en` 双语言壳层截图 + 无换行断言（验收 12）
  - [ ] 10.6 界面 → shadcn/ui 组件映射表 `docs/ux/component-map.md`：按 `../tenon-uxkit/interactions.md` 的界面清单逐条对应（§8.5 要求，只写组件名不抄 class）
  - [ ] 10.7 令牌值替换表 `docs/ux/tokens.md`：键名按 §8.5 分层，值为 Tenon 自己的临时皮肤，不含任何 uxkit 值（§8.5 要求）
- [ ] 11. `.claude/settings.json`：Stop hook 跑 `pnpm lint && pnpm typecheck`（Claude Code 专属的附加层；共享门禁是第 1 步的 lefthook）
- [ ] 12. `.github/workflows/ci.yml`：PR 触发 install / build / lint / typecheck / test
- [x] 13. 仓库设置：secret scanning + push protection、`main` 分支保护（2026-09-17 转公开后完成：两项扫描已启用；`main` 要求经 PR 合并、禁 force push 与删除；CI 建好后再加 required status checks）
- [ ] 14. 对照 spec 当前全部验收标准逐条验证并记录结果
- [ ] 15. 清理临时探针与测试
- [ ] 16. spec 顶部改 `Status: implemented`

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
- 许可证维持 Apache-2.0（LICENSE / NOTICE 自首个 commit 起存在）；盈利模式与 CLA 的决定见 master-reference §7 之后的 owner 讨论，未定之前不接受外部代码贡献。
