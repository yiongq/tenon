# 呈现修订第一轮（presentation-r1）— 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计。「验收 N」指 spec §验收标准，「不变量 N」指 §不变量，「R N」指 §替换的条款，「开放问题 N」指 §开放问题。spec 现在是 `draft`：第 0b 步之前不写代码。

## 开工前读

- **前提**：spec 改 `ready`（第 0b 步）。开放问题 8 选 B 时跳过第 3 步的工具行部分；开放问题 1 选 B 或 C 时第 9 步按所选重写，选 B 要先补 spec 的契约（config.json 只增的记号）。
- **先后**：照开放问题 13 A，本计划整份在 04 第三段（04 plan 第 16–20 步）开工之前合入 `dev`；可以与 04 第一、二段并行（它们不碰 renderer）。若 04 第三段已先开工，停下在「Open」写明冲突的文件，等 owner 定。
- **谁来做**：owner 开工时定；没说就一个实现者、一个分支 `feat/presentation-r1`（从 `dev` 开）、一个 PR，每步一个提交；合并前 lead 独立审查：逐条读测试的实际断言、重跑突变、真进程抽查卡、菜单与输入框。
- **命令**（仓库根）：
  - U = `env -u ELECTRON_RUN_AS_NODE pnpm vitest run --maxWorkers=2 <文件…>`
  - G = `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test --maxWorkers=2`
  - E = `pnpm build`，再在 `apps/desktop` 下 `env -u ELECTRON_RUN_AS_NODE npx playwright test e2e/<文件> --trace off`
  - EA = `pnpm build && env -u ELECTRON_RUN_AS_NODE pnpm test:e2e`
- **机器约束**：vitest 一律 `--maxWorkers=2`；同一时刻最多一个 Electron。harness 里设了 `ELECTRON_RUN_AS_NODE`，跑 Electron 一律 `env -u`。
- **不碰**：`packages/contracts`、`packages/kernel`、提示层、任何 Tape 名字（不变量 4）。第 9 步只动 `apps/desktop/src/main/provider-routes.ts`。要动这些才做得下去，就是 spec 不够用：停下写进「Open」。
- **文案**：spec 给的是意思；定稿的中英文写进两份 locale，英文照意思写、句中小写。新键与改值都过 copy-coverage；键名在下面各步给出，实现时可调整，但要在实施记录里写最终键名。

## 步骤

- [x] 0a. 起草 spec 与本计划（2026-10-15，Claude Code）。只动 `docs/features/presentation-r1/`；旧 spec 与 components.md 不动（指针与头行在第 11 步，和代码同一个 PR）。
- [ ] 0b. owner 答开放问题 1–13 → 照选的改 spec（顶部 `Revisions:` 记日期、改了什么、旧的是什么）→ `Status: ready`。选了非推荐项的，先改 spec 的对应节与本计划的对应步，再开工。

- [ ] 1. 审批卡（R11、R12、R13、R23；验收 1、2、3）
  - 文件：`apps/desktop/src/renderer/src/components/thread/ApprovalCard.tsx`（去掉刻度那一组；③④ 两句；「允许（<期限>）」）；`lib/approval-card.ts`（新纯函数 `whyKey(card)`：按 reason、kind、target.type 选键，`irreversible` 仍按 kind 取 `confirm.reason.irreversible.<kind>`，值改成「这类操作每次都要你亲自同意。」；`undoKey(card)`：按 reversibility，只有 network+unknown 返回 null，`irreversible` 取原有的 `confirm.irreversible`「撤不回。」）；`lib/approval-keys.ts`（`scopeKey` 不变，加 `allowLabelKey`）；删 `lib/reversibility-scale.ts` 与 `mcp.reversibilityScale`、`mcp.reversibility.*` 里只给刻度用的键（工具行在第 3 步换掉后再删，别处还在读的留到那一步）；两份 locale：改 `confirm.reason.*` 的值（键名不动，04 第 18 步改的是 `confirm.reason.elevated` 的值），按 kind 细分的加 `confirm.reason.default.file`、`confirm.reason.default.tool`、`confirm.reason.network.search`、`confirm.reason.network.url`；加 `confirm.undo.<reversibility>`、`confirm.allowScoped`（「允许（{scope}）」）与 `confirm.scopeInline.*`（英文小写）。
  - 测试：`renderer-approval-card.test.ts`「presentation-r1 验收 1: no scale; why and undo follow the two tables for every reason, kind and reversibility」「…验收 1: no built-in tool name in either locale」「…验收 2: the why line repeats no part of the object line」（每种 target 一张卡，断言 ③ 不含对象的任何一段）「…验收 3: allow carries its scope, five scopes, each equal to the grant scope」；原有按键与焦点的用例一个不删（02 验收 36）；`copy-coverage.test.ts` 改「has the 「为什么停」 sentence…」：参数名取自必填键的子集，按新的 kind 细分计数；加「has an undo sentence for every reversibility」。e2e：`approval.spec.ts`、`write-card.spec.ts`、`connectors.spec.ts` 里断言刻度、`approval-scope` 位置的地方改成新结构；`text-fit-02.spec.ts`「step 22’s write and irreversible cards」与 `text-fit-03.spec.ts` 的卡改量新元素。
  - 命令：U `apps/desktop/test/renderer-approval-card.test.ts apps/desktop/test/renderer-approval-keys.test.ts apps/desktop/test/copy-coverage.test.ts`；E `approval.spec.ts write-card.spec.ts connectors.spec.ts text-fit-02.spec.ts text-fit-03.spec.ts`；G。
  - 突变：① 刻度那组放回 → 验收 1 红；② 某个 `confirm.reason.*` 值写回 `{toolName}` → 「no built-in tool name」红；③ 命令卡 ③ 写回 `{command}` → 验收 2 红；④ `undoKey` 对 `unknown` 返回 null → 验收 1 红；④′ 撤不回的卡不出「撤不回。」→ 验收 1 与不变量 3 红；⑤ 「允许」钮去掉期限 → 验收 3 红；⑥ 撤不回卡默认焦点改到「允许」→ 02 验收 36 的原用例红。
  - 完成：上列全绿；实施记录写最终键名与六个突变的红绿。

- [ ] 2. 答完与拒绝（R10、R14；验收 4）
  - 文件：`components/thread/ToolRow.tsx`（`AnsweredRow`：主会话卡不带对象行，拒绝写「已拒绝 · 这一轮到此为止」；被拒那一行不再出 `closure.user-rejected` 收口句；子任务卡照旧带对象）；`lib/end-card.ts`（`cardOf` 对 `user-rejected` 返回 null，穷举 switch 保留）；`components/thread/RunEndCard.tsx`；locale：`confirm.answered.allowed` 改成「已允许（{scope}）」、加 `confirm.answered.roundEnds`，`runEnd.user-rejected` 去掉 `{toolName}`。
  - 测试：`renderer-end-card.test.ts`「presentation-r1 验收 4: user-rejected shows no failure card」；`renderer-tool-row.test.ts`「…验收 4: an allowed main-session card collapses to one line without the object; a subtask card keeps it」「…: a denied card is the only feedback: no closure line」；e2e `approval.spec.ts`「…验收 4: deny leaves one line; later calls of the batch read 未执行; restart redraws the same line」，`subagent.spec.ts` 的子任务卡塌行。
  - 命令：U `apps/desktop/test/renderer-end-card.test.ts apps/desktop/test/renderer-tool-row.test.ts`；E `approval.spec.ts subagent.spec.ts run-end.spec.ts`；G。
  - 突变：① `cardOf('user-rejected')` 回中性卡 → 验收 4 红；② 主会话塌行带回对象行 → 红；③ 子任务塌行去掉对象 → 红；④ 收口句照出 → 「only feedback」红。

- [ ] 3. 拦截回执与工具行（R4、R6、R24；验收 5、6；开放问题 8、9）
  - 文件：`components/thread/ToolRow.tsx`（`BlockedNotice` 旧四码一行，不出 `blocked.told`；有 `sandbox` 成员的分支此时还不存在，留给 04 第 18 步；展开后那一行；标记只给 `irreversible`，加 Tooltip）；`lib/tool-row-effect.ts`；`lib/tool-sentence.ts`（连接器句：显示名与原名从 `runtime/mcp-store.ts` 的 `mcp.list` 数据对映射名，对不上退回映射名）；locale：改 `blocked.*` 的值、按 WebFetch 细分 `blocked.protected.fetch`；`tool.generic` 改为「使用 {server} 的 {tool}」并保留一个只有映射名的退路键；删 `mcp.effect`、`mcp.marker`、`mcp.effects.*`、`mcp.reversibility.*`（第 1 步留下的），加 `tool.did.*`。`blocked.told` 键：04 第 18 步的测试断言沙箱回执不渲染它，键留在目录里、不再被渲染。
  - 测试：`renderer-tool-row.test.ts`「presentation-r1 验收 5: each of the four block codes is one line without 已告诉模型 or a tool name」「…验收 6: the expanded line says what it did and whether it can be undone; none for a read」「…: only an irreversible row carries the marker, with its tooltip and screen-reader text」；`renderer-tool-sentence.test.ts`「…验收 6: a connector call names the connector and the tool’s own name; a deleted connector falls back to the mapped name」；`copy-coverage.test.ts` 的「block notice for each of the four block codes」改为参数名取自 `BLOCKED_FACT_KEYS` 的子集；03 验收 45 的原用例按 R25 改写（`renderer-tool-row.test.ts`、`connectors.spec.ts`）；`text-fit-03.spec.ts`「relogin and side-effect text」改量新的一行。
  - 命令：U `apps/desktop/test/renderer-tool-row.test.ts apps/desktop/test/renderer-tool-sentence.test.ts apps/desktop/test/copy-coverage.test.ts`；E `connectors.spec.ts tools.spec.ts text-fit-03.spec.ts`；G。
  - 突变：① 回执照渲染 `blocked.told` → 验收 5 红；② 标记条件放回「写或对外发送且不可逆或未知」→ 「only an irreversible row」红；③ 连接器句用映射名 → 验收 6 红；④ 只读调用也出那一行 → 红。

- [ ] 4. 结算行（R5；验收 7）
  - 文件：`runtime/thread-model.ts`（`TurnSummary` 改成六类计数；文件类按不同路径数；只算 `effect !== 'blocked'`；Agent 的子会话计数作为参数传入）；`runtime/session-store.ts`（对带 `handoff.childSessionId` 的 Agent 调用读一次子会话的 `session.messages`，按 id 缓存；子会话还在跑时随父会话的 `tool-outcome` 再读）；`runtime/to-thread-messages.ts`；`components/thread/RunEndCard.tsx` 的 `SummaryLine`；locale：`summary.line` 换成按类别的几个键加分隔符键。
  - 测试：`renderer-thread-model.test.ts`「presentation-r1 验收 7: counts by kind — Read a.txt ×3, Edit b.txt ×2, Bash ×2, WebFetch ×1, a subtask’s Write — reads 读了 1 个文件 · 改了 2 个文件 · 运行了 2 条命令 · 联网 1 次」「…: no zero part; a blocked or unsent call is not counted; Bash is never 对外发送」；`session-store.test.ts`「…: a subtask’s calls are read once and counted」；e2e `subagent.spec.ts` 加一条结算行断言；`copy-coverage.test.ts`「has the summary line…」改为六类。
  - 命令：U `apps/desktop/test/renderer-thread-model.test.ts apps/desktop/test/session-store.test.ts apps/desktop/test/copy-coverage.test.ts`；E `subagent.spec.ts run-end.spec.ts`；G。
  - 突变：① Bash 记进联网 → 验收 7 红；② 不读子会话 → 红；③ Read 按次数不按路径 → 「读了 1 个文件」红；④ 零项照写 → 「no zero part」红。

- [ ] 5. 失败卡（R9；验收 8；开放问题 10、12）
  - 文件：`components/thread/RunEndCard.tsx`（厂商名：读 `provider.list`，按 `nameKey` 或 `displayName`，读不到写「模型服务」；`provider-error` 按 `errorCode` 选句；所有结束卡 `w-full`；② 用聚合）；`lib/end-card.ts`（新纯函数 `providerErrorKey(errorCode)`、`aggregateDone(parts)`：按工具加完整对象分组、短名冲突时退回完整路径、保持先后、前 5 组）；阶段 1 错误态 `MessageError` 的 `auth` 加「去设置」；locale：`runEnd.provider-error.<errorCode>` 各一句，`runEnd.refusal` 等把 `{providerId}` 换成 `{provider}`，`error.auth` 改值。`slotsOf` 只把厂商名、模型名作为额外槽位加进去，其余槽位仍只取结束原因自己的字段。
  - 测试：`renderer-end-card.test.ts`「presentation-r1 验收 8: one sentence per errorCode; 401 and 400 differ」「…: aggregates 100 reads of a.txt into one line ×100; same name, different paths stay apart in full; over five groups the rest fold」；`end-reason-copy.test.ts` 改为按厂商名的槽位；`copy-coverage.test.ts`「has a sentence for every end code…」加 `errorCode` 的穷举（`covers<ProviderErrorCode>`）；e2e `run-end.spec.ts`「…验收 8: the cards span the content column; the provider is named, not its id」，`retry.spec.ts` 的 400 卡文案。
  - 命令：U `apps/desktop/test/renderer-end-card.test.ts apps/desktop/test/end-reason-copy.test.ts apps/desktop/test/copy-coverage.test.ts`；E `run-end.spec.ts retry.spec.ts`；G。
  - 突变：① `auth` 与 `invalid-request` 用同一句 → 「401 and 400 differ」红；② 句子写回 `{providerId}` → 红；③ 聚合按短名分组 → 「different paths stay apart」红；④ 去掉 `w-full` → 「span the content column」红。

- [ ] 6. 模型菜单（R15–R19、R26、R29；验收 9；开放问题 4）
  - 文件：`components/composer/ModelMenu.tsx`（第二行不带主机；地址不是默认值的内置行行内接主机；悬停与键盘高亮的提示、`aria-describedby`）；`lib/custom-vendor.ts` 的 `markLineKey`；新纯函数 `lib/data-flow.ts` 的 `rowHostInLine(entry)`（`configKeys` 里 `baseURL` 的 `default` 的主机与 `endpoint.host` 比）；locale：`model.mark.*` 去掉 `{host}`，回环与私网的 `local-text-only` 两句，`model.mark.probed` 改「探测通过 · 不保证」，加 `model.row.sendsTo`、`model.row.staysLocal`，`model.notConfigured` 改值。确认页 `model.confirm.*` 不动。
  - 测试：`copy-coverage.test.ts`「has the second line of each of the four row marks」改为不带 `host` 参数；`renderer-custom-vendor.test.ts` 的行文案；`renderer-data-flow.test.ts`「presentation-r1 验收 9: the host stays in the line only off the declared default」；e2e `model-menu.spec.ts`「…验收 9: no host in the rows; hover and keyboard highlight show 发往 <host>, the row’s description says the same; the confirmation still names the host and nothing is sent before it」（原「lists configured providers by host…」改写），`custom-vendor.spec.ts` 的实例行（M6 验收 20），`text-fit-02.spec.ts`「every model row’s purpose and host line fits」改为第二行与提示两处都量。
  - 命令：U `apps/desktop/test/copy-coverage.test.ts apps/desktop/test/renderer-custom-vendor.test.ts apps/desktop/test/renderer-data-flow.test.ts`；E `model-menu.spec.ts custom-vendor.spec.ts text-fit-02.spec.ts`；G。
  - 突变：① 主机放回第二行 → 验收 9 红；② 去掉 `aria-describedby` → 红；③ 键盘高亮不出提示 → 红；④ 确认页去掉主机 → 原有的 0 次请求用例仍绿、文案用例红（确认这条测的是文字不是请求）；⑤ 默认地址判断写反 → 「off the declared default」红。

- [ ] 7. 输入框：开关与文件夹 chip（R3、R7、R8；验收 10；开放问题 5）
  - 文件：新 `components/composer/FolderToggle.tsx`（`Switch`，只在 `facts.established === false` 时渲染，写 `session.selectProfile`）；`components/composer/ComposerLead.tsx`（开关 + chip）；`components/composer/FolderChip.tsx`（chip 与 Popover 浮层；添加、预填、移除仍调原来的三条 `workspace.*` 路由；名字放不下时改写「N 个文件夹」，用测宽而不是 CSS 省略）；`components/thread/Composer.tsx`（去掉框下的 `folder-slot`）；删 `components/composer/ModeSwitch.tsx`；locale：加 `folder.toggle`、`folder.count`、`folder.dedicatedNote`，`mode.*` 三个键只有 `ModeSwitch` 在用，随它删（copy-coverage 若列了它们一并改）。
  - 测试：e2e `composer-frame.spec.ts`「presentation-r1 验收 10: toggling 在文件夹里工作 moves neither the box nor the line under it (0 px)」；`composer.spec.ts`「…: no toggle after the first message; a task keeps its chip; selectProfile answers established」；`tools.spec.ts` 里选文件夹、预填、移除的用例改走浮层，断言「预填点了才进列表」与原来相同；`text-fit-02-rest.spec.ts`「the mode switch, folder chip and its prefill…」改量开关、chip 与浮层。
  - 命令：E `composer-frame.spec.ts composer.spec.ts tools.spec.ts text-fit-02-rest.spec.ts`；G。
  - 突变：① 开关打开时 chip 放到框下 → 「0 px」红；② 建立后照样渲染开关 → 红；③ 预填不点也进列表（改成挂载时自动调 `workspace.usePrefill`）→ tools.spec 的预填用例红；④ chip 名字用 CSS 省略 → 验收 13 的截断检查红（第 10 步）。

- [ ] 8. 输入框：发不了的原因（R20、R28；验收 11；开放问题 3）
  - 文件：`runtime/session-store.ts`（`sendBlock()` 加 `'noProvider' | 'modelUnusable' | 'modelRemoved'`，与 `restoring`、`textOnlyTask` 同一条路，⏎ 与 Cmd/Ctrl+Enter 都看它）；`components/composer/ModelMenu.tsx`（算可用性并交给 store，同 `setTextOnlyTask` 的做法；设置弹窗关上与窗口 `focus` 时重读）；`components/thread/Composer.tsx`（框下那一行加两个文字钮「改用 <X>」「去设置」）；locale 三句与两个钮。
  - 测试：`session-store.test.ts`「presentation-r1 验收 11: a block for no provider, an unusable choice and a removed instance; send and sendNow are called 0 times」；e2e `provider-settings.spec.ts`「…验收 11: with no key the send button is off and says why; 去设置 opens the pane」「…: a default on a provider without a key offers 改用 <X>, and after it the message goes」；`custom-vendor.spec.ts` 的删实例流程（M6 验收 25）改为：新消息在输入框说明已删除、不出失败卡；续跑那一半照旧出 `error.customVendorGone` 的失败卡。
  - 命令：U `apps/desktop/test/session-store.test.ts`；E `provider-settings.spec.ts custom-vendor.spec.ts queue.spec.ts`；G。
  - 突变：① `sendBlock` 不看可用性 → 验收 11 红；② Cmd/Ctrl+Enter 绕过 → 「sendNow 0 times」红；③ `provider.list` 读失败也禁用 → 加一条「读不到不禁用」的用例红；④ 「改用」挑了不能发工具的行给任务形态 → 红。另核 `queue.spec.ts` 的「自动发出碰上缺 key 出缺 key 失败卡」（02 验收 22）不变。

- [ ] 9. 修补：第一把 key 定默认（§对 02 的修补；验收 12；开放问题 1、2）
  - 文件：`apps/desktop/src/main/provider-routes.ts`（`provider.configure` 保存成功之后，在同一把 profile 锁里按 spec 写三键；条件读锁里的 config 三键、④ 的两个环境变量，「已配置」用这次写入的值与 config 按 01 修补 6 的算法算、不另读钥匙串；写失败只记日志、不改应答）。不碰 `run-assembly.ts`、`model-routes.ts`。
  - 测试：`provider-routes.test.ts`「presentation-r1 验收 12: the first key with all three defaults empty writes them to the provider’s first main row」「…: cowork is written only for a row that holds tools」「…: an existing default is left alone」「…: TENON_PROVIDER or TENON_MODEL set → nothing written」「…: a failed default write still answers ok and keeps the key」；e2e `provider-settings.spec.ts`「…验收 12: fresh profile → save a key → the chip shows that provider’s first row → send goes」；02 验收 33「设置卡只在改过下拉时才写键」的原用例加一句前提（三键已有值），照旧通过。
  - 命令：U `apps/desktop/test/provider-routes.test.ts apps/desktop/test/model-selection.test.ts`；E `provider-settings.spec.ts`；G。
  - 突变：① 不看三键是否为空 → 「existing default is left alone」红；② cowork 也写仅文字的行 → 红；③ 忽略 ④ → 红；④ 写失败时回错 → 红。

- [ ] 10. 双语、机制词与基线截图（验收 13、14）
  - 文件：新 `apps/desktop/e2e/text-fit-r1.spec.ts`（1280×800 两种语言量第 1–8 步的每个新元素；800×520、侧栏展开量工具行与框下那行；内容元素用 `expectWrappedUnclipped`）；`copy-coverage.test.ts` 加「presentation-r1 验收 14: no mechanism words on the card, its collapsed line, the block notices, the row’s line and the summary」（键集合逐项写成字面量）；刷新 darwin 截图基线（`shell-i18n.spec.ts` 等）一次。
  - 命令：E `text-fit-r1.spec.ts shell-i18n.spec.ts`；U `apps/desktop/test/copy-coverage.test.ts`；EA；G。
  - 突变：① en 的「允许」钮期限写长到折行 → text-fit 红；② 某个卡句写回「模型」→ 验收 14 红；③ 删 en 的一个新键 → `pnpm lint`（i18n:check）红。

- [ ] 11. 文档同步（验收 15）
  - 旧 spec：照 spec §替换的条款 在每条原文所在行行末接指针（表格行放进最后一格），照 §旧 spec 上要加的 在 00、02、03、custom-vendors、model-display-names 顶部各加一行（02 另加 `Amended by:`），`<日期>` 写合入当天。开放问题 8 选 B 时少加 R4、R6、R24 与 R25 的工具行一半。
  - `docs/ux/components.md`：`ModeSwitch`、`FolderChip`、`ApprovalCard` 两行、`BlockedNotice`、`TurnSummaryLine`、`FailureCard`、`ModelMenu`、`ToolRow`、`ProjectDetail` 各加带日期的补记；「待呈现 spec 替换的条款」两行标已替换，并改掉「那一段在 PR #45 的分支上，尚未进 dev」；两节补记里「留给后续的呈现 spec」的几处注明由本 spec 做了。
  - 04 plan 第 18 步末尾加一句交接（spec §与 04 第三段的先后）。
  - 核对：`git diff dev -- docs/architecture docs/features/custom-vendors docs/features/model-display-names` 只有行末追加与顶部新行。

- [ ] 12. 对照 spec 全部验收标准逐条验证，结果、命令与证据位置记在本文件；不变量 1–7 各有一条名字带「presentation-r1 不变量 N」的测试（多半是上面某条用例改名或加注）。
- [ ] 13. 清理：删临时探针、截图草稿与调试输出；`git status` 只有本计划的改动；仓库里没有 key 的值。
- [ ] 14. spec 顶部改 `Status: implemented`，写交接。

## 实施记录

- 2026-10-15 · 第 0a 步 · Claude Code 起草 spec 与本计划，分支 `docs/presentation-r1`（基于 `23dc572`），本地提交、未推送、未开 PR。没跑 G（只改文档）。下一步：owner 答开放问题 1–13（第 0b 步）。

（停下之前追加一条：日期 · 步骤 · 状态；分支与基于的提交；G / E / EA 的结果；做过的突变与红绿；做到一半的与代码停在什么状态；下一步。）

## Open

- 第 0b 步之前：开放问题 1–13 待 owner。
