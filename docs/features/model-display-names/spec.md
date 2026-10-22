# 模型显示名

Status: implemented
Clauses replaced by: [presentation-r1](../presentation-r1/spec.md)（2026-10-22：§对 02 的修补 末段、验收 3 的主机一句）
Kind: features
Owner: 起草在 Claude Code（2026-10-15），为已落在 `38d4a1b`（feat/ux-craft）的 `ModelInfo.nameKey` / `provider.list` 行的 `nameKey` 补写 amendment；owner 2026-10-15 在 PR #46 评审中接受
Amends: [01-provider-and-tape](../../architecture/01-provider-and-tape/spec.md) §Provider 层（`ModelInfo`）；[02-agent-loop](../../architecture/02-agent-loop/spec.md) §对 01-provider-and-tape 的修补（第 2 小节的 `ModelInfo`、第 6 小节的 `provider.list`）、§界面范围 §模型菜单与输入框 的「位置与触发器」「每一行」「设置卡」三条。只增不改，全文见 §对 01 的修补、§对 02 的修补
Revisions: 2026-10-15 同日评审后改三处——① `Status` 由 `implemented` 改回 `draft`、`Owner` 行改写：原 Owner 行称 owner 当天对评审意见「都按推荐」、即接受了补写本 spec；据评审核实，那句话是对评审之前另一份清单说的，本 spec 未经 owner 接受；② 引用 02 的位置由行号（加 `Amended by:` 之前的编号，落地当天就错了一行）改为「节名 + 引文」；③ `Amends:` 补上本 spec 实际加了读法的「位置与触发器」「设置卡」两条，验收 3 改引实际断言这些的测试；2026-10-15 owner 在 PR #46 评审中接受，`Status` 改为 `implemented`

## 背景

模型菜单每行的第一行和输入框里的模型 chip 写的是原始 id（`claude-opus-5-5`、`glm-5.3-flash`）。02 §界面范围 §模型菜单与输入框「每一行」写的是「第一行模型名」，没有规定必须是 id；用途句已经作为目录键给出（`purposeKey`，02 §对 01-provider-and-tape 的修补 第 2 小节的 `ModelInfo.purposeKey`、第 6 小节 `provider.list` 行的 `purposeKey`），显示名缺同样的一键。

## 对 01 的修补

改 `packages/kernel/src/provider/types.ts`，只增：

```ts
export interface ModelInfo {   // 已存在
  nameKey?: string             // 新增：模型显示名的 i18n 键（「Opus 5.5」），作为数据给出（照 purposeKey、ProviderDefinition.nameKey）
}
```

- 键里不出现原始模型 id（i18next 默认设置下「.」「:」是分隔符，照 02 §界面范围 §调用的键与读写的数据 对 `purposeKey` 的规定「键里不出现原始模型 id」）：内置行用 `model.name.<短名>`，如 `model.name.opus55`、`model.name.glm53flash`。
- 不进 `WIRE_MODEL_FIELDS`：encode() 不读它，加、改、删它都不改变 `modelWireHash`，不算「模型表变了」。它和 `purposeKey` 一样是完整 ModelInfo 的一部分，`view/assembled.modelInfoHash` 仍按完整原文算（02 的「清单只记三样引用」一条不变：「`view/assembled.modelInfoHash` 是完整 ModelInfo 的 `canonicalHash`」）。
- 缺省 = 没有显示名。手填、本机（Ollama）、开发期合成和自定义厂商实例的行都不写这一键。
- `anthropic`、`zhipu` 两个内置定义的每一行都写这一键，两份 locale 各有对应文案（`model.name.*`）。

## 对 02 的修补

**provider.list**（02 §对 01-provider-and-tape 的修补 第 6 小节），`packages/contracts/src/ipc/provider.ts`，只增：

```ts
providerModelSchema = z.object({
  // 已有成员不变
  nameKey: z.string().min(1).optional(),   // 新增：显示名的目录键，取自 ModelInfo.nameKey；缺省 = 这一行没有显示名
})
```

主进程照 `purposeKey` 的方式转发：ModelInfo 写了才带（`apps/desktop/src/main/provider-routes.ts` 的 `menuRow`）。

**界面**（02 §界面范围 §模型菜单与输入框，三条各只增一句读法，原文不动）：

- 「每一行」（「第一行模型名」）：有 `nameKey` 的行，第一行写它解析出的显示名；没有的行照旧写 id。
- 「位置与触发器」（「触发器显示『模型名 + 档名』」）：触发器里的模型名同上一条，有显示名写显示名。
- 「设置卡」（「新会话默认模型」的下拉）：选项写同一个显示名，原始 id 作悬停提示；没有显示名的行写 id。

第二行（用途句或行标记，后接目标主机）不变。界面的 i18n 规则不变：目录键由 kernel 作为数据给出，renderer 解析。（2026-10-22 起由 [presentation-r1](../presentation-r1/spec.md) §模型菜单 取代：地址是厂商声明默认值的内置行第二行不再带主机）

## 验收标准

1. 两个内置定义的每一行都有 `nameKey`，键在两份 locale 里都有、没有要填的占位符（`apps/desktop/test/copy-coverage.test.ts`「names every Anthropic and Zhipu row」与「has the display name and purpose sentence of every builtin model row」；`apps/desktop/test/provider-catalogue.test.ts`）。
2. `nameKey` 不影响 `modelWireHash`（`packages/kernel/test/provider/vendor-blocks.test.ts`「the attempt says which encoder and which model fields」）。
3. 菜单行的第一行与 chip 写显示名，不写 id；第二行仍有主机（`apps/desktop/e2e/model-menu.spec.ts`「lists configured providers by host, greys the rest, and names the thinking level」）；手填的 Ollama 行仍写 id（同文件「asks by where the history went, not by the model in effect, and a typed model’s row names its host as the others do」）；设置卡的下拉写显示名、id 是悬停提示（`apps/desktop/e2e/provider-settings.spec.ts`「acceptance 6: the settings card switches the provider the next message goes to」）。（2026-10-22 起由 [presentation-r1](../presentation-r1/spec.md) 验收 9 取代：官方地址的行主机在悬停里）
