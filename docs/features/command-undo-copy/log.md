# command-undo-copy · log

## 实施 · 2026-11-28（第 1–4 步）

- 先写用例、看到变红：`renderer-approval-card.test.ts`「command-undo-copy 验收 1、2」、`renderer-tool-row.test.ts`「command-undo-copy 验收 3」、`copy-coverage.test.ts`「command-undo-copy 验收 4」与 presentation-r1 验收 14 的清单里加上两个新键；改实现前验收 1、3、4 与 presentation-r1 验收 14 红，验收 2 绿（它守旧行为不变）。
- 实现：`lib/approval-card.ts` 的 `undoKey` 加 `snapshotStatus`、`subtask` 两个可选入参；`ApprovalCard` 从 `useSnapshotRounds()` 取 `status` 连同已有的子任务标记传入。`lib/tool-row-effect.ts` 的 `toolRowEffect` 加 `hasSnapshot`；`ToolRow` 先算这次调用的快照号再算这一行。两份 locale 各加两句。改完五个相关测试文件全绿。
- 测试里新加了 `SnapshotProvider` 的 mock（两个文件各一个，默认不给快照数据），原有用例的行为与改动前一样。
- 文档：总参考「以后再说」那一行改成指向本 spec 的已办写法；`docs/ux/components.md` 只写了「④ 说后果」，没引这句原文，不改；overview 不写界面文案的选法，不改。

## 评审 · 2026-11-28 · 审过 a6f66a5
结论：不通过    评审：主会话派出的新上下文子 agent（全面视角），Opus 5.5；读了评审包、a6f66a5 的生产代码（approval-card.ts、tool-row-effect.ts、ApprovalCard.tsx、ToolRow.tsx、SnapshotProvider.tsx、snapshots.ts）、contracts 的 snapshot.ts 与 confirm.ts、kernel 的 restore.ts 的 rounds 分支、reversibility.ts、batch.ts 的 cardOf、05 和 06 spec 的相关节、overview；没读作者对话、log.md、plan.md
突变：出了 15 个（M1–M15），首跑存活 4 个：M1（target.type 换成 kind）判等价，kernel 的 cardOf 只给 Bash 配 command 对象；M8（工具行去掉 unknown 条件）在产品里够不到，记为建议；M10、M14 真存活，记为第 2 条发现；另做了 2 个复现探针，不计入突变；全部已用 git checkout 还原
发现：
- [major] 快照被清后，Bash 工具行仍写「它改的文件能随这一轮还原」，同一轮结算行已不再显示「可还原」；decisions.md「agent 自定」第 3 条「快照清掉之后快照号跟着消失」不成立 · 证据：packages/kernel/src/loop/restore.ts 的 rounds 分支里，calls 按 round.rootNodes 列出、不看 snapshotsAlive，只有 canRestore 看；在临时 worktree 的 packages/kernel/test/loop/snapshot-restore.test.ts 末尾临时加一条：根会话 Bash（tree）批准后，把 h.host.snapshots.alive 打桩为空集，断言 rounds[0].canRestore === false 且 rounds[0].calls.length === 1，通过；ToolRow 的 saved !== null 因而为真 · 待作者处置
- [major] 验收 3 的渲染用例把 status 固定为 tree、canRestore 固定为 true，只变 calls，「看快照号、不看能否还原」这一点没被钉住 · 证据：存活突变 M10（ToolRow.tsx 里 saved !== null 改成 saved?.canRestore === true）与 M14（改成 saved !== null && rounds.data?.status === 'tree'），跑全部 renderer-*.test.ts 加 copy-coverage.test.ts（44 个文件、999 条）仍绿 · 待作者处置
- [major] 不受限制重跑（reason elevated）与沙箱不可用（facts.sandbox unavailable）的命令卡，在 tree 下 ④ 也写「它改的文件一般能随这一轮还原」，而 ③ 写「能读写你能访问的所有文件」或「沙箱不可用，将以你的权限运行」；快照只覆盖任务文件夹，新句的例外不含文件夹以外的文件；涉及本项目补充第 3 条末句「替换后的文案仍须写明……有什么后果」· 证据：用 renderer-approval-card.test.ts 里现成的 renderWithSnapshot('tree', …) 渲染 {kind:'command', reason:'elevated', reversibility:'unknown', facts:{command, cwd, toolName:'Bash'}} 和带 sandbox:'unavailable' 的命令卡，断言 approval-undo 的文字等于 commandRestorable 那句，中英文都通过；kernel 的 callReasonOf 对 rerun-unsandboxed 给 elevated，commandReversibility 给 unknown · 待作者处置
- [建议] 工具行测试里 Bash 只测了 unknown 和 irreversible，没钉住「一直要成立的规矩」第 4 条里「可逆性 unknown」那个条件（审批卡那侧是全测的）· 证据：存活突变 M8；但 kernel 的 reversibilityOf 只给 Bash 这两个值，产品里够不到 · 不修：只算建议
- [建议] spec 自称改的是「属权限语义的文字」，skill 的选档规则「碰安全、权限、沙箱……→ heavy」与本项目补充第 2 条指向 heavy；owner 批 ready 时没有推翻 standard · 无证据 · 不修：只算建议
overview：不用改。它只在模块表里泛写 renderer 有「工具行与拦截回执、审批卡」，没写后果句的文案，也没写 undoKey、toolRowEffect 的入参。

## 评审处置 · 2026-11-28（审过 a6f66a5 那一轮）

- [major] 快照被清后工具行仍写能还原 · 已修（本条之后的修复提交）：`ToolRow` 传 `saved?.canRestore === true`，`toolRowEffect` 的入参改名 `restorable`；decisions.md 自定第 3 条改写、spec 修订记录一行。
- [major] 验收 3 的测试空心（M10、M14 存活） · 已修（同一提交）：测试的快照读模型改成可调 `status` 与 `canRestore`；加「有快照号但那一轮不能还原 → 旧句」「本会话状态为 warming、file-only、unavailable 时仍按那一轮判 → 新句」；作者在本地把 `ToolRow` 改回 `saved !== null`、改成另加 `status === 'tree'`，两次都变红。
- [major] 在沙箱外重跑、沙箱不可用的命令卡也出新句 · 已修（同一提交）：两句新文案限定在「任务文件夹里」，撤不回的一串加「文件夹外的」，对这两种卡同样成立（「仅此路径」放行卡上认不出，按卡型排除堵不全）；验收 1 的用例加这两种卡；spec 修订记录一行，decisions.md 加一条自定。
- [建议] 工具行 Bash 只测 `unknown`、`irreversible` · 不修：只算建议，kernel 只给 Bash 这两个值。
- [建议] 档位应为 heavy · 不修：owner 批 ready 时认了 standard；本轮修复都是收紧。
- 补记：上面三条「已修」的修复提交是 74cbae6。

## 评审 · 2026-11-28 · 审过 74cbae6
结论：不通过    评审：子 agent 新上下文复审（Opus 5.5），读上一轮发现、a6f66a5..74cbae6 修复 diff、作者处置清单、核心细则第 8 条；在临时 worktree（检出 74cbae6）读 spec.md、decisions.md、ToolRow.tsx、tool-row-effect.ts、snapshots.ts、approval-card.ts、restore.ts，跑突变与 spec-check；docs-sync 警告核过：overview.md 不提 toolRowEffect、undoKey，不用跟改
突变：13 个（复跑上一轮存活的 M10、M14，新出 N1–N11），跑全部 renderer-*.test.ts 加 copy-coverage.test.ts（44 个文件、999 条）；首跑存活 3 个（N6、N8、N9，同一处缺口：取错轮的 canRestore），登记为下面第 4 条，待作者处置；其余 10 个变红
发现：
- [major] 快照被清后工具行仍写能还原 · 证据：ToolRow 改传 saved?.canRestore === true；snapshots.ts 的 callSnapshot 返回调用所在那一轮的 canRestore，restore.ts 的 canRestore 为 snapshotsAlive && hasChanges；新用例「有快照号、canRestore 为 false → 旧句」在；M10（改回 saved !== null）红在验收 3；decisions.md 自定第 3 条已改写 · 已修 74cbae6
- [major] 验收 3 测试空心（M10、M14 存活） · 证据：M10、M14 现都红在 renderer-tool-row.test.ts 验收 3；N1（另加 status === 'tree'）、N2（canRestore !== false）、N3（只看 rounds[0]、不看本调用的快照号）、N4（tool-row-effect 里 restorable !== false）、N5（callSnapshot 的 canRestore 恒为 true）都红 · 已修 74cbae6
- [major] 在沙箱外重跑、沙箱不可用的命令卡也出新句 · 证据：两句中英文改为「在任务文件夹里改的…；文件夹外的、联网发出的…撤不回」，与 ③「能读写你能访问的所有文件」不再冲突；验收 1 用例加 reason elevated 与 facts.sandbox unavailable 两种卡（approval-card.ts 判沙箱不可用用的就是 facts['sandbox']）；N7（undoKey 排除这两种卡）红在验收 1；N10、N11（回退中、英文文案）红在验收 1、3、4；只收紧文案，没有新增状态、机制、接口、表或配置项，spec 修订记录有一行 · 已修 74cbae6
- [major] 验收 3 的「那一轮还能还原」没被钉住，取错轮的 canRestore 能存活 · 证据：N6（snapshots.ts 的 callSnapshot 改取 rounds.at(-1)!.canRestore）、N8（ToolRow 改传 saved !== null && rounds.data?.rounds.at(-1)?.canRestore === true）、N9（改传 saved !== null && rounds.data?.rounds.some((r) => r.canRestore) === true），44 个文件 999 条全绿；renderer-tool-row.test.ts 的快照读模型只有一轮 round-1，renderer-snapshots.test.ts 的 callSnapshot 用例也只给一轮；多轮会话里早一轮快照被清或已还原、最新一轮仍可还原时，这类实现会让早一轮的 Bash 行写「能随这一轮还原」而那一轮结算行没有「可还原」，正是上一轮第 1 条的情形 · 待作者处置
- [major] decisions.md「owner 原话」里 ready 那条的注记从「agent 自定 5 项没有推翻」改成「6 项」，把 owner 批 ready 之后才改写、新增的两条也算进了 owner 没推翻的范围 · 证据：git show ec4769d:docs/features/command-undo-copy/decisions.md 有 5 条「- 自定」、末行写「5 项」；74cbae6 改写第 3 条、新增第 4 条，同时把末行改成「6 项」；docs/spec-driven-dev.md「agent 自定」那条写明 owner 批 ready 时一并看、可以推翻，这两条 owner 当时没看过；spec.md「要你定的」如实写了「评审之后改了一项、加了一项」，两处对不上 · 待作者处置

## 评审处置 · 2026-11-28（审过 74cbae6 那一轮）

- [major] 取错轮的 canRestore 能存活（N6、N8、N9） · 已修（本条之后的提交，复审核对时补号）：工具行测试的快照读模型加第二轮，可放在这次调用那一轮之前或之后，两轮的 `canRestore` 相反，断言行只跟这次调用那一轮走；作者本地打上 N6、N8、N9，三个都红在验收 3。
- [major] decisions.md 把 owner 批 ready 时的「5 项」改成了「6 项」 · 已修（同一提交）：那条原话记录改回「5 项」；批 ready 之后改写的第 3 条与新增的第 6 条各标「批 ready 之后改／加，owner 还没看过，已在对话里列出」，在对话里逐条列给 owner。
