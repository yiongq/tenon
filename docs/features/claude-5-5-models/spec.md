# Claude 5.5 两行与模型目录跟随最新

Status: ready
Tier: standard — 改 ModelInfo、config.json 的默认与会话事实投影这类别处依赖的格式；不加 Tape 事实名，不碰权限、沙箱与凭据
Kind: features
Owner: 起草在 Claude Code（2026-10-15），厂商事实当天按一手页面核过（§事实与出处）。owner 2026-10-15 定：开放问题 1A、2A、3A、5A、6A、7A、8A；开放问题 4（菜单位置）由 owner 的新规则「跟随最新」取代（§跟随最新）。owner 2026-10-15 选「跟随最新」A 时一并定了：运行中的会话不随默认改动而换（§跟随最新「会话不换」，§点名 (f)）。定法见 §开放问题（已定），没选的项见 §被否决的方案。§点名 (g)（菜单写指针、只改档不写默认）是本 spec 推出的，owner 2026-10-15 经问卷单独确认 A。同日 owner 接受本 spec，`Status` 改 `ready`（`Revisions:` ㊴）
Amends: [01-provider-and-tape](../../architecture/01-provider-and-tape/spec.md) §Provider 层（`ModelInfo` 的 `pricing.longPrompt`、`family`、`generation`；`ThinkingSpec.offType`，`ThinkingSpec` 由 02 的 01 修补 2 立；`ProviderDefinition.familyNameKeys`）、§desktop 接线（`config.json` 的 `provider` 与 `provider.select` 的请求都只增 `latestOf`）、§验收标准 6 的结果（读法：已有 Run 的会话不随设置卡换厂商，§点名 (f)）；[02-agent-loop](../../architecture/02-agent-loop/spec.md) §对 01-provider-and-tape 的修补（第 2 小节的 `ThinkingSpec`、`pricing` 与 `listing`；第 3 小节「Anthropic 线的 thinking 编码四分支」的 `{ enabled: false }` 一支、「`samplingDefaultsOnly` 的行……本地拒绝」一条；第 6 小节的 `defaultModelByProfile` 与 `providerSelectionSchema`、「五层解析」、「在模型菜单里选一次，同时写……」、`provider.list` 的行、`provider.select`）、§主进程与 kernel 的循环接口（`RunConnector.resolveChoice` 的问询只增 `previousModel`）、§模型选择（M5：「没选过模型的会话」）、§模型菜单与输入框「设置卡」、§记录格式与费用口径（「费用与用量」第一条）、§开工前裁决 A16 的「推迟到」一栏（「Haiku 4.5 有弃用公告后撤行」）；[model-display-names](../model-display-names/spec.md) §对 02 的修补「设置卡」（指针选项的标签）。全文见 §对 01 的修补、§对 02 的修补、§对 model-display-names 的修补、§跟随最新；不属纯粹只增的 (a)(b)(f)(g) 列在 §点名
Replaces: 02 §模型菜单与输入框 里「更多模型 ›」那一条的括注「（Opus 5 Legacy）」，改为「每个家族里不是最新一代的行」，只写规则、不列行。02 正文不改，也不加行末指针（02 已 `implemented`，正文冻结）；只在 02 页头加一行 `Changed by`，由 plan 第 13 步写，日期取写入那一行的提交的日期，合入晚了也不改（修订记录 2026-10-23）。理由：owner 2026-10-15 定「跟随最新」，`listing` 改由家族与代次算出，这一档不再只有 Opus 5。条款本身「收 `listing === 'more'` 的行」不变，只涉及菜单文字（spec-driven-dev 第三个例外），新条款全文见 §替换 02 的表现层条款
Related: [presentation-r1](../presentation-r1/spec.md)（2026-10-22 经 PR #55 合入 `dev`，`implemented`）。它的 §对 02 的修补 第 1 条按构建里有没有 `latestOf` 分两支写第一把 key：「有」时带家族的内置第一行写本 spec 的指针，「没有」时写行 id。那是它自己写好的条文，本 spec 只实现「有」一支、不改它的文字，所以它的页头不加 `Changed by`。它先合入，「有」一支由本 spec plan 第 11 步实现（第一种情形），本 spec 验收 19 就是它验收 12 的指针一例，在本 spec 里验（修订记录 2026-10-23）。两份都改的文件照它 plan 的合并清单：`model-menu.spec.ts`、`text-fit-02.spec.ts`、`provider-settings.spec.ts`、`provider-routes.ts` 与其测试、两份 locale 与 `copy-coverage.test.ts`
Revisions: 2026-10-15 首版。同日按评审就地修订（`draft`，没有代码依赖）：① 事实：加 F16（Sonnet 5、Haiku 4.5 已是 Legacy）、F17（Sonnet 5.5 的五类拒答与 beta fallback）、F18（Sonnet 5.5 收 `summarized`，两行有 vision）、F19（Sonnet 5.5 工具间的说明走 thinking 块）、F20（最小可缓存长度）；F4、F12、F13 补原文；「Sonnet 5.5 迁移页」写成路径。旧：开放问题 4 A 写「不写「旧版」，因为厂商没给这两行标 Legacy」，§没核到 列了拒答分类、`summarized` 与 vision，这三处都与一手页面不符；② 开放问题 4 A 的用途句改为「上一代 Sonnet（旧版）」「上一代 Haiku（旧版）」，理由改为 F16 与 A16 的先例（旧：不带「旧版」）；B、C 写明两行已是 Legacy；§Haiku 4.5 现状 写 Legacy；③ `Amends:` 补 A16 推迟项与 1B 的思考参数表。旧尾句说不属纯粹只增的改动只在选了非推荐项时出现，可推荐项 5A 就会触发 (b)。`Replaces:` 由「无」改为条件句，新条款全文放在新加的 §替换 02 的表现层条款；§点名 加 (d)(e)；④ 不变量 1、验收 11：开放问题 4 改了 `listing` 的行不要求 `modelInfoHash` 不变（旧：五行的 `modelInfoHash` 都不变、Haiku 4.5 除注释外逐字节相同，推荐项下不成立）；⑤ 编码器版本、不变量 6、验收 4 按开放问题 1 的选法写（旧：无条件为 4），加 §兼容；开放问题 1 C 补「旧记录仍可复核」；⑥ `between_tools` 只许写在带 `disableMaxEffort` 的 adaptive-gated 行上，关思考又带非空 `tools` 的请求本地拒绝（旧：budget、adaptive、adaptive-gated 三种模式都可写，不看 tools）；⑦「逐条 effort」一条写明改档的风险与退路；验收 12 加两例：Sonnet 5.5 选 low 后压缩、Haiku 5.5 按默认档压缩。判据写明从 Tape 读，也写明对提示长度与缓存的前提。验收 10 改用改了 id 的行，验收 7 加档内缺缓存价一例；⑧ §Haiku 4.5「公告之后」改引 02 §续跑，并补上撤行后复核得 `model-table-changed`（旧引 02 不变量 33）；开放问题 7 A 不再指向已勾掉的 02 plan 第 34 步；⑨ plan：第 1 步只留 `supportsStreamingToolCalls`；第 3、5 步补上会变红的测试；命令改为跑全量 vitest，加 text-fit-02，live 用 `--grep`；第 6、7 步补突变与用例。同日第二轮评审就地修订：⑩ 事实：F14 改引 `build-with-claude/thinking` §Sampling parameters，同一采样规则适用表里全部 `samplingDefaultsOnly` 的六行（旧：只引 Sonnet 5.5 概览页，写「没给默认值，也没提同发」，§没核到 列了 Sonnet 5.5、Opus 5.5、Fable 5.1 的采样规则）；F8 补 Haiku 5.5 提示页的四类拒答（旧：§没核到 写「Haiku 5.5 的分类没在一手页面核到」）；加 F21，两新行 `supportsStreamingToolCalls` 直接写 true（旧：按 plan 第 1 步核，核不到写 false，引「01 spec:706『能力不明就关』」，那是 02:1139 对 01:711 表外 id 保守合成的转述，不管内置行；相关规则是 01:353「确认不了的字段在 plan 记一笔」）；F12 加 `release-notes/overview` 出处，「更正」第二条改为 $0.20 是 2026-10-07 降价前的官方价（旧：说成非一手材料与定价页冲突）；§没核到 现在没有条目；`thinkingSpec` 注释一行加改 anthropic.ts:85-87 的 sampling 注释；⑪ 开放问题 3 重写：推荐项改为不加成员、所有 `samplingDefaultsOnly` 的行统一按厂商规则收紧（即旧 C，触发 §点名 (a)）；B 为六行都设 `samplingExact`（新）；C 为只设两新行（旧 A 只设 Haiku 5.5 并为推荐，旧 B 加 Sonnet 5.5 写作「推断」）。理由：F14 写明这六行规则相同，旧 A「只用在页面写明的行上」、旧 B「这是推断」、旧 C「默认值未知、不见得更保守」都不成立。§对 01 的修补 去掉 `samplingExact`（选 B、C 时再加），数据表的 Haiku 5.5 行去掉 `samplingExact: true`；§对 02 的修补 2、非目标、不变量 1 与 4、验收 1 与 5、§点名 (a) 随改；验收 5 加「有 `samplingDefaultsOnly`、没有 `samplingExact` 的行照旧收单独的 `top_p` 1」两例（旧：只说 Opus 5.5「The defaults are accepted」不改仍通过，选 A 或 B 时那个请求厂商会 400）；⑫ 开放问题 5 A 按弃用页原文写「仍可用，但可能不如 Active 可靠」（旧：「厂商照常服务」）；「逐条 effort」列出查过的页面和两处最接近的原文（旧：只写「页面没写」）；§对 02 的修补 1 的理由改为响应形状与快照不符，引 400 报错原文（旧：「模型实际却在思考」，与厂商说法不符）；⑬ `offType` 收窄为 `'between_tools'`，关思考写 `disabled` 只由缺省表达（旧：`'disabled' | 'between_tools'`，显式写 `'disabled'` 编码不变却改 `modelWireHash`）；编码器只在 adaptive-gated 一支读 `offType`，budget、adaptive 行写了它时关思考本地拒绝（旧：三支都写 `offType ?? 'disabled'`，表错误只靠 definitions 测试挡）；验收 1 去掉「`offType: 'disabled'` 只出现在……」那条（内置行没有一行写它，永不变红），验收 2 加合成行两例；⑭ 不变量 1 末句按开放问题 1 的选法写（旧：无条件「结果仍是 `verified`」，1A、1B 下旧记录一律 `other-encoder`）；§点名 加「为什么仍算 amend / 须 owner 确认」一列和「不认可就走 supersede」的读法，按推荐项走有 (a)(b)（旧：只有 (b)，表上没有依据一列）；A16 的落点改为「§开工前裁决 A16 的「推迟到」一栏」（旧：「§裁决表 A16 的推迟项」，02 没有这一节），`Amends:` 与 (b) 两处；4C 的替换条款括注写全 live 冒烟前后两个阶段（旧：只写冒烟前）；⑮ 验收 4 与 plan 第 3 步：原有金样行与两份金样请求不改，另加关思考的行、请求和表，查重改为跨表（旧：把 `ANTHROPIC_ROW` 与两份金样请求改成关思考、不带 tools，第 4 版起金样丢了 tools 与 display 的覆盖）；验收 12 逐条写明从哪里读，线上形态与状态码从 record 模式的线上记录读（旧：除第一条都从 Tape 读，Tape 不记线上 `thinking.type` 与状态码），两例压缩先跑一轮 Read，缓存一条先断言第一个请求写了缓存（旧：断言第二个请求长于 512）；plan 第 5 步补 model-selection.test.ts:153-157；第 7 步推理题不再要求调 `lookup`；开放问题 6 A 的请求数随之改为约 30。2026-10-15 owner 定开放问题，同日就地修订（仍 `draft`，没有代码依赖）：⑯ 定法：1A、2A、3A、5A、6A（live 冒烟在实现时用官方 key 跑，读钥匙串 `tenon-live-anthropic` 之前先提醒 owner，macOS 会弹窗）、7A、8A；开放问题 4 由 owner 的新规则「跟随最新」取代。标题旧为「Claude 5.5 两行：Sonnet 5.5、Haiku 5.5」。全文「按开放问题 N」的条件句改为所选项，没选的项移到新加的 §被否决的方案（旧：§开放问题 列全部选项；§对 01 的修补 有 3B、3C 的 `samplingExact`；§兼容 有 1C、3B 的情形；§点名 有 (c)(d)；§替换 02 的表现层条款 有 4A、4C 两条）；`Replaces:` 由条件句改为一条；⑰ 跟随最新·排位：新加 §跟随最新。anthropic 与智谱的内置行带 `family`、`generation`，`listing` 在构建表时由它们算出，每个家族最新一代在主列表，旧的进「更多模型 ›」（旧：逐行手写，4A 推荐手写 Sonnet 5、Haiku 4.5 为 `'more'`，GLM-4.6 留在主列表）。两家内置行的 `modelInfoHash` 都变（旧不变量 1：只有改了 `listing` 的行变）。anthropic 行序改为四个最新一代在前、三个旧的在后（旧：两新行插在 Opus 5.5 之后，旧行不动）；⑱ 跟随最新·默认：新会话默认可以是指针（`providerSelectionSchema` 只增 `latestOf`）；会话第一个 Run 把它解析成具体一行、记进 `session/model_selected`，之后同一家族不换（`resolveChoice` 的问询只增 `previousModel`，`SessionFacts.lastSelected` 只增 `modelId`，不加 Tape 事实）；菜单从主列表选带家族的行写指针，设置卡的下拉先列指针（`provider.select` 的请求只增 `latestOf`；`provider.list` 的行只增 `family`、`familyNameKey`；`ProviderDefinition` 只增 `familyNameKeys`）；现有 config.json 不改写；presentation-r1 的第一把 key 写指针。`Amends:` 加 01 §desktop 接线、02 第 6 小节与 §主进程与 kernel 的循环接口、§模型选择、§模型菜单与输入框「设置卡」、custom-vendors、model-display-names；§点名 加 (f)(g)；⑲ 非目标加「不自动用厂商新发布、Tenon 没适配的模型」与「Ollama、自定义厂商不分家族」；⑳ 不变量 1、4、5 随改，加 7–11；验收 1、5、8、9、11 随改，加 13–19；plan 加第 5 步（家族排位）与第 8–11 步（契约与端口、解析与写指针、设置卡、与 presentation-r1 的衔接），live 由第 7 步改为第 12 步；01、02 等旧 spec 上要加的几行由第 0 步挪到第 13 步，与实现同一个 PR、日期写合入当天（旧：第 0 步，owner 一定就加）。2026-10-15 第三轮评审就地修订（仍 `draft`，没有代码依赖；owner 同日定「都按推荐来」）：㉑ 会话不换：「解析」第 1 条改为本代已有 Run、上一个 Run 的行还在那家厂商的表里就用它，不看答话的是哪一层、是不是指针，用户改默认也不换运行中的会话（旧第 3 条：只在答话的一层是指针、上一个 Run 的行同厂商同家族时留下，用户改成别的家族、厂商或钉住的一行照 02 跟着换；评审指出这是把 owner 原文「运行中的会话不换」收窄，owner 选了不收窄）；上一个 Run 的行不在表里时照 02 读默认（旧：取同家族最新一代；会话不换不再只管指针以后，连接器手里只有 provider 与 id，不知道撤掉的行属于哪个家族）；手填与开发变量合成的 id 不算表里的行，不适用；④ 只给 `TENON_PROVIDER` 与 ⑤ 不再读作指针（旧：读作指向第一行所在家族的指针；第一行本来就是本家族最新一代，会话不换又不看指针，它不再改任何结果）；「什么时候还会换」、§数据去向、§Haiku 4.5「公告之后」、不变量 9、验收 15、§点名 (f)、§本 spec 自己定的细节、§被否决的方案、§对 02 的修补 第 8、11、12 条随改；验收 15 加 Ollama 地址改到公网主机一例（数据去向检查在会话不换之后照做）与手填 id 一例。同一评审为旧规则提的两处补丁（同一家族里由钉住改成指针时比代次；表的第一行换了家族时按厂商比）随这一选择不再需要，没采用；㉒ 写指针：`provider.select` 不带 `latestOf` 时照旧写钉住的值，菜单另用只给 `session.selectModel` 的判定（旧：plan 第 9 步让两条路共用的 `selectionOf` 对主列表带家族的行给指针，设置卡选钉住的行也会存成指针，与第 13 条矛盾）；`latestOf` 不在表里、带 `latestOf` 选 Ollama 或实例回 `invalid-value`（旧：`unknown-model`，02 第 6 小节「表外模型手填」对内置厂商写定不再返回它）；验收 16、17 随改；㉓ 第一把 key：由本 spec 修补 presentation-r1 §对 02 的修补（M5）第 1 条，`Amends:` 加它，§点名 加 (h)（旧：说由 presentation-r1 在自己的 `Revisions:` 里就地改；它的 ea34e42 已写明一律写具体 id、要自动跟新另写 spec 修补它，两份都在等对方）；本 spec plan 第 11 步等 presentation-r1 写第一把 key 的代码合入后做，两者之间不切 release 分支（旧：「两者同一个 PR 或本 spec 在前合入就没有这段时间」，可本 spec 先合入时 presentation-r1 照样写具体 id）；验收 17「只改 key、不动下拉」改用已存着别家默认的 profile（旧：全新 profile，presentation-r1 实现后第一次存 key 就会写默认）；验收 19 写明依赖哪一边；㉔ `previousModel` 改为可选成员，缺省按 null 读（旧：必填；十处直接调用点会在 typecheck 报错，也不合 ports.ts「只加可选成员」的冻结规则）；㉕ `providerSelectionSchema` 的 `latestOf` 加 `.catch(undefined)`（旧：坏值让整个 `defaultModelByProfile` 或 `provider` 校验失败、被 `fieldwise` 丢掉，并不是读作钉住）；验收 18 加 `latestOf: ""` 一例，「主进程只写别的键」一句挪到 apps/desktop/test/profile.test.ts（旧：放在 contracts 的测试里，那里只能测 zod 解析）；验收 16 的 `provider.list` 一句挪到 model-selection.test.ts，provider-catalogue.test.ts 改为核对 `familyNameKeys` 的键（旧：provider-catalogue 不经过 `provider.list`）；㉖ `Replaces:` 的日期改为实现合入当天，与 02 行末指针同一个日期（旧：2026-10-15，与 plan 第 13 步的「合入日期」对不上）；㉗ §点名 (g) 写明它改了 02 验收 33 那两例写下的值；plan 第 9 步列出要改期望的这两例与 02「间接切公网」的 e2e，突变按新规则重列。2026-10-15 第四轮评审就地修订（仍 `draft`，没有代码依赖；对照仓库与兄弟分支 `docs/presentation-r1` 的 `c60760d` 核对）：㉘ 第一把 key：`Amends:` 删去 presentation-r1，删 §点名 (h)，plan 第 13 步不再给它加 `Amended by:`、不再补链接；「谁写指针」第一把 key 改为照它 §对 02 的修补 第 1 条已写的「有」一支，哪份后合入由哪份实现；plan「与 presentation-r1 的先后」与第 11 步按谁先合入分两种情形，不再等它，也不再因它不标 `implemented`；验收 19 按条件验；加 `Related:`，核对基准 `c60760d`。旧（㉓）：由本 spec 修补它的第 1 条，引它 `ea34e42` 的「另写 spec 修补 02 M5 与本条」，「不论两份谁先实现，都由本 spec 改」，第 11 步等它合入、之前不标 `implemented`。理由：`c60760d` 的第 1 条已按有没有 `latestOf` 分两支写指针，写明谁也不等谁、后合入的一方衔接；它是 `ready`，修补只用于 `implemented` 的 spec。「两次合入之间不切 release 分支」只留给 presentation-r1 先合入这一种情形（§跟随最新「迁移」）；㉙ 日期：`Replaces:`、各旧 spec 头行与 02 行末指针用 plan 第 13 步写入它们的那个提交的日期，合入晚了也不改，与 presentation-r1 同一约定（旧：「实现合入当天」，写那个提交时还不知道哪天合入）；㉚ 替换 02「更多模型 ›」的新括注只写规则，2026-10-15 的四行写成条款外带日期的例子（旧：括注写「现在是 Opus 5、Sonnet 5、Haiku 4.5、GLM-4.6」，`Replaces:` 写「并照实列出这一档现在的行」，下一代上架就不属实）；㉛ custom-vendors 移出 `Amends:` 与 plan 第 13 步：那一句只是读法，`withoutDefaults`（custom-vendors/store.ts）按实例 id 清默认，本来就碰不到内置厂商的指针，没有新增任何东西；改成 §兼容 的一条说明，节名 §对 custom-vendors 与 model-display-names 的修补 改为 §对 model-display-names 的修补（旧：custom-vendors 在 `Amends:` 里，读法是那一节的第一条）；㉜ 会话不换的范围：`previousModel` 与 `SessionFacts.lastSelected` 再只增 `capabilitySource`（读 `model_selected` 已有的字段，不加 Tape 事实）；内置厂商上手填的 id（`user`）也留着，照 02「表外模型手填」保守合成；实例的行（没探测过的记 `user`，通过的记 `probed`）要还在实例的表里才留；只有 `synthesized` 照 02 读默认。验收 15 手填一例改为仍用 `my-local-model`、不出确认，加 `synthesized` 一例；plan 第 9 步「间接切公网」的 e2e 改由删掉回环实例触发。旧：手填与开发变量合成的 id 一律不适用会话不换，理由是连接器只有 provider 与 id、分不出手填的 id 和撤掉的行；可 `capabilitySource` 本来就记着，Ollama 表只有一行、手填是 Ollama 的主路径，在别的会话里选一次公网模型，手填 Ollama id 的会话下一条就换过去，与 owner 定的「不论默认怎么变都不换」不符。plan 第 9 步旧写法「种子改成手填的 Ollama id」在新规则下不再触发；㉝ (f) 补三处随之变的结果：01 验收 6、02 启动恢复里续跑之后用户开的 Run、custom-vendors 验收 20 的用例（它的原文不变，只换触发方式）；`Amends:` 的 01 项补验收 6；plan 第 9 步逐个列出 provider-settings「acceptance 6」、recovery 两例、custom-vendor-runtime「验收 20」的改法，「命令」加 recovery.spec.ts，第 14 步加一次全量 e2e（旧：只列 model-menu.spec.ts，(f) 只点了 02，命令只跑三个 e2e 文件）；㉞ 只改档不写默认：会话没有 ①、这次选的就是 `session.modelChoice` 答的那一行时，`session.selectModel` 只写 ①，不写 `defaultModelByProfile[形态]` 与 `provider`；记进 §跟随最新「谁写指针」、§对 02 的修补 第 9 条与 §点名 (g)，加不变量 12、验收 16 两例与 plan 第 9 步的突变。旧：每次 `session.selectModel` 都写这两个键。会话不换之后会话所在的行可以不是默认那一行，只改档就会把升级前的 Sonnet 5 写成新会话默认，或把设置卡里钉住的「Opus 5.5」改成指针；㉟ `effectiveModelChoice` 只多交 `previousModel`，`previousOrigin` 仍为 null；验收 15 末条只断言两处的 `previousModel` 相同，另加地址改到公网后 `session.modelChoice` 照常答原行、不抛一例（旧：「交同样的问询，含 `previousModel`」，照字面会连 `previousOrigin` 一起交，拿到 `needsConfirm` 时 mailbox.ts 的 `effectiveModelChoice` 会抛错）；㊱ (g) 改 `ready` 之前请 owner 单独确认，plan 第 0 步列为前提，`Owner` 行写明还没确认；没确认之前 02 的 `Amended by:` 不写它（旧：「随本 spec 改 `ready` 一并确认」，可改 `ready` 是收尾时 agent 做的一步，第 13 步又要写「owner 确认」，会在 owner 没表态时记成已确认）；㊲ live 冒烟里摘要请求 400：报错原文记进 plan；指向 effort、`between_tools` 或 `disabled` 时才按 (e) 的退路请 owner 定，别的原因（例如历史里回放的 tool_use / tool_result 配上不带 tools）记成 02 §摘要请求「前缀（默认做法）」的问题请 owner 定；§已有规则「逐条 effort」与 §点名 (e) 的触发随改（旧：任一摘要请求 400 一律按 (e) 处理）；㊳ 2026-10-15 收尾一步曾把 §点名 (g) 记作 owner 已确认、并改 `ready`（74c15b8），已撤回（owner 说「都按推荐来」时 (g) 还没提出，不能算确认）：(g) 仍待 owner 单独确认，`Status` 仍为 `draft`；同时把 `Owner` 行 (f) 的来历写准（是 owner 选「跟随最新」A 时定的，不是第三轮评审之后）；㊴ owner 2026-10-15 经问卷单独确认 §点名 (g) 取 A（问的是：在模型菜单主列表点一个模型，默认记成「最新的 X」；在「更多模型」里点的记成固定版本；只改思考档位不动默认），并接受本 spec：`Status` 由 `draft` 改 `ready`。改动处：`Status`、`Owner` 行与 (g) 的三处写法、plan 第 0、13 步与实施记录

## 背景

Anthropic 发布了 Sonnet 5.5、Haiku 5.5。内置表现在五行（`packages/kernel/src/provider/definitions/anthropic.ts:95-238`）：Opus 5.5、Sonnet 5、Opus 5（更多模型）、Haiku 4.5、Fable 5.1。加这两行不只是填数据，现有形状有三处接不住：

1. **价格分档**。Haiku 5.5 按单次请求的提示长度分两档（F11）；`ModelInfo.pricing`（types.ts:48-56）只有一组单价。完整的 `ModelInfo` 按哈希冻结进 Tape（`view/content(model_info)`，tape/provenance.ts:206；testing/attempt-recheck.ts:157 读回），评测按冻结的价格算费用（apps/desktop/evals/cost.ts:4-7），所以分档要进 `ModelInfo`，是对 01 契约的修补。
2. **关思考的写法**。Sonnet 5.5 关思考不收 `disabled`，要发 `between_tools`（F13）；Anthropic 编码器关思考只会写 `{ type: 'disabled' }`（anthropic-messages.ts:308-313）。Tenon 只在摘要请求里关思考（compaction.ts:27-42；02 §摘要请求「思考参数」）。这个请求不带 tools，按 F13，`between_tools` 在不带 tools 的请求上只回正文。
3. **采样守卫**。厂商写明：表里全部 `samplingDefaultsOnly` 的行（两新行在内）`top_p` 默认 0.99，`top_p` 为 1 是 400，`temperature` 与 `top_p` 同发是 400，都是默认值也一样（F14；Haiku 5.5 迁移页另有同样的写法，F6）。守卫（wire/shared.ts:225-241）只拒小于 0.99 的 `top_p`（:238），不查同发。

另外，Haiku 4.5 在 02 §开工前裁决 A16 的「推迟到」一栏里：「Haiku 4.5 有弃用公告后撤行」。2026-10-15 核查没有公告（F15）；它和 Sonnet 5 都已被厂商列为 Legacy（F16）。

还有一件事是 owner 2026-10-15 定的规则「跟随最新」。现在模型菜单的位置逐行手写（`listing`，02 §对 01-provider-and-tape 的修补 第 2 小节），新会话默认只能记具体的一行（`defaultModelByProfile`、`provider`，同节第 6 小节）。厂商每出一代，都要逐行改 `listing`，智谱的 GLM-4.6 至今还在主列表里；以后由 Tenon 自动写下的默认（presentation-r1 的第一把 key），也会停在写下时的那一行。规则三条：内置厂商的行按家族与代次自动排位；新会话的默认可以是「某家族最新的一代」；已经在跑的会话不换。见 §跟随最新。

## 事实与出处

2026-10-15 读一手页面（平台文档、定价页、弃用页、发布记录），只收下表。没核到的不写进本 spec 和代码，或放进 §开放问题。代码注释照 anthropic.ts:67-94 的写法引 URL 与读的日期。页面都在 `https://platform.claude.com/docs/en/` 下，表里只写路径。「迁移页」指 `models/haiku-5-5/migration-guide`；「Sonnet 5.5 迁移页」指 `models/sonnet-5-5/migration-guide`，prefill 报错原文和 display 默认值的表都在这一页。

| # | 事实 | 出处 | 原文 |
|---|---|---|---|
| F1 | Haiku 5.5 的 id 是 `claude-haiku-5-5`，无日期后缀、无别名 | `models/haiku-5-5/migration-guide` | "`claude-haiku-5-5` is a fixed model ID with no date suffix and no separate alias." |
| F2 | Haiku 5.5：1M 窗口，同步输出上限 128K | `models/haiku-5-5/overview` | "Context window: 1M tokens · Max output: 128K tokens" |
| F3 | 两行都有 low 到 max 五档 effort；Haiku 5.5 默认 medium，Sonnet 5.5 默认 high | `build-with-claude/effort` | "Claude Haiku 5.5 supports all five effort levels, and `medium` is the default." / "Claude Sonnet 5.5 supports all five effort levels, and `high` is the default on the Claude API." |
| F4 | Haiku 5.5 默认开思考，不传 `thinking` 也可能以思考块开头；`disabled` 只在 high 及以下可发；发 `disabled` 时不能逐条改 effort；预算式 400 | `build-with-claude/effort`；迁移页 | "Adaptive thinking is on by default, so a response can begin with one or more `thinking` blocks even when the request doesn't set `thinking`." / "You can also send `thinking: {"type": "disabled"}` at `high` effort or below. At `xhigh` or `max`, it returns a 400 error" / "…on Claude Haiku 5.5 with `thinking: {"type": "disabled"}`, effort can't change mid-conversation: a per-message `output_config.effort` that differs from the level in effect returns a 400 error." / "A `thinking` value of `{"type": "enabled", "budget_tokens": N}` returns a 400 error" |
| F5 | Haiku 5.5 的 display 默认 omitted，要摘要得设 `display` | 迁移页 | "By default, Claude Haiku 5.5 returns each `thinking` block with an empty `thinking` field and only a `signature`, where Claude Haiku 4.5 returned summarized thinking. To receive summarized thinking, set `thinking: {"type": "adaptive", "display": "summarized"}`." |
| F6 | Haiku 5.5 只收采样参数的默认值 | 迁移页 | "If a request includes `temperature`, it must be `1`. If it includes `top_p`, it must be `0.99`, its default. Any other `temperature` or `top_p` value returns a 400 error, including a `top_p` of `1`. So does any `top_k` value, and so does a request that includes both `temperature` and `top_p`." |
| F7 | 两行都拒 assistant 预填 | 迁移页；Sonnet 5.5 迁移页 | "Claude Haiku 5.5 rejects it with a 400 error, even with thinking turned off." / "This model does not support assistant message prefill. The conversation must end with a user message." |
| F8 | Haiku 5.5 会拒答，按 `stop_details.category` 分四类：`cyber`、`frontier_llm`、`bio`、`general_harms`（没有 `reasoning_extraction`），从 Haiku 4.5 迁来是新行为；没有服务端 fallback（Sonnet 5.5 有 beta 版，见 F17；Tenon 不发 `fallbacks`） | 迁移页；`build-with-claude/prompt-engineering/prompting-claude-haiku-5-5` §Safeguard refusals | "Claude Haiku 5.5 runs safety classifiers that can decline a request, and it has no server-side fallback." / "A declined request returns a response with `stop_reason: "refusal"`, and `stop_details.category` names the refusal category: `cyber` … `frontier_llm` … `bio` … `general_harms`: the request falls under a usage-policy area other than the three above." / "If you're moving from Claude Haiku 4.5, these refusals are new." |
| F9 | 两行的思考块绑账号；另有前缀校验 | `build-with-claude/preserved-thinking` | "Thinking blocks that Claude Sonnet 5.5 or Claude Haiku 5.5 produces work only in the account that produced them, or in an account linked to it. When another account sends one of these blocks, the API drops the block before the model sees it, and the request succeeds." / "On Claude Fable 5.1, Claude Opus 5.5, Claude Sonnet 5.5, and Claude Haiku 5.5, a thinking block stays valid only while everything you sent before it is unchanged"（2026-08-31 00:00 UTC 及以后建的账号默认强制；更早的账号只在设了 `prefix_mismatch_behavior` 时强制，要带 `thinking-binding-controls-2026-08-01` 头） |
| F10 | Haiku 5.5 收强制 `tool_choice`；Sonnet 5.5 不收 | 迁移页；`models/sonnet-5-5/whats-new-sonnet-5-5` | "Claude Haiku 5.5 accepts a forced `tool_choice` (`any` or a named tool), but the response starts with the tool call and has no `thinking` block." / "tool_choice: type "tool" and "any" are not supported for this model." |
| F11 | Haiku 5.5 按提示长度分两档计价（USD/MTok）：不超过 100 000 token 时输入 0.10、输出 0.50、缓存读 0.01、5 分钟缓存写 0.125；超过时输入 0.50、输出 2.50、缓存读 0.05、5 分钟缓存写 0.625。提示长度含缓存读写，每个请求单独算 | `models/haiku-5-5/overview`；`about-claude/pricing` | "Claude Haiku 5.5 is priced by prompt length: a request whose prompt is over 100,000 tokens pays higher prices." / "A request's prompt length counts all of its input tokens, including cache reads and cache writes. Each request is priced on its own" / "Cache read \| $0.01 / MTok for prompts up to 100,000 tokens; $0.05 / MTok for prompts over 100,000 tokens"（1 小时缓存写 0.20 / 1，Tenon 只用 5 分钟档，02 01 修补 3） |
| F12 | Sonnet 5.5：id `claude-sonnet-5-5`，1M / 128K，$2 / $10，5 分钟缓存写 $2.50，缓存读 0.05 × 输入价 = $0.10（2026-10-07 起，此前是 $0.20）；默认开思考（自适应），display 默认 omitted；退役不早于 2027-09-28 | `models/sonnet-5-5/overview`；`about-claude/pricing`；`release-notes/overview`（2026-10-07 条）；Sonnet 5.5 迁移页的表格 | "Context window: 1M tokens · Max output: 128K tokens · Input pricing: $2 / MTok · Output pricing: $10 / MTok" / "Cache hits and refreshes on Claude Opus 5.5 and Claude Sonnet 5.5 are priced at 0.05x the base input price." / "We've lowered the price of prompt cache reads on Claude Sonnet 5.5 from $0.20 USD to $0.10 USD per million tokens" / 迁移页表格的 Claude Sonnet 5.5 一行："On" · "`"adaptive"`, `"between_tools"`" · "`"omitted"`"（三列依次是 "Thinking without a `thinking` field"、"`thinking.type` values accepted"、"Default `display`"） |
| F13 | Sonnet 5.5 关思考：发 `disabled` 是 400（报错指向 `between_tools`），要发 `between_tools`；只在 high 及以下；不能带别的键；不带 tools 时只回正文，带 tools 时工具调用之间的进度说明仍以思考块返回；预算式 400；用 `between_tools` 时不能逐条改 effort | `models/sonnet-5-5/whats-new-sonnet-5-5` | "On Claude Sonnet 5.5, a request that sends `thinking: {"type": "disabled"}` returns a 400 `invalid_request_error` whose message points to `between_tools`." / "`between_tools` is accepted at `low`, `medium`, and `high` effort. At `xhigh` or `max` effort, a request with `between_tools` returns a 400 error." / "`between_tools` takes no other field: `display`, `budget_tokens`, or `block_binding` sent with it returns a 400 error." / "The short progress updates the model writes between tool calls still come back as `thinking` blocks with their summary text." / "If your requests don't use tools, the response contains only text, as with `disabled` on Claude Sonnet 5." / "Manual thinking budgets (`thinking: {"type": "enabled", "budget_tokens": N}`) return a 400 error." / "With `between_tools`, effort can't change mid-conversation: a per-message `output_config.effort` that differs from the level in effect returns a 400 error." |
| F14 | 内置表里 `samplingDefaultsOnly` 的六行（Opus 5.5、Opus 5、Sonnet 5.5、Sonnet 5、Fable 5.1、Haiku 5.5）采样规则相同：非默认值 400，开不开思考都一样；`top_p` 默认 0.99，所以 `top_p` 为 1 是 400；`temperature` 与 `top_p` 同发是 400，都是默认值也一样。Haiku 4.5 只在开思考时受限 | `build-with-claude/thinking` §Limits and feature compatibility › Sampling parameters；`models/sonnet-5-5/overview` | "On Claude Fable 5.1, …, Claude Opus 5.5, Claude Opus 5, …, Claude Sonnet 5.5, Claude Sonnet 5, and Claude Haiku 5.5, non-default `temperature`, `top_p`, or `top_k` values return a 400 error on every request, regardless of whether thinking is used. On these models, the `top_p` default is `0.99`, so a `top_p` of `1` returns a 400 error, and so does a request that includes both `temperature` and `top_p`, even at their defaults." / "On older models, the restriction applies only while thinking is on" / Sonnet 5.5 概览页："Setting `temperature`, `top_p`, or `top_k` to a non-default value returns a 400 error." |
| F15 | Haiku 4.5 没有弃用公告；「不早于 2026-10-15」只是下限；退役前至少提前 60 天通知 | `about-claude/model-deprecations` | "\| claude-haiku-4-5-20251001 \| Active \| N/A \| Not sooner than October 15, 2026 \|" / "providing at least 60 days' notice before model retirement for publicly released models."（弃用历史最新一条是 2026-09-30 的 Sonnet 4.5，Tenon 表里没有这一行；Haiku 5.5 退役不早于 2027-10-07） |
| F16 | Sonnet 5、Haiku 4.5 已是 Legacy（与 Opus 5 同列）。Legacy 指不再更新、以后可能弃用，不等于弃用；弃用页上两行的状态仍是 Active | `models/overview`；`about-claude/model-deprecations` | "Legacy models (still available): … Claude Opus 5, … Claude Sonnet 5, … Claude Haiku 4.5." / "**Legacy:** The model will no longer receive updates and may be deprecated in the future." |
| F17 | Sonnet 5.5 的拒答按 `stop_details` 分五类：cyber、bio、frontier_llm、reasoning_extraction、general_harms；有 beta 版服务端 fallback（`fallbacks: "default"`，回退到 Sonnet 5） | `models/sonnet-5-5/whats-new-sonnet-5-5` | "The model's safeguards can decline a request in five `stop_details` categories. `"cyber"` means … `"bio"` means … `"frontier_llm"` means … `"reasoning_extraction"` means … `"general_harms"` means it falls under another usage-policy area." / "Server-side fallback (`fallbacks: "default"`, in beta, on the Claude API) retries `"cyber"` and `"frontier_llm"` declines on Claude Sonnet 5." |
| F18 | Sonnet 5.5 收 `display: "summarized"`；两行都收图片输入（vision） | Sonnet 5.5 迁移页；`models/overview`；`models/haiku-5-5/overview`；`models/sonnet-5-5/whats-new-sonnet-5-5` | "To get readable summaries, set `display: "summarized"`" / "With adaptive thinking, set `display` to … `"summarized"` to get them mixed with reasoning." / "All current models support text and image input, text output, multilingual capabilities, vision, and tool use."（同页表格的四列是 Fable 5.1、Opus 5.5、Sonnet 5.5、Haiku 5.5）/ Haiku 5.5："Input → output \| Text and images → text" / Sonnet 5.5 的 Feature support 一节列了 "vision" |
| F19 | Sonnet 5.5 上，工具调用之间超过一两句的说明以 progress-update 思考块返回，默认 display 下文本为空 | Sonnet 5.5 迁移页 | "On Claude Sonnet 5.5, notes longer than a sentence or two that the model writes between tool calls come back as progress-update `thinking` blocks, empty at the default `display`. Shorter remarks stay `text`." / "No request fails, but an interface that shows those notes goes quiet." |
| F20 | 两行的最小可缓存提示长度是 512 token | `models/sonnet-5-5/whats-new-sonnet-5-5`；`models/haiku-5-5/overview` | "prompt caching with a 512-token minimum cacheable prompt" / "The minimum cacheable prompt length is 512 tokens." |
| F21 | 工具调用的输入流式返回，不分型号：`tool_use` 的输入以 `input_json_delta` 的片段逐段到达；细粒度工具流式所有模型都支持 | `build-with-claude/streaming` §Input JSON delta；`agents-and-tools/tool-use/fine-grained-tool-streaming` | "The deltas for `tool_use` content blocks correspond to updates for the `input` field of the block. To support maximum granularity, the deltas are *partial JSON strings*, whereas the final `tool_use.input` is always an *object*." / "All models support fine-grained tool streaming on the Claude API, …" |

**更正，不采信**：

- 周报建议把 Haiku 5.5 的 `defaultDisplay` 写作 `'summarized'`，与 F5 矛盾，本 spec 取 `'omitted'`（与 Opus 5.5、Sonnet 5 等行一致，只有 Haiku 4.5 是 `'summarized'`）。
- 一份非一手材料写 Sonnet 5.5 缓存读 $0.20：那是 2026-10-07 降价之前的官方价（`release-notes/overview`），现价 $0.10（F12），取 $0.10。

**没核到，不写**：眼下没有。拒答分类：两行见 F8、F17，都不解码（非目标）。

## 目标与非目标

### 目标

1. anthropic 内置表加 `claude-sonnet-5-5`、`claude-haiku-5-5` 两行，取值见 §内置模型表的数据改动。
2. `pricing` 能表达按单次请求提示长度分档，评测费用按档算。
3. `ThinkingSpec` 能表达「关思考写 `between_tools`」，Sonnet 5.5 上的摘要请求合法。
4. 采样守卫按 F6、F14 拒绝，用在所有 `samplingDefaultsOnly` 的行上。
5. Haiku 4.5：写清现状和公告之后怎么做。
6. 跟随最新：anthropic、智谱的内置行带家族与代次，菜单位置由它们算出；新会话默认可以指向某家族最新的一代；运行中的会话不因新一代上架或默认改动而换模型。

### 非目标

- 界面显示单价或费用。现在 `pricing` 只有评测读（cost.ts），本 spec 不加界面。
- 逐条消息改 effort（02 A13 不用）、1 小时缓存档、Message Batches 与 300K 输出 beta、服务端 fallback（F17）、拒答分类解码（02 §开放问题「以后再评估」）。
- 改 Opus 5.5、Sonnet 5、Opus 5、Haiku 4.5、Fable 5.1 与智谱四行的能力、价格与思考数据。动到的只有：各行加 `family`、`generation`；由此算出的 `listing`（Sonnet 5、Haiku 4.5、GLM-4.6 变 `'more'`）；Opus 5 去掉手写的 `listing`（改由算出，值不变）；Sonnet 5、Haiku 4.5 的用途句（locale 的值）；注释。开放问题 3 定 A，不改这四行的数据，改的是守卫对它们的读法（§点名 (a)）。
- **自动使用厂商新发布、Tenon 还没适配的模型。** 指针只在本构建的内置表里找最新一代，新一代要等 Tenon 的某个版本加了它的行才算数；也不去厂商的模型列表接口拉新 id。理由：每个模型有自己的规则，本 spec 加两行就碰到了采样（F6、F14）、强制 `tool_choice`（F10）、价格分档（F11）、关思考的写法（F4、F13），没核过就发，轻则 400，重则费用算错、请求快照与响应对不上。表外 id 照旧保守处理（02 §表外模型与不发工具：保守合成、只能纯文字、标「未验证 · 仅文字对话」）。
- Ollama 与自定义厂商分家族。模型名是 Ollama 或用户起的，Tenon 排不出代次；它们的行照旧按手写的 `listing`（缺省为主列表），默认照旧记具体的一行。
- Bedrock、Google Cloud 的模型 id 与时间表。

## 跟随最新

owner 2026-10-15 的规则，管所有内置厂商（anthropic、智谱），不管 Ollama 与自定义厂商。

### 家族与代次

- anthropic、智谱的每个内置行带 `family`（家族名，小写 ASCII）与 `generation`（代次，`[主, 次]`）。比代次先比主、再比次，大的新。同一个定义里，同一家族的两行代次不能相同。
- 今天的行：

| 厂商 | 家族 | 行（代次） |
|---|---|---|
| anthropic | `opus` | `claude-opus-5-5`（[5, 5]）、`claude-opus-5`（[5, 0]） |
| anthropic | `sonnet` | `claude-sonnet-5-5`（[5, 5]）、`claude-sonnet-5`（[5, 0]） |
| anthropic | `haiku` | `claude-haiku-5-5`（[5, 5]）、`claude-haiku-4-5-20251001`（[4, 5]） |
| anthropic | `fable` | `claude-fable-5-1`（[5, 1]） |
| 智谱 | `glm` | `glm-5.3`（[5, 3]）、`glm-4.6`（[4, 6]） |
| 智谱 | `glm-flash` | `glm-5.3-flash`（[5, 3]） |
| 智谱 | `glm-flashx` | `glm-5.3-flashx`（[5, 3]） |

- 怎么分：同一条产品线、名字只差代号的算一个家族。GLM-5.3 Flash、FlashX 与 GLM-5.3 的价格和速度档不同（zhipu.ts 各行的 `pricing`），各算一个家族；并进 `glm` 的话，GLM 出新代时 Flash 会被挤进「更多模型」。
- Ollama 行、自定义实例行、合成行（开发期回落、手填 id）不带这两个键。

### 菜单自动排位

- `listing` 在构建表时算：定义模块加载时、表冻结之前，由 `definitions/models.ts` 新加的一个纯函数算好写进行里，不在 `provider.list` 现算。带家族的行：本家族里代次最大的那行不写 `listing`（缺省即 `'main'`），其余写 `'more'`。不带家族的行照旧手写（缺省 `'main'`）。带家族的行手写了 `listing`、同家族两行代次相同、只有 `family` 没有 `generation`（或反过来），模块加载时就抛错。
- 算好的值就在 `ModelInfo.listing` 里，`provider.list` 照旧转发 `model.listing ?? 'main'`（provider-routes.ts:434），菜单代码不用动。
- 对哈希的影响：`family`、`generation` 进 canonical JSON，anthropic 七行与智谱四行的 `modelInfoHash` 全变；Sonnet 5、Haiku 4.5、GLM-4.6 另多 `listing: 'more'`；Opus 5 的 `'more'` 由手写变成算出，值不变。三个键都不在 `WIRE_MODEL_FIELDS`，`modelWireHash` 与编码字节不因它们变，复核不会因此得 `model-table-changed`。新会话冻结新的 `view/content(model_info)`；旧 Tape 里的副本不动，续跑仍用它（02 §续跑），里面的 `listing` 是旧值，不影响任何行为：只有菜单读 `listing`，菜单读的是 `provider.list`，不读 Tape。
- 定义的第一行仍是新用户的兜底（02 M5、A16），所以它必须是本家族最新的一代，否则会被算成 `'more'`。anthropic 第一行 `claude-opus-5-5`、智谱第一行 `glm-5.3` 都满足。
- 行序：每个家族最新的一代在前，旧的在后，两段的家族顺序相同。智谱的表本来就是这样；anthropic 改为 `claude-opus-5-5`、`claude-sonnet-5-5`、`claude-haiku-5-5`、`claude-fable-5-1`、`claude-opus-5`、`claude-sonnet-5`、`claude-haiku-4-5-20251001`。菜单（两家都已配置；第二行的主机照 02 与 presentation-r1，图里省略）：

```
Anthropic
  Opus 5.5          适合复杂的长任务
  Sonnet 5.5        速度与能力兼顾
  Haiku 5.5         成本最低
  Fable 5.1         需要组织或工作区开启 30 天数据保留
智谱
  GLM-5.3           智谱 GLM-5.3
  GLM-5.3 Flash     轻量，适合日常使用
  GLM-5.3 FlashX    轻量，响应更快
Ollama
  qwen3:8b          本机 · 仅文字对话          ← 不分家族，照旧
更多模型 ›
  Opus 5            上一代 Opus（旧版）
  Sonnet 5          上一代 Sonnet（旧版）
  Haiku 4.5         上一代 Haiku（旧版）
  GLM-4.6           上一代 GLM
  每个已配置厂商一个「手填模型 ID…」
```

### 新会话默认：指针

- config.json 里的三个默认（`defaultModelByProfile.chat`、`.cowork`、`provider`，形状都是 `providerSelectionSchema`）各自可以是：
  - **钉住**：`{ id, modelId }`，手填的另带 `source: 'user'`。和今天一样。
  - **指针**：`{ id, modelId, latestOf }`。`latestOf` 是家族名，读作「`id` 这家 `latestOf` 家族最新的一代」；`modelId` 是写下时它解析到的那一行。本构建解析时不看 `modelId`（下面「解析」第 4 条除外）；它留给不认识 `latestOf` 的旧构建：zod 默认剥掉未知键，旧构建把它读成钉住的 `modelId`。

  例：`"defaultModelByProfile": { "chat": { "id": "anthropic", "modelId": "claude-opus-5-5", "latestOf": "opus" } }`
- 只有主进程写 `latestOf`，只写在内置的 anthropic、智谱上，从不与 `source` 同写。手改出来的同写，或 `latestOf` 写在 Ollama、实例上，都读作钉住，不看 `latestOf`。`latestOf` 不是非空字符串的（空串、数字等），解析时只丢这一个键（`.catch(undefined)`，§对 01 的修补），这个值照样读作钉住；不会因为它丢掉整个 `defaultModelByProfile` 或 `provider`（config.json 逐字段校验，一个字段坏了丢整个字段，apps/desktop/src/main/host/profile.ts 的 `fieldwise`）。

### 解析

五层（02 第 6 小节「五层解析」）的顺序与各层不变。①（本会话的选择）不受影响，永远是具体的一行。①空着时：

1. **会话不换**：本代（incarnation）已有 Run 时，按 `previousModel`（上一个 Run 的 provider、模型 id 与 `capabilitySource`，都取自它的 `session/model_selected`）判断，下面两种就用那一行，不看答话的是哪一层、是不是指针（下一节）：
   - `builtin`、`probed` 的行，以及早期没记 `capabilitySource` 的行：还在那家厂商的表里（内置表、Ollama 的行、实例的行）。实例上没探测过的行记的是 `user`（run-assembly.ts 的 `instanceRange`），同样要还在实例的表里：实例没有手填 id，也不做保守合成（M6）。
   - 内置厂商（anthropic、智谱、Ollama）上的 `user`，即手填的 id：照 02「表外模型手填」保守合成（只能纯文字），`capabilitySource` 仍记 `user`。Ollama 内置表只有 `qwen3:8b` 一行，用别的本地模型都得手填。

   `synthesized`（开发变量或别的不是用户手填的表外 id，保守合成）不适用，照 02 读默认。不然往下。
2. **哪些算指针**：答话的一层是 ② 或 ③ 且带 `latestOf`。④ 与 ⑤ 照 02 给某厂商表的第一行，不读作指针：第一行一定是本家族最新的一代（上一节），读作指针也是同一行。
3. **最新一代**：在该厂商本构建的内置表里，取 `family === latestOf` 的行里代次最大的那行（kernel 的 `newestOfFamily`）。带家族的行都是 `verified`，对话、任务两种形态都能用，不另挑。
4. **找不到**：`latestOf` 在本构建的表里没有行（以后的构建删了整个家族，或文件被手改），这一层读作钉住的 `modelId`，与旧构建的读法相同；`modelId` 也不在表里，照 02 §表外模型与不发工具（保守合成、只能纯文字）。不跳到别的家族、别的厂商。
5. **厂商没配置**：指针照样解析到那家最新的一代，发送照 02 按缺 key 拒绝（presentation-r1 落地后由输入框「发不了的原因」说明），不跳到别的已配置厂商：换厂商就是换数据去向，要由用户来选。

`capabilitySource`：指针解析出的行记 `builtin`；第 1 条留下的行照 02 按那一行算。`session.modelChoice` 与 Run 开始时用同一套解析：kernel 的 `effectiveModelChoice` 只多交 `previousModel`，与 Run 开始时取自同一个 `SessionFacts.lastSelected`；`previousOrigin` 仍为 null（它只读下一个 Run 会用哪一行，不做数据去向检查，拿到 `needsConfirm` 会抛错，mailbox.ts 的 `effectiveModelChoice`）。所以菜单触发器显示的就是下一个 Run 用的行，会话不换留下的行地址改到公网时也照常显示它。

### 会话不换

- owner 的规则：新一代只给新会话，已经在跑的会话不跟着换。理由三条：思考块绑模型（02 守卫规则 2 丢掉别的模型产生的思考块，换了模型，历史里的思考就带不过去）；提示缓存按模型分，换模型等于整段重写缓存；新一代的行为不同，做到一半的事会变样。第三轮评审指出，只管新一代上架是收窄：用户在设置卡里改默认、或在别的会话的菜单里选模型（02 第 6 小节，菜单每选一次都改写 `defaultModelByProfile[形态]` 与 `provider`），没选过模型的会话下一条消息照样换掉，三条理由一样成立。owner 2026-10-15 定「都按推荐来」：不论默认怎么变，运行中的会话都不换；默认的改动只影响新会话、清空之后，以及下面「什么时候还会换」列的几种会话（§点名 (f)；没选的读法见 §被否决的方案）。
- 怎么记：不加 Tape 事实。每个发请求的 Run 本来就写 `session/model_selected`，记具体的 provider 与模型 id（02 §会话事实）；会话第一个 Run 把默认解析成具体一行，这一条就是它的记录。之后每个 `user-message`、`continue` 的 Run 照 02 重新解析，kernel 在问询里多交一个 `previousModel`（本代最后一个 `model_selected` 的 provider、模型与 `capabilitySource`），连接器按「解析」第 1 条留在那一行。`resume` 与子会话照 02 沿用暂停前或父 Run 的模型，本来就不解析。
- 上一个 Run 的厂商后来没 key 了，也留在那一行，发送照 02 按缺 key 拒绝，不跳到别的厂商（同「解析」第 5 条）。
- 什么时候还会换：
  - 「清空」开了新一代：没有 `previousModel`，照默认解析（指针取最新一代），与新会话相同（02「清空会话后回落到默认」）；
  - 上一个 Run 用的行不在表里了（内置行撤掉，见 §Haiku 4.5；Ollama 或实例的行没了；实例被删）：照 02 读默认，默认是指针时取那一家最新的一代，数据去向照 02。连接器手里只有 provider、模型 id 与 `capabilitySource`，不知道撤掉的行原来属于哪个家族，所以不去找「同家族最新一代」；
  - 上一个 Run 用的是 `synthesized` 的 id（开发变量等）：照 02 每个 Run 读默认。手填的 id 不在此列（「解析」第 1 条）；
  - 用户在菜单里给这个会话选了模型：① 生效，照 02。
- 本 spec 之前开始的会话同样适用：它们的 `model_selected` 已在 Tape 里，不用迁移。升级之后，没选过模型的旧会话也留在上一个 Run 的行上，不再随默认改动。

### 数据去向

确认照 02 §模型选择「数据去向」，不新增也不跳过。连接器只在 ① 空着时做这个检查（02 §主进程与 kernel 的循环接口，`resolveChoice` 的注释「数据去向检查只在 sessionChoice 为 null（选择来自 ②–⑤）时做」），会话不换、指针解析与检查走同一条路，检查一直在取行之后：

- 会话不换留在原行：那一行的地址没变，就没有新的去向；地址改过（例如 Ollama 改到公网主机），照 02 从回环或私网切到公网时原地确认，确认之前对该主机 0 次请求。
- 指针解析出的行（新会话、清空之后、上一个 Run 的行不在表里）：同一厂商、同一主机不新增确认（anthropic、智谱只认官方源，custom-vendors Q8，同一厂商就是同一主机）；其余情形照 02。
- 02 §主进程与 kernel 的循环接口「间接切公网」规则不变，只是出现得更少：只在「什么时候还会换」列的那几种会话里，或原行的地址改到公网时出现。新会话没有历史，没有要确认的。

### 谁写指针

- **菜单**（02 第 6 小节「在模型菜单里选一次，同时写……」）：选主列表里带家族的行（即本家族最新一代），`defaultModelByProfile[形态]` 与 `provider` 写指针 `{ id, modelId: 那一行, latestOf: 它的家族 }`；选「更多模型 ›」里的行、手填的 id、Ollama 与实例的行，照 02 写钉住的值。本会话的选择（`session/model_choice_set`）永远记具体的一行。理由：主列表只放每个家族最新的一代，从那里选，读作「要这一家的当前一代」；菜单若一律写钉住的值，用户第一次在菜单里选模型就把指针换掉了，「跟随最新」形同虚设。这是推出的读法，§点名 (g)。
  - 例外：会话没有 ①，且这次选的 provider 与模型 id 就是写入前 `session.modelChoice` 答的那一行（只改思考档位、在 hold 的确认页点「切换」、或再点一次当前行），只写 ①，`defaultModelByProfile[形态]` 与 `provider` 都不写。理由：会话不换以后，会话所在的行可以不是默认那一行（升级前跑过的 Sonnet 5；用户在设置卡里改成钉住的 GLM 之后，旧会话仍在 Opus 5.5 上），只改档就把这一行写成新会话默认，等于悄悄撤掉设置卡里的选择；设置卡里钉住的「Opus 5.5」也会因为在会话里改一次档变成指针，与 §对 02 的修补 第 13 条相悖。在 02 里，没有 ① 的会话所用的行就是默认解析出的那一行，这一写不改本形态的默认结果，只会顺带把 `provider` 改成这一行；这个副作用随之没有了，一并记进 §点名 (g)。
- **设置卡**（02 §模型菜单与输入框「设置卡」）：anthropic、智谱卡的「新会话默认模型」下拉先列指针，每个家族一项，按主列表的顺序；再列表里的每一行（钉住），写显示名（model-display-names）。卡打开时，存着的默认属于这一家就选中它（指针选中指针项，钉住选中那一行）；不属于这一家，选中第一个指针项（旧：第一行）。保存照 02：只有改过下拉才写，写的仍是那三个键。选的是钉住的那一行，就存钉住的值，哪怕它在主列表、带家族；只有选指针项时请求才带 `latestOf`（§对 02 的修补 第 13 条）。Ollama 与实例的卡没有指针项。
- **第一把 key**（presentation-r1 §对 02 的修补（M5）第 1 条，核对基准 `c60760d`，见 `Related:`）：那一条自己按构建里有没有 `latestOf` 分两支写。「有」时，带家族的内置第一行写指针 `{ id, modelId: <第一行的 id>, latestOf: <它的家族> }`（anthropic 是 `opus`，智谱是 `glm`），值与菜单写的相同；「没有」时写钉住的行 id；实例的行照旧钉住。本 spec 不改那一条，只提供「有」一支要用的 `latestOf`（§对 01 的修补）与 `menuSelectionOf`（plan 第 9 步）。哪份后合入，就由哪份实现「有」一支：presentation-r1 先合入时，由本 spec plan 第 11 步实现，跑验收 19；本 spec 先合入时，由 presentation-r1 plan 第 9 步实现，跑它验收 12 的指针一例（与本 spec 验收 19 相同）。两种情形都是在实现它已写的规则，不改它的条文。

### 文案

- 家族显示名：定义只增 `familyNameKeys`（家族名 → 目录键），照 `nameKey` 由 kernel 作为数据给出、renderer 解析。新键 `model.family.opus`「Opus」、`model.family.sonnet`「Sonnet」、`model.family.haiku`「Haiku」、`model.family.fable`「Fable」、`model.family.glm`「GLM」、`model.family.glmflash`「GLM Flash」、`model.family.glmflashx`「GLM FlashX」，两份 locale 同值。
- 指针选项：`settings.providers.latest`，zh-CN「最新的 {family}（现在是 {model}）」，en "Latest {family} (now {model})"。`{family}` 填家族显示名，`{model}` 填它现在解析到的那一行的显示名（`nameKey`，model-display-names）；悬停提示是那一行的 id，同钉住选项的写法。例：「最新的 Opus（现在是 Opus 5.5）」「最新的 GLM Flash（现在是 GLM-5.3 Flash）」。
- 模型菜单与触发器不变：它们显示的是会话实际用的那一行。

### 迁移

- config.json 不改写，不加版本号。到 2026-10-15 为止，代码里写这三个键的只有菜单（apps/desktop/src/main/model-routes.ts:83）与设置卡的 `provider.select`（provider-routes.ts:271），都是用户自己的动作；custom-vendors 只会清掉它们（custom-vendors/store.ts:277）。所以现有的值都读作用户的选择，留着钉住。出厂兜底 ⑤ 本来就不存在文件里，照 02 给表的第一行，也就是本家族最新的一代。
- 设置卡把指针放在最前，用户随时可以改成「最新的 …」。
- presentation-r1 先合入时，它只实现第一把 key 的「没有」一支（写钉住的行 id）；从它合入到本 spec 合入（plan 第 11 步补上「有」一支）之间写下的值，与用户的选择分不出来，同样留着钉住（它 plan「与 claude-5-5-models 的先后」也这么写）。所以这种情形下两次合入之间不切 release 分支，这段时间只在开发构建里。本 spec 先合入时，presentation-r1 一实现就写指针，没有这段时间，也不受这条约束。
- 旧构建打开写了指针的文件：剥掉 `latestOf`，读作钉住的 `modelId`；它下一次写 config.json 时 `latestOf` 就丢了，之后读作钉住。与 M6 对 `customVendors` 的处理同类（configSchema 的注释，T8），不加 configVersion。

### 本 spec 自己定的细节

owner 的规则没写到、由本 spec 定的，owner 可以否决：家族的分法（Flash、FlashX 各成一家）；代次写成 `[主, 次]`；anthropic 的行序；指针解析不出时退回 `modelId`；上一个 Run 的行不在表里时照 02 读默认；实例的行要还在实例的表里才留；`synthesized` 的 id（开发变量等）不适用会话不换；厂商没配置时不跳（上一个 Run 的厂商没 key 了也留着）；菜单写指针、只改档不写默认（§点名 (g)，owner 2026-10-15 经问卷确认 A）；设置卡没存这一家的默认时选中第一个指针项。运行中的会话也不随用户改默认而换，是 owner 2026-10-15 在第三轮评审后定的（§跟随最新「会话不换」），不在本节；内置厂商上手填的 id 也留着，是照这条规则写的，不是另定的细节。

## 对 01 的修补

01 已 `implemented`。下面全部只增，读法照 02 §对 01-provider-and-tape 的修补 第 1 小节：给既有对象类型加可选键算新增成员。标「已存在」的只为定位。

```ts
// packages/kernel/src/provider/types.ts
export interface ModelInfo {                     // 已存在（types.ts:28）
  pricing?: {                                    // 已存在（types.ts:48-56），已有成员不变
    /** 新增：按单次请求的提示长度分档（开放问题 2）。缺省 = 不分档，02 的算法一字不变 */
    longPrompt?: {
      /** 这次请求的提示长度严格大于它时，这次请求的全部用量按本档计价 */
      overTokens: number
      inputPerMTok: number
      outputPerMTok: number
      cacheReadPerMTok?: number
      cacheWritePerMTok?: number
    }
  }
  /** 新增：家族名（§跟随最新）。只在 anthropic、智谱的内置行上；encode() 不读，不进 WIRE_MODEL_FIELDS */
  family?: string
  /** 新增：代次 [主, 次]，先比主、再比次，大的新。与 family 同有同无；不进 WIRE_MODEL_FIELDS */
  generation?: readonly [number, number]
}

export interface ThinkingSpec {                  // 已存在（types.ts:108；02 的 01 修补 2）
  /**
   * 新增（开放问题 1）：关思考时 Anthropic 线写 { type: 'between_tools' }。缺省 = 写 'disabled'，即 02 的行为。
   * 只许写在带 disableMaxEffort 的 adaptive-gated 行上（F13）。'disabled' 不是它的取值：
   * 显式写出的键会进 canonical JSON，编码一个字节不变，modelWireHash 却变了
   */
  offType?: 'between_tools'
}

export interface ProviderDefinition {            // 已存在（types.ts:254）
  /** 新增：家族名 → 家族显示名的目录键（照 nameKey，kernel 不出句子）。表里出现的每个家族都有一项 */
  familyNameKeys?: Readonly<Record<string, string>>
}
```

```ts
// 01 §desktop 接线：config.json 的 provider 与 provider.select（02 的 01 修补 6 把形状定为 providerSelectionSchema）
providerSelectionSchema = z.object({ id, modelId, source: z.literal('user').optional(),   // 已存在（config.ts:17）
  latestOf: z.string().min(1).optional().catch(undefined) })  // 新增：指针（§跟随最新「新会话默认：指针」）；
                                                // 坏值只丢这一个键，其余照读（不连累整个字段）
provider.select 的请求 = z.object({ providerId, modelId,                                     // 已存在（provider.ts:204）
  latestOf: z.string().min(1).optional() })     // 新增：存成指针，规则见 §对 02 的修补 第 13 条
```

- **提示长度**：一次请求的全部输入 token，含缓存读与缓存写（F11）。按 `Usage` 算：anthropic-messages 线是 `inputTokens + cacheReadTokens + cacheWriteTokens`，openai-chat 线是 `inputTokens`（已含缓存）。与 cost.ts 的 `inputTotalOf`、02 §压缩时机与估算的「输入总量」同一口径。
- 档内缺缓存单价的，按本档的输入价计（照 02 §记录格式与费用口径「缺缓存单价的按输入价计」）。币种随 `pricing.currency`，档内不另设。
- `longPrompt`、`family`、`generation` 不进 `WIRE_MODEL_FIELDS`（`pricing`、`listing` 本来就不在）。`offType` 在 `thinkingSpec` 里，随它进 `modelWireHash`。缺省的键不出现在 canonical JSON 里，所以没写 `offType` 的行，`modelWireHash` 不变；`family`、`generation` 改变的只是 `modelInfoHash`（§跟随最新「菜单自动排位」）。
- `offType` 只有 anthropic-messages 线读。表规则：写它的行必须是 `adaptive-gated` 且带 `disableMaxEffort`。F13 说 `between_tools` 只在 high 及以下合法，而只有这一模式会在本地查档位（`assertMayDisable`）。表写错时编码器在运行时拒绝，照 effort-only 一支（anthropic-messages.ts:286-292）与 `assertMayDisable`（:326-341）的既有写法：`budget`、`adaptive` 行上有 `offType` 时，关思考抛 `ProviderInvalidArgumentError`、不触网，不让 xhigh、max 的 `between_tools` 不经检查发出去拿 400。`always-on`、`effort-only` 的行关思考本来就本地拒绝，写 `offType` 也是表错误。definitions 测试断言内置行守这条，thinking-shapes 测试用合成行测运行时拒绝。
- `family`、`generation` 的表规则与 `listing` 的算法见 §跟随最新「家族与代次」「菜单自动排位」；`familyNameKeys` 要覆盖表里出现的每个家族，键在两份 locale 里都有（copy-coverage 测试）。

## 对 02 的修补

02 已 `implemented`，正文不改，下面每条只增一句读法。「第 N 小节」指 02 §对 01-provider-and-tape 的修补 的第 N 小节。第 1–5 条是两新行要的，第 6–14 条是「跟随最新」要的。

1. **第 3 小节「Anthropic 线的 thinking 编码四分支」的 `{ enabled: false }` 一支**：adaptive-gated 行写出的对象是 `{ type: offType ?? 'disabled' }`；budget、adaptive 行照旧写 `{ type: 'disabled' }`，行上有 `offType` 时本地拒绝（§对 01 的修补）。`between_tools` 和 `disabled` 一样不带任何别的键（F13）；`display` 照旧只在思考开着时写，所以这里不用新加拒绝。adaptive-gated 的档位上限照旧由 `disableMaxEffort` 管（`assertMayDisable`，anthropic-messages.ts:326）。另加一条本地拒绝：`offType` 为 `between_tools` 的行，`thinking: { enabled: false }` 且 `tools` 非空时，抛 `ProviderInvalidArgumentError`，不触网。理由是带工具时响应里仍有 thinking 块（工具调用之间的进度说明，F13），快照却记成「关」，和响应形状不符。Sonnet 5.5 迁移页给的 400 报错原文也是这么说的："The model does not think before responding. The short updates it writes between tool calls come back as thinking blocks."。现有调用方里只有摘要请求关思考，它不带 tools（02 §摘要请求），所以眼下碰不到这条拒绝。以后要在带工具的请求里关思考，另写 amend，定清楚这种请求在 Tenon 里算什么。请求快照照旧记所请求的 `thinking: { enabled: false }`；attempt 复核用冻结的 `model_info` 重编，`offType` 就在里面，字节对得上。
2. **第 3 小节「`samplingDefaultsOnly` 的行……本地拒绝」与第 2 小节 `samplingDefaultsOnly` 的注释（02:689）**：所有 `samplingDefaultsOnly` 的行，在原有拒绝之外，`top_p` 不等于 0.99 的拒（原来只拒小于 0.99），`temperature` 与 `top_p` 同在一个请求里的也拒，都是默认值也拒（F14）。这改了 02 写定的值，见 §点名 (a)。`temperature` 来自请求，`top_p` 来自 `requestParams`，与 shared.ts:225-241 的来源相同。照旧抛 `ProviderInvalidArgumentError`，不触网。
3. **编码器版本**：anthropic-messages 编码器 3 → 4（01 修补 7「凡改变编码结果的提交都加一」；先例是 M6 给 openai-chat 加 `maxTokensField` 时 1 → 2）。没写 `offType` 的行编出的字节不变。采样拒绝变多不改任何写出的字节，不另加版本。openai-chat 编码器不变，仍是 2。
4. **§记录格式与费用口径「费用与用量」第一条**：冻结的 `pricing` 带 `longPrompt`，且这次 attempt 的提示长度大于 `overTokens` 时，四项用量都乘本档单价；否则照旧。
5. **§摘要请求的「思考参数」表**：不改。两新行都是 `adaptive-gated`，照表那一行传 `{ enabled: false }` 与 `effort: disableMaxEffort`（即 `high`）；Sonnet 5.5 由编码器写成 `between_tools`。摘要请求不带 tools，按 F13 只回正文，和 02 在 Sonnet 5 上发 `disabled` 的效果相同。
6. **第 2 小节 `ModelInfo.listing`**（「模型菜单的归类，缺省 = 'main'」）：带 `family` 的行不手写，构建表时由家族与代次算出（§跟随最新「菜单自动排位」）；不带家族的行照旧手写。「定义的第一行不是 `'more'`」照旧。这是把原来没限定的「`listing` 怎么定」收紧成一条规则。
7. **第 6 小节 config.json**：`providerSelectionSchema` 只增 `latestOf`（§对 01 的修补 同一个成员），所以 `defaultModelByProfile.chat`、`.cowork` 与 `provider` 都可以是指针。三个键仍只由主进程写，不进 `configSetRequestSchema`。
8. **第 6 小节「五层解析」**：顺序与各层不变；① 空着时，先按 §跟随最新「解析」第 1 条留在上一个 Run 的行；不适用时，答话的一层是指针的，按同节第 2–5 条取行。这一条改了没选过模型的会话的结果，见 §点名 (f)。
9. **第 6 小节「在模型菜单里选一次，同时写……`defaultModelByProfile[形态]` 和 `provider`」**：选的是主列表里带家族的行时，这两处写指针，其余照旧写钉住的值；会话没有 ①、这次选的就是写入前 `session.modelChoice` 答的那一行时（只改档、确认「切换」、再点当前行），这两处都不写，只写 ①；会话的选择事实不变（§跟随最新「谁写指针」，§点名 (g)）。
10. **第 6 小节 `provider.list`** 的行（`providerModelSchema`，contracts provider.ts:84）只增 `family: z.string().min(1).optional()` 与 `familyNameKey: z.string().min(1).optional()`，两者同有同无，取自 `ModelInfo.family` 与定义的 `familyNameKeys`；主进程照 `nameKey` 的方式转发（provider-routes.ts 的 `menuRow`）。Ollama 与实例的行没有。
11. **§主进程与 kernel 的循环接口**：`RunConnector.resolveChoice` 的问询只增可选的 `previousModel?: { providerId: ProviderId; modelId: string; capabilitySource?: ModelChoice['capabilitySource'] } | null`，即本代最后一个 `session/model_selected` 的 provider、模型与 `capabilitySource`（载荷里缺这个字段时不写），本代还没有 Run 时为 null，缺省按 null 读。可选是照 ports.ts 的冻结规则（「a host-implemented port only gains OPTIONAL members」，02 开放问题 26），已有的直接调用点不用改。kernel 从 Tape 读（`SessionFacts.lastSelected` 只增 `modelId` 与 `capabilitySource`，与读 `previousOrigin` 的是同一条），Run 开始（mailbox.ts:541）与 `effectiveModelChoice`（:3256）都总是交它；`effectiveModelChoice` 的 `previousOrigin` 照旧为 null。连接器只在 ① 空着时读它（§跟随最新「解析」第 1 条）。
12. **§模型选择「没选过模型的会话」**（「每个 Run 都读该形态的默认……这个默认会因为在别的会话里选模型而变」）：本代已有 Run、按 §跟随最新「解析」第 1 条留在上一个 Run 的行时，用那一行，不读默认；默认的改动只影响新会话、清空之后与 §跟随最新「会话不换」列的几种会话（§点名 (f)）。「何时解析」不变。
13. **§模型菜单与输入框「设置卡」与 `provider.select`**：下拉先列指针、再列各行，没存这一家的默认时选中第一个指针项（§跟随最新「谁写指针」）；「只有改动过这个下拉，保存时才写」与写哪三个键不变。`provider.select` 不带 `latestOf` 时照 02 写钉住的值，哪怕选的行在主列表、带家族（设置卡里列出的每一行都是钉住的选项）。带 `latestOf` 时：主进程按本构建的表算出该家族最新一行写进 `modelId`，三个键都写 `{ id, modelId, latestOf }`；`latestOf` 不在该厂商的表里、厂商是 Ollama 或实例、或请求里的 `modelId` 不是该家族的一行，都回 `invalid-value`（坏的是请求里的这个值；02 对内置厂商撤掉的 `unknown-model` 不重新启用，02 §对 01-provider-and-tape 的修补 第 6 小节「表外模型手填」）；被拒时 config.json 不动。
14. **§模型选择「数据去向」**：不改，读法见 §跟随最新「数据去向」。

## 对 model-display-names 的修补

已 `implemented`，正文不改，只增一句读法：

- model-display-names §对 02 的修补「设置卡」（「选项写同一个显示名，原始 id 作悬停提示」）：指针选项写「最新的 <家族>（现在是 <显示名>）」，悬停提示是它解析到的那一行的 id（§跟随最新「文案」）；钉住的选项照旧。

## 兼容

- **Tape**：旧 Tape 照读。续跑用冻结的 `model_info`（02 §续跑），费用用冻结的 `pricing`（cost.ts），结果都不变。编码器升到 4 以后，此前 anthropic-messages 线写下的全部 attempt 复核时都得 `not-covered / other-encoder`（attempt-recheck.ts:99），包括 Opus 5.5、Fable 5.1 的会话和 anthropic-messages 自定义实例，不再受 02 不变量 33 覆盖。M6 把 openai-chat 升到 2 时也是这样。「`encoder.version` 不同的旧记录怎么复核」是 02 §留到后续阶段「以后再评估」里的一项，本 spec 不做。不加 Tape 事实名；`model_selected`、`model_choice_set` 的载荷不变。
- **config.json**：本 spec 之前的文件原样读，值都读作钉住（§跟随最新「迁移」）。旧构建读写了指针的文件，见同一节。
- **custom-vendors**：不受影响，不算修补。实例的默认照旧是钉住的值；指针只写在内置厂商上，custom-vendors §写入规则「删除」「改名与模型」清默认值时按实例 id 匹配（custom-vendors/store.ts 的 `withoutDefaults`），碰不到它。
- **contracts**：`providerSelectionSchema`、`provider.select` 的请求、`provider.list` 的行都只增可选键，旧的消息照旧合法。

## 内置模型表的数据改动

数据，不是 spec 成员，照 02 §内置模型表的数据改动的写法列出，供逐项核对。

| 行 | 取值 |
|---|---|
| `claude-sonnet-5-5` | `nameKey: 'model.name.sonnet55'`、`purposeKey: 'model.purpose.sonnet55'`；1 000 000 / 128 000（F12）；`reasoning`、`supportsToolCalling`、`supportsStreamingToolCalls`（F21）、`supportsCacheControl` 为 true，`supportsVision: true`（F18），`thinkingPreservationFormat: 'signed-blocks'`，`usageNeedsOptIn: false`；`thinkingSpec: { mode: 'adaptive-gated', defaultOn: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', disableMaxEffort: 'high', offType: 'between_tools', displays: ['summarized', 'omitted'], defaultDisplay: 'omitted', samplingDefaultsOnly: true, forcedToolChoice: false }`（F3、F12、F13、F14、F18、F10）；`checksThinkingPrefix: true`（F9）；`pricing: { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.1, cacheWritePerMTok: 2.5 }`（F12）；`family: 'sonnet'`、`generation: [5, 5]` |
| `claude-haiku-5-5` | `nameKey: 'model.name.haiku55'`、`purposeKey: 'model.purpose.haiku55'`；1 000 000 / 128 000（F2）；其余能力位同上一行（vision 见 F18，流式工具调用见 F21）；`thinkingSpec: { mode: 'adaptive-gated', defaultOn: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', disableMaxEffort: 'high', displays: ['summarized', 'omitted'], defaultDisplay: 'omitted', samplingDefaultsOnly: true }`，不写 `offType`（关思考是 `disabled`，F4）、不写 `forcedToolChoice`（F10）；`checksThinkingPrefix: true`（F9）；`pricing: { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, cacheWritePerMTok: 0.125, longPrompt: { overTokens: 100_000, inputPerMTok: 0.5, outputPerMTok: 2.5, cacheReadPerMTok: 0.05, cacheWritePerMTok: 0.625 } }`（F11）；`family: 'haiku'`、`generation: [5, 5]` |
| anthropic 现有五行 | 只加 `family`、`generation`：`claude-opus-5-5` `'opus'` [5, 5]；`claude-opus-5` `'opus'` [5, 0]，并去掉手写的 `listing: 'more'`（改由算出，值不变）；`claude-sonnet-5` `'sonnet'` [5, 0]；`claude-haiku-4-5-20251001` `'haiku'` [4, 5]；`claude-fable-5-1` `'fable'` [5, 1] |
| 智谱四行 | 只加 `family`、`generation`：`glm-5.3` `'glm'` [5, 3]；`glm-5.3-flash` `'glm-flash'` [5, 3]；`glm-5.3-flashx` `'glm-flashx'` [5, 3]；`glm-4.6` `'glm'` [4, 6] |
| `familyNameKeys` | anthropic：`{ opus: 'model.family.opus', sonnet: 'model.family.sonnet', haiku: 'model.family.haiku', fable: 'model.family.fable' }`；智谱：`{ glm: 'model.family.glm', 'glm-flash': 'model.family.glmflash', 'glm-flashx': 'model.family.glmflashx' }` |
| 行序与 `listing` | anthropic 依次 `claude-opus-5-5`、`claude-sonnet-5-5`、`claude-haiku-5-5`、`claude-fable-5-1`、`claude-opus-5`、`claude-sonnet-5`、`claude-haiku-4-5-20251001`；智谱不变。`listing` 全由 §跟随最新 算出：Opus 5、Sonnet 5、Haiku 4.5、GLM-4.6 是 `'more'`，其余没有这个键。第一行仍是 `claude-opus-5-5`（新用户兜底，02 M5、A16） |
| 两份 locale | `model.name.sonnet55`「Sonnet 5.5」、`model.name.haiku55`「Haiku 5.5」；用途句 `model.purpose.sonnet55`「速度与能力兼顾 / Balanced speed and capability」、`model.purpose.haiku55`「成本最低 / Lowest cost」，`sonnet5` 改「上一代 Sonnet（旧版）/ Previous Sonnet (legacy)」，`haiku45` 改「上一代 Haiku（旧版）/ Previous Haiku (legacy)」（开放问题 4 的定法）；家族名七个键与 `settings.providers.latest`（§跟随最新「文案」） |
| 注释 | anthropic.ts 文件头记 2026-10-15 的来源；`thinkingSpec` 注释段补两行的模式、`between_tools` 与 F6；sampling 一条（anthropic.ts:85-87）改为引用 `build-with-claude/thinking` §Sampling parameters 2026-10-15 的原文（F14），删掉已过时的「the pages say only "the defaults"」，阈值改为「`top_p` 只收 0.99、不与 `temperature` 同发」；Sonnet 5、Haiku 4.5 两行照 Opus 5 的写法（anthropic.ts:154）加 Legacy 一句（F16）；Haiku 4.5 行的核查日期改为 2026-10-15，并把「02 decision A16 drops the row once a deprecation notice appears」一句改为按本 spec §Haiku 4.5 处理；anthropic.ts 与 zhipu.ts 的表头各加一句：`listing` 由 `family`、`generation` 算出，加新一代只写这两个键 |

## 已有规则已覆盖、不用改的

- **预填**（F7）：02 A2 末轮须为 user，两条线的 encode() 本地拒绝（shared.ts 的 `assertLastTurnIsUser`）。
- **拒答**（F8、F17）：`stop{ refusal }` 作废、不重发、不换模型（02 H12），Tenon 本来就不在客户端兜底；分类不解码；Sonnet 5.5 的 beta 服务端 fallback 不用，请求里不发 `fallbacks`。
- **强制 `tool_choice`**（F10）：主对话不发 `tool_choice`（02 §对 01-provider-and-tape 的修补 第 2 小节）。搜索子请求按 `['claude-sonnet-5', 'claude-opus-5']` 挑（backends.ts:81），两新行都不在候选里，开放问题 8 定为不改（A）。
- **前缀校验**（F9 后半）：两行写 `checksThinkingPrefix: true`，与 Opus 5.5、Fable 5.1 相同，不做回合中途压缩（02 §压缩时机与估算）。
- **逐条 effort**（F13 末句、F4）：页面说的是逐条消息的 `output_config.effort`，Tenon 不用这个 beta（02 A13），只改顶层 effort。关思考时顶层档位与前一个请求不同会怎样，2026-10-15 查过 Sonnet 5.5 迁移页、`build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5`、`build-with-claude/prompt-engineering/prompting-claude-haiku-5-5`、`build-with-claude/thinking`，最接近的原文有两处：
  - 两份提示页都说顶层改档只让缓存失效："Changing the top-level `effort` value between requests invalidates the prompt cache"（Haiku 5.5 页句末多 "for the conversation's messages"），没说会 400，也不分思考开关；
  - Sonnet 5.5 迁移页 §Other changes 有一句不带限定的 "With `between_tools`, effort can't change mid-conversation."。上下文讲的是逐条消息的 effort，但字面上也能读成包括顶层改档。

  所以没有页面说关思考时顶层改档会 400，也排除不了，这句有歧义。这种情形在两行上都会出现：
  - Sonnet 5.5：用户在菜单里选了 low 或 medium（02 §模型菜单与输入框「中途改档」允许），之后摘要请求发 `between_tools` 加 `high`；
  - Haiku 5.5：默认 medium，摘要请求发 `disabled` 加 `high`。

  compaction.test.ts「does not carry the session effort」把 low → high 固定为正确行为。靠开放问题 6 的 live 冒烟判定，两种情形各核一次（验收 12）。退路：live 返回 400 时停在 plan 第 12 步，报错原文记进 log.md，spec 回 `draft`。报错指向 effort、`between_tools` 或 `disabled` 时，由 owner 定怎么退，例如让这两行的摘要请求沿用会话档位、不超过 `disableMaxEffort`。这会改 02 §摘要请求「一律不继承会话的思考档位」，见 §点名 (e)。不然两行上改过档的会话一压缩就以 `provider-error` 收尾。报错指向别的原因时不走 (e)：这两例的摘要请求第一次带上回放的 tool_use / tool_result、同时不带 tools（原 Opus 5.5 例没覆盖这种形态），400 可能出在这里，(e) 修不好它；记成 02 §摘要请求「前缀（默认做法）」的问题，请 owner 定。
- **工具调用之间的说明**（F19）：Sonnet 5.5 上这些说明以思考块返回。Tenon 在思考开着的请求上都发 `display: 'summarized'`（run.ts:737-741，02 §思考的默认与显示），所以它们以思考摘要出现，不再是正文 text。摘要请求关思考且不带工具，不受影响。
- **账号绑定**（F9 前半）：同一个 `anthropic` provider 换成另一个（未关联）账号的 key 后，历史里两新行的思考块会被服务端静默丢掉，请求照常成功；守卫照记 `replay`，审计与模型实际看到的不一致。记为已知局限，不改：Tenon 不知道 key 属于哪个账号。
- **跨模型读块**：规则 2 本来就丢别的模型的思考块（02 §对 01-provider-and-tape 的修补 第 3 小节「守卫的读法」），Sonnet 5.5 与 Haiku 5.5 之间互读的差别碰不到。

## Haiku 4.5

- **现状**（F15、F16，2026-10-15）：Legacy，状态 Active，没有弃用公告，「不早于 2026-10-15」只是下限。Legacy 不等于弃用，A16「推迟到」一栏的触发条件「有弃用公告」没满足。本 spec 不改这一行的能力与价格；加 `family: 'haiku'`、`generation: [4, 5]`，`listing` 由此算成 `'more'`；注释照 Opus 5 的写法补 Legacy 一句，anthropic.ts:183-188 里的核查日期改成 2026-10-15。
- **用途句**：「最快、成本最低」在加入 Haiku 5.5 之后不成立（F11 的单价更低），改「上一代 Haiku（旧版）」。
- **公告之后**（开放问题 5 定 A，§点名 (b)）：弃用页出现它的条目后的第一个版本，用途句写明退役日（它已经在「更多模型 ›」里）；退役日之后的第一个版本撤行。公告到退役至少 60 天（F15），这期间模型仍可用。撤行那一步：删行，删 `model.name.haiku45`、`model.purpose.haiku45` 两个键；在菜单里选过它的会话（①）与钉住它的「新会话默认模型」落成表外 id（02 §表外模型与不发工具：保守合成、只能纯文字、标「未验证 · 仅文字对话」）；没选过模型、一直留在它上面的会话（§跟随最新「会话不换」），下一条消息起照 02 读默认，默认是指针时取那一家最新的一代，数据去向照 02；续跑仍用 Tape 冻结的 `model_info`（02 §续跑）；撤行后，本构建编码器写下的这一行的 attempt 复核得 `model-table-changed`（`currentModelWireHash` 为 null），不报被篡改（02 不变量 33、裁决 A3）。撤行是表数据改动，不另写 spec，到时在本 spec 的 plan「以后」记一步。

## 替换 02 的表现层条款

替换 02 §模型菜单与输入框 里「更多模型 ›」那一条。条款只改括注，其余一字不变：

- **「更多模型 ›」**：收 `listing === 'more'` 的行（每个家族里不是最新一代的行，由 claude-5-5-models §跟随最新「菜单自动排位」算出），每个已配置厂商另带一个「手填模型 ID」输入框。菜单末尾是「管理模型…」，打开设置。

例子，不属条款：2026-10-15 时这一档是 Opus 5、Sonnet 5、Haiku 4.5、GLM-4.6。以后厂商出新一代，条款不用改。

## 点名：不属纯粹只增的改动

读法照 02 §对 01-provider-and-tape 的修补 第 9 小节：只有 owner 确认过的点名项按 amend 处理，不认可的另写 supersede。(a)(b) 由 owner 2026-10-15 选 3A、5A 确认；(f) 是 owner 同日「跟随最新」规则原文（「运行中的会话不换」），范围由 owner 在第三轮评审后同日定（「都按推荐来」）；(g) 是本 spec 推出的，owner 2026-10-15 经问卷确认 A（记在 `Owner` 行），否决时照表里最后一列改回；(e) 只在 live 冒烟失败、spec 回 `draft` 之后由 owner 另行确认。确认都在被修补的那份 spec 的 `Amended by:` 里点出：(a)(b)(f)(g) 在 02 那行，(f) 另在 01 那行（它改了 01 验收 6 的结果）；没确认的项不写（plan 第 13 步；(e) 确认时补进 02 那行）。

| 项 | 触发 | 改了什么 | 为什么仍算 amend / 确认 |
|---|---|---|---|
| (a) | 开放问题 3 定 A | 02 §对 01-provider-and-tape 的修补 第 2 小节（02:689 `samplingDefaultsOnly` 的注释）与 types.ts:117 写定的「`top_p` 只收 ≥ 0.99」改为只收 0.99；第 3 小节「非默认的采样值本地拒绝」之外另拒 `temperature` 与 `top_p` 同发；Opus 5.5、Sonnet 5、Opus 5、Fable 5.1 的拒绝变多；thinking-shapes.test.ts:331-337「The defaults are accepted」那条（`temperature` 1 与 `top_p` 0.99 同发）改为断言拒绝 | 改了已定的值。依据：02 的「≥ 0.99」放过的 `top_p` 1 与同发，厂商写明都是 400（F14），收紧只是把必然 400 的请求挡在本地；内置行都没有 `requestParams`、循环也不设 `temperature`，线上请求不变。owner 2026-10-15 已确认 |
| (b) | 开放问题 5 定 A | 02 §开工前裁决 A16 的「推迟到」一栏（「Haiku 4.5 有弃用公告后撤行」）改为：公告后用途句写明退役日（它已在「更多模型 ›」），退役日之后撤行 | 改已定裁决。owner 2026-10-15 已确认 |
| (e) | 开放问题 6 的 live 冒烟里摘要请求 400、报错指向 effort、`between_tools` 或 `disabled`，owner 选了沿用会话档位的退路（别的原因不走这里，见 §已有规则「逐条 effort」） | 02 §摘要请求「思考参数：一律不继承会话的思考档位」（裁决 H10）对 Sonnet 5.5、Haiku 5.5 改为沿用，不超过 `disableMaxEffort` | 把已定裁决反过来，须 owner 另行确认 |
| (f) | 「跟随最新」，范围由 owner 在第三轮评审后定 | 02 第 6 小节「五层解析」与 §模型选择「没选过模型的会话」整条（owner 2026-09-25 确认的读法：每个 Run 都读该形态的默认，「这个默认会因为在别的会话里选模型而变」）：① 空着、本代已有 Run、按 §跟随最新「解析」第 1 条留在上一个 Run 的行时（表里的行还在；内置厂商上手填的 id），用那一行，不看答话的是哪一层、是不是指针。默认的改动（设置卡、别的会话的菜单、新一代上架、表的第一行换了）只影响新会话、清空之后，以及上一个 Run 的行不在表里、或用的是 `synthesized` id 的会话。随之，02 §主进程与 kernel 的循环接口「间接切公网」与验收 34「经形态默认的间接切换」只在这几种会话里、或原行的地址改到公网时出现，规则本身不变；02 那几条 e2e 用例要换成这几种会话来触发（plan 第 9 步）。另有三处结果随之变（plan 第 9 步逐个列出用例）：01 验收 6（设置卡把 provider 换成 zhipu 后「下一条消息发往 OpenAI 兼容端点」，读作新会话或清空之后的下一条，已有 Run 的会话仍发往原厂商）；02 启动恢复里续跑之后用户开的 Run（续跑本身照旧沿用暂停前的 `model_selected`；之后没选过模型的会话由读形态默认改为留在上一个 Run 的行）；custom-vendors 验收 20 的原文（「会话从本机切到公网实例时照 02 原地确认」）不变，它的用例走经默认的间接切换，改由上一个 Run 的行不在表里的会话触发，custom-vendors 因此不在 `Amends:` 里 | 改结果，不是只增。owner 2026-10-15「跟随最新」原文「运行中的会话不换」。第三轮评审指出，只管新一代上架是收窄：在会话 B 里选模型，没选过模型的会话 A 下一条消息就换，思考块、缓存、做到一半的事三条理由同样成立；owner 同日定「都按推荐来」，即不论默认怎么变都不换运行中的会话（没选的读法见 §被否决的方案） |
| (g) | 「跟随最新」推出 | 02 第 6 小节「在模型菜单里选一次，同时写……`defaultModelByProfile[形态]` 和 `provider`」，两半。前半：选主列表里带家族的行时写指针，新会话默认会随新一代移动，不再停在选的那一行。02 验收 33「默认按形态记住」那组用例写下的值随之带 `latestOf`（apps/desktop/test/model-selection.test.ts「records the choice and the profile’s default and provider」「writes each profile’s default in the profile’s lock」，plan 第 9 步）。后半：会话没有 ①、选的就是 `session.modelChoice` 答的那一行时（只改档、确认「切换」、再点当前行）只写 ①，这两个键都不写；02 里这一写不改本形态的默认结果，只会顺带改 `provider`，这个副作用没有了 | 形状只增一个键，含义变了：默认由「这一行」变成「这一家的当前一代」。owner 的规则写到设置卡与迁移，没写菜单；理由见 §跟随最新「谁写指针」。后半是为会话不换（(f)）补的：不补，只改档就会把会话留下的旧行写成默认，或把设置卡里钉住的行改成指针。owner 2026-10-15 经问卷确认 A。若以后否决前半：菜单照 02 写钉住的值，只有设置卡与第一把 key 写指针，删去 §对 02 的修补 第 9 条的指针一句与验收 16 的第一例；后半不随之撤：菜单写钉住的值时，只改档同样会把会话留下的旧行写成默认 |

## 不变量

1. anthropic 现有五行、智谱四行、Ollama 行、合成行、自定义实例行：encode() 的字节、`promptHash`、`modelWireHash` 与本 spec 之前逐字节相同（`family`、`generation`、`listing` 不进 `WIRE_MODEL_FIELDS`；采样拒绝变多不改写出的字节）。`modelInfoHash`：anthropic 与智谱的内置行都变（§跟随最新「菜单自动排位」），Ollama、合成、实例行不变；旧 Tape 冻结的副本不动。本 spec 之前写下的 anthropic-messages attempt 复核一律 `not-covered / other-encoder`（§兼容），openai-chat 的照旧 `verified`。
2. `offType: 'between_tools'` 的行关思考时，body 的 `thinking` 恰为 `{ type: 'between_tools' }`；档位高于 `disableMaxEffort` 时本地拒绝，`tools` 非空时也本地拒绝；`offType` 写在 budget 或 adaptive 行上时，关思考本地拒绝；都是 0 次请求。
3. 有 `longPrompt` 的行，一次 attempt 的提示长度大于 `overTokens` 时四项全按本档，否则全按基础档；从不把一次请求拆成两段计价。
4. 所有 `samplingDefaultsOnly` 的行，F6、F14 列的每种情形都在本地拒绝，不静默改请求。
5. 每个内置定义的第一行都不是 `listing: 'more'`；anthropic 第一行是 `claude-opus-5-5`。
6. anthropic-messages 编码器版本为 4，openai-chat 仍为 2。
7. 带家族的行，`listing` 为 `'more'` 当且仅当同一定义里有同家族、代次更大的行；同家族的代次互不相同；不带家族的行不受这条管。
8. 指针只解析到同一厂商、同一家族的内置行；解析不出时退回它的 `modelId`，从不换家族、换厂商。
9. ① 空着、本代已有 Run 时，只要上一个 Run 用的行还在那家厂商的表里（实例的行要还在实例里），或者它是内置厂商上手填的 id，这个 Run 就用它：表里加了新一代、表的第一行换了、用户改了默认，运行中的会话都不换模型；只有 `synthesized` 的 id 照 02 读默认；数据去向检查照旧在取行之后做。
10. Tape 不加事实名；`session/model_selected` 与 `session/model_choice_set` 记的都是具体的模型 id，从不记指针。
11. `latestOf` 只由主进程写，只写在内置 anthropic、智谱的选择上，从不与 `source` 同写；`provider.select` 只在请求带 `latestOf` 时写指针；本 spec 不改写已有的 config.json。
12. 会话没有 ①、`session.selectModel` 选的 provider 与模型 id 就是写入前 `session.modelChoice` 答的那一行时，`defaultModelByProfile` 与 `provider` 都不写。

## 验收标准

全部通过才能标 `implemented`。不注明的在 CI 里跑；标（live）的是开放问题 6 定的官方 key 冒烟。

1. definitions（packages/kernel/test/provider/definitions.test.ts）：两新行逐字段等于 §内置模型表的数据改动；anthropic 七行与智谱四行的 `family`、`generation` 等于 §跟随最新 的表，Ollama 行没有；anthropic 行序照数据表；Opus 5、Sonnet 5、Haiku 4.5、GLM-4.6 的 `listing` 是 `'more'`，其余行没有 `listing` 键；`familyNameKeys` 覆盖表里出现的每个家族；`offType` 只出现在 anthropic-messages 线、`adaptive-gated` 且带 `disableMaxEffort` 的行；`longPrompt.overTokens` 是正整数。
2. 关思考（thinking-shapes.test.ts）：Sonnet 5.5 关思考、不带 tools、档位为 low / medium / high 或不传时，body 的 `thinking` 是 `{ type: 'between_tools' }`，带了 `display` 也不写；档位 xhigh / max 本地拒绝、0 次请求；关思考且 `tools` 非空本地拒绝、0 次请求。Haiku 5.5 档位规则同样，写的是 `{ type: 'disabled' }`，带 tools 照常编码。两行开思考带 `budgetTokens` 本地拒绝（F4、F13）。Opus 5 关思考仍写 `disabled`。合成的 budget 行与 adaptive 行各带 `offType: 'between_tools'`，关思考（档位 low）本地拒绝、0 次请求。
3. 摘要请求（packages/kernel/test/loop/compaction.test.ts）：Sonnet 5.5 上的摘要请求 body 里 `thinking` 是 `{ type: 'between_tools' }`、`output_config.effort` 是 `high`，没有 `tools` 和 `display`；Haiku 5.5 是 `{ type: 'disabled' }` 与 `high`。
4. 金样（packages/kernel/test/provider/wire/encoder-version.test.ts）：anthropic-messages 当前版本 4。原有的金样行与两份金样请求不改，两张表各追加第 4 行，值等于第 3 行；另加一行带 `offType` 的 adaptive-gated 行和一份关思考、effort 为 `high`、不带 tools 的金样请求，它有自己的表，从第 4 行起。查重改为跨表：每升一版，至少有一张表在这一版的哈希与上一版不同，或是新加的；当前版本是各表最大的版本号。`GOLDEN_WIRE_HASH` 不变。
5. 采样（thinking-shapes.test.ts）：Haiku 5.5、Sonnet 5.5 与 Opus 5.5 本地拒绝 `top_p` 1、`top_p` 0.9、任何 `top_k`、`temperature` 0.5、`temperature` 1 与 `top_p` 0.99 同发；只带 `temperature` 1 或只带 `top_p` 0.99 照常编码。「The defaults are accepted」改为断言同发被拒、单发照常（§点名 (a)）。
6. 思考默认（packages/kernel/test/loop/thinking-default.test.ts）：Haiku 5.5 的第一个请求带 `thinking: { type: 'adaptive', display: 'summarized' }`，不带 effort（F5）。
7. 费用（apps/desktop/test/evals-cost.test.ts）：Haiku 5.5 一次 attempt 提示长度恰为 100 000 时按基础档，100 001 时四项全按高档；只靠缓存读把提示长度推过 100 000 的也按高档；构造一个 `longPrompt` 里没有 `cacheReadPerMTok`、`cacheWritePerMTok` 的 `pricing`，提示长度过阈值时缓存两项按 `longPrompt.inputPerMTok` 计；没有 `longPrompt` 的行结果与之前相同（现有用例不改）。
8. 文案（apps/desktop/test/copy-coverage.test.ts「names every Anthropic and Zhipu row」「has the display name and purpose sentence of every builtin model row」）：新的名字与用途句键、七个家族名键、`settings.providers.latest` 两份 locale 都有；前几类没有占位符，`settings.providers.latest` 恰有 `{family}`、`{model}` 两个。
9. 菜单（apps/desktop/e2e/model-menu.spec.ts）：anthropic 主列表依次是 Opus 5.5、Sonnet 5.5、Haiku 5.5、Fable 5.1，「更多模型 ›」里有 Opus 5、Sonnet 5、Haiku 4.5；智谱主列表是 GLM-5.3、GLM-5.3 Flash、GLM-5.3 FlashX，「更多模型 ›」里有 GLM-4.6；两新行第一行写显示名、第二行写用途句；没选过模型的新会话仍用 Opus 5.5。text-fit-02.spec.ts 主列表照旧 5 行（anthropic 四行、Ollama 一行），不换行不截断。
10. 搜索（packages/kernel/test/tools/search-backends.test.ts）：加了两行之后，`selectAnthropicSearchModel()` 仍给 `claude-sonnet-5`；把表里的 Sonnet 5.5 行改 id 成 `'claude-sonnet-5'`（`{ ...sonnet55, id: 'claude-sonnet-5' }`）单独传入时返回 null，证明挡住它的是行上的 `forcedToolChoice: false`。
11. Haiku 4.5（弃用公告之前）：除注释、`family`、`generation` 与算出的 `listing` 外，这一行与之前逐字节相同，`modelWireHash` 不变。
12. （live）结果记进 log.md。各条从哪里读：第一条照官方组原有的断言；第二、三条的线上 `thinking`、`effort`、`tools` 与状态码从 record 模式的线上记录读（apps/desktop/e2e/live-official-agent.spec.ts 的 `evidence(app, false, journal)`，重启后的 `last.wire[0]` 是摘要请求，照 Opus 5.5 那例），请求快照从 Tape（`tapeFacts`）读，Tape 不记线上的 `thinking.type` 与状态码；第四、五条从 Tape 读：
    - 两新行各跑一次 02 的官方组并通过；
    - Sonnet 5.5 一次真实的阈值压缩：压缩前先有一轮带工具调用（Read）的回合，再把档位选成 low。线上：摘要请求不带 `tools`，`thinking` 是 `{ type: 'between_tools' }`，`output_config.effort` 是 `high`，返回 200（这时历史里有一对 tool_use / tool_result）；Tape：摘要 attempt 的快照是 `{ thinking: { enabled: false }, effort: 'high' }`，压缩后主请求的快照带 `effort: 'low'`；
    - Haiku 5.5 一次真实的阈值压缩，同样先有一轮 Read，按默认档（不传 effort）：线上摘要请求不带 `tools`，是 `{ type: 'disabled' }` 加 `high`，返回 200；Tape：摘要 attempt 的快照同上一条；
    - 两行各问一道要推理、不用工具的题，回复里出现思考块时文本非空（自适应思考可以不思考，所以不要求一定有思考块）；
    - 两行各发两次：先断言第一个请求的提示长度（input + cacheRead + cacheWrite）大于 512（F20）、`cacheWriteTokens` 大于 0，再断言第二个请求的 `provider/attempt_completed.usage.cacheReadTokens` 大于 0。
13. 排位（新文件 packages/kernel/test/provider/model-families.test.ts，合成的定义）：给一个家族加一行更新的代次，构建出的表里旧行变 `'more'`、新行没有 `listing`，别的家族与不带家族的行不变；代次先比主再比次（[5, 0] 旧于 [5, 5]，[4, 6] 旧于 [5, 3]）；带家族的行手写 `listing`、同家族两行代次相同、只有 `family` 没有 `generation`，构建时抛错；同家族里旧行排在新行前面时，`newestOfFamily` 仍给代次大的那行。
14. 解析（apps/desktop/test/model-selection.test.ts「the five layers and the data-flow check」）：② 为 `{ id: 'anthropic', modelId: 'claude-opus-5', latestOf: 'opus' }` 时解析为 `claude-opus-5-5`、`capabilitySource: 'builtin'`；③ 同样；`latestOf` 是表里没有的家族时读作 `modelId`；`latestOf` 与 `source` 同在时读作钉住；带 `latestOf` 的 Ollama 选择读作钉住；anthropic 没配置、智谱配置了时，opus 指针仍解析到 Opus 5.5，发送按缺 key 拒绝，0 次请求发往智谱。
15. 会话不换（同文件，用合成的 anthropic 定义：把 `family: 'opus'`、`generation: [6, 0]` 的一行放在第一行，守不变量 5；由表里的行展开时先去掉算好的 `listing`，再过 `arrangeFamilies`，不然会按「带家族的行手写了 `listing`」抛错；kernel 部分在 packages/kernel/test/session/model-choice.test.ts）：
    - 新会话第一个 Run（默认是 opus 指针或落到 ⑤）用 [6, 0] 那行，`model_selected` 记它的 id；
    - 上一个 Run 用 `claude-opus-5-5` 的会话：默认是 opus 指针、落到 ⑤、是钉住的 `glm-5.3-flash`、或改成了 sonnet 指针，下一条消息开的 Run 都仍用 `claude-opus-5-5`，`session.modelChoice` 也答它；同一份默认下，新会话用默认给的行（sonnet 指针给 Sonnet 最新一代）；
    - 清空之后照默认解析（opus 指针给 [6, 0]）；
    - 上一个 Run 用的行不在表里时照默认解析（opus 指针给 [6, 0]），不出确认；
    - 上一个 Run 用 Ollama 的 `qwen3:8b`（回环）、默认改成 anthropic：仍用 `qwen3:8b`，不出确认；Ollama 存的地址再改到公网主机（`https://gpu.example.com/v1/`）：仍是这一行，`resolveChoice` 返回 `needsConfirm: { host: 'gpu.example.com' }`，而 `session.modelChoice` 照常答 `qwen3:8b`、不抛；上一个 Run 用手填的 Ollama id `my-local-model`（`capabilitySource: 'user'`）、默认改成 anthropic：仍用 `my-local-model`，`capabilitySource` 仍是 `user`，不出确认；上一个 Run 用的是 `synthesized` 的 Ollama id（开发变量 `TENON_MODEL`）、默认改成 anthropic：照默认解析，回环到公网先确认；上一个 Run 用实例的行、那一行已从实例里删掉：照默认解析；不带 `previousModel` 的问询照旧（02 那几条五层、数据去向用例不改仍通过）；
    - kernel 交给 `resolveChoice` 的 `previousModel` 是本代最后一个 `model_selected` 的 provider、模型与 `capabilitySource`，第一个 Run 与清空后是 null；`effectiveModelChoice` 交的 `previousModel` 与 Run 开始时相同，`previousOrigin` 仍为 null；Tape 的事实名表不变（packages/kernel/src/tape/names.ts 不加名字）。
16. 写指针（model-selection.test.ts「session.selectModel and session.modelChoice」、apps/desktop/test/provider-routes.test.ts）：菜单选 Sonnet 5.5，`defaultModelByProfile[形态]` 与 `provider` 是 `{ id: 'anthropic', modelId: 'claude-sonnet-5-5', latestOf: 'sonnet' }`，本会话的 `session/model_choice_set` 记 `claude-sonnet-5-5`；选 Sonnet 5（更多模型）、手填 id、Ollama 行、实例行写钉住的值；02 验收 33 那两例（「records the choice and the profile’s default and provider」「writes each profile’s default in the profile’s lock」）按 §点名 (g) 改期望为带 `latestOf: 'glm-flash'` 或 `'opus'` 的指针，`session.modelChoice` 仍答具体的 `glm-5.3-flash`；`provider.select` 不带 `latestOf`、选 `claude-opus-5-5` 或 `glm-5.3-flash`，三个键写钉住的值、没有 `latestOf`（provider-routes.test.ts「accepts %s」照旧通过）；`provider.select` 带 `latestOf: 'haiku'` 与 `modelId: 'claude-haiku-4-5-20251001'` 写 `{ id: 'anthropic', modelId: 'claude-haiku-5-5', latestOf: 'haiku' }`；`latestOf` 是该厂商表里没有的家族、带 `latestOf` 选 Ollama 与实例、`modelId` 不属于该家族，都回 `invalid-value`；被拒时 config.json 不动。只改档不写默认（不变量 12）：默认是 opus 指针、会话因会话不换留在 `claude-sonnet-5` 上，菜单只改档后三个键不变；存着钉住的 `{ id: 'anthropic', modelId: 'claude-opus-5-5' }`、会话在默认那一行上，只改档或在 hold 的确认页确认「切换」之后仍是钉住的值，没有 `latestOf`。`provider.list` 的行带 `family` 与 `familyNameKey`，Ollama 行没有（model-selection.test.ts「provider.list for the menu」）；apps/desktop/test/provider-catalogue.test.ts 的键清单加上各定义 `familyNameKeys` 的值，两份 locale 都有。
17. 设置卡（apps/desktop/e2e/provider-settings.spec.ts）：全新 profile 打开 anthropic 卡，「新会话默认模型」下拉依次是「最新的 Opus（现在是 Opus 5.5）」「最新的 Sonnet（现在是 Sonnet 5.5）」「最新的 Haiku（现在是 Haiku 5.5）」「最新的 Fable（现在是 Fable 5.1）」，再是七行的显示名，选中第一项；已存着别家默认（钉住的 `glm-5.3-flash`）的 profile 打开 anthropic 卡，只改 key、不动下拉就保存，三个键不变（全新 profile 第一次存 key 会照 presentation-r1 写默认，所以这一例不用全新 profile）；选「最新的 Haiku」保存，三个键都是 haiku 指针，新会话用 Haiku 5.5；选钉住的「Opus 5.5」那一行保存，三个键是 `{ id: 'anthropic', modelId: 'claude-opus-5-5' }`，没有 `latestOf`；存着钉住的 Sonnet 5 时打开卡选中 Sonnet 5；en 下第一项是 "Latest Opus (now Opus 5.5)"；Ollama 卡没有指针项。
18. config 兼容：packages/contracts/test/config-route.test.ts 里，本 spec 之前的 config.json 原样解析，值里没有 `latestOf`；带 `latestOf` 的值解析出来带着它；`latestOf: ""`（或不是字符串）的值解析成钉住的 `{ id, modelId }`，同一字段里的另一个形态的默认与别的键都还在。apps/desktop/test/profile.test.ts 里，主进程只写别的键（写入 `lastWorkspaceFolders`）之后读回，三个默认里的 `latestOf` 都还在。
19. 第一把 key（按条件验，plan 第 11 步）：presentation-r1 写第一把 key 的代码已在 `dev` 上时，在本 spec 里验；还不在时本条在本 spec 里不适用，由 presentation-r1 实现「有」一支时以它验收 12 的指针一例验（同一例），plan 第 11 步记一句。这一例：全新 profile 第一次存 anthropic key，三个键都是 `{ id: 'anthropic', modelId: 'claude-opus-5-5', latestOf: 'opus' }`；第一次存智谱 key 是 `glm` 指针；新建带 key 的实例写钉住的 `.chat`。

## 开放问题（已定）

全部由 owner 2026-10-15 定。没选的项与理由在 §被否决的方案。

1. **关思考的形态怎么表达**：A。`ThinkingSpec` 只增 `offType?: 'between_tools'`；Sonnet 5.5 记 `adaptive-gated` + `disableMaxEffort: 'high'` + `offType: 'between_tools'`。档位上限沿用 `assertMayDisable`，`summaryThinking`（compaction.ts:27-42）不用改。编码器升到 4，旧记录复核得 `not-covered`（§兼容）。
2. **分档价格的形状**：A。`pricing` 只增一个可选的 `longPrompt`（一个阈值加一组高档单价），以后真出现第三档再只增。
3. **采样守卫怎么收紧**：A。不加成员，`samplingDefaultsOnly` 的读法改为厂商的规则：`top_p` 只收 0.99，`temperature` 与 `top_p` 不能同发。只有一套规则，哈希与编码都不变；四行旧行的拒绝变多，§点名 (a)。对线上没有影响：内置 Anthropic 行都没有 `requestParams`，循环也不设 `temperature`，守卫拦的只是表错误。
4. **菜单位置与用途句**：由 owner 的规则「跟随最新」取代，位置由家族与代次算出（§跟随最新）。用途句由本 spec 定：Sonnet 5.5「速度与能力兼顾」（沿用 Sonnet 5 的那句），Haiku 5.5「成本最低」（F11：表里单价最低，高档也是），Sonnet 5「上一代 Sonnet（旧版）」、Haiku 4.5「上一代 Haiku（旧版）」（F16，照 Opus 5「上一代 Opus（旧版）」的写法）。英文见数据表。
5. **Haiku 4.5 有弃用公告之后**：A。见 §Haiku 4.5，§点名 (b)。依据：弃用页 Overview "**Deprecated:** The model is still functional but no longer recommended."，同页 Warning "Deprecated models are likely to be less reliable than active models."；公告即撤行，选过它的会话和默认会立刻落成表外 id、只能纯文字。
6. **官方 key 的 live 冒烟**：A。实现时跑（plan 第 12 步），覆盖验收 12。key 照 02 的规矩从钥匙串 `tenon-live-anthropic` 读，只进那一次命令的环境；**读之前先提醒 owner：macOS 会弹窗**。只跑 `--grep` 选中的用例（plan「命令」）：官方组 3 例乘 2 个模型，每例 1–2 个请求；两例阈值压缩，各约 7 个请求（含一轮 Read）；缓存与思考 1 例，两个模型各 2 个请求。合计约 30 个请求，按 Sonnet 5.5 $2 / $10 与 Haiku 5.5 的低档价算，每个请求的输入在两万 token 以内时总共不到 1 美元，上限 2 美元；实际用量与花费记进 log.md（「花费：」行）。
7. **Haiku 5.5 的高档与压缩阈值**：A。1M 窗口的行在 150 000 token 压缩（compaction.ts:13-15，`min(0.8 × 窗口, 150 000)`，02 H10），Haiku 5.5 提示在 100 000 到 150 000 之间的请求单价是低档的 5 倍（F11）。不动，费用照实记；以后要改 H10 的绝对上限时另写 amend，把这一档算进去（plan「以后」）。
8. **搜索子请求要不要改用 Haiku 5.5**：A。不改，候选仍是 `['claude-sonnet-5', 'claude-opus-5']`（02 §搜索与抓取；backends.ts:81）。Sonnet 5.5 的 id 不在候选里，就算在，也会因 `forcedToolChoice: false` 被跳过（验收 10）。

## 被否决的方案

- **1B**：`mode` 只增一个值（如 `'adaptive-between-tools'`）。每个按 mode 分支的地方都要补，`summaryThinking` 的 `default` 分支漏补也不报错，摘要请求会照常思考。**1C**：Sonnet 5.5 记 `always-on`，契约与编码都不动；代价是摘要请求在 Sonnet 5.5 上照常思考，行数据与厂商能力不符。
- **2B**：`pricing` 只增 `tiers` 数组。更通用，但现在用不上，还要多一套排序与校验。
- **3B**：只增 `samplingExact`，六行都设。拒绝照样变多，四行的哈希还会变，这个成员在内置表里又总与 `samplingDefaultsOnly` 同值。**3C**：只设两新行；明知另外四行的守卫比厂商规则松。
- **4（逐行手写 `listing`）**：A 手写 Sonnet 5、Haiku 4.5 为 `'more'`；B 七行里六行留在主列表；C 两新行先进「更多模型」，live 过了再提上来。都被「跟随最新」取代：每出一代都要逐行改，GLM-4.6 这样的旧行也没人记得挪。
- **5B**：照 A16，公告即撤行。厂商在退役前仍提供服务，撤得太早。
- **6B**：只用按文档写的夹具。关思考时顶层改档会不会 400，页面有歧义（§已有规则「逐条 effort」），只能靠 live 判定。
- **7B**：`ModelInfo` 只增按行的压缩上限，Haiku 5.5 设 100 000。压缩更勤、细节丢得更早，还要改 02 写定的阈值公式。
- **8B**：候选表最前加 `claude-haiku-5-5`。它对搜索请求的回应形状没实测过，还要改 02 的候选表。
- **跟随最新的几种做法**：
  - 会话不换只管新一代上架（第三轮评审给的另一个选项）：① 空着、答话的一层是指针时才留在同家族的上一行，用户改默认（含在别的会话里选模型）照 02 换掉运行中的会话。在会话 B 里选一次模型，没选过模型的会话 A 下一条消息就换，思考块、缓存、做到一半的事三条理由同样成立；同一家族里「钉住改成指针」还要另加代次条件才分得清是谁改的。owner 2026-10-15 定「都按推荐来」，取了不论默认怎么变都不换。
  - 会话建立时把指针写成第 0 条 `session/model_choice_set`：① 读作「菜单里确认过的选择」，连接器对它跳过数据去向检查，自动写的 ① 没人确认过；还要多写一条 Tape 事实，而上一个 Run 的 `session/model_selected` 已经够用。
  - `listing` 在 `provider.list` 现算、不写进 `ModelInfo`：02 写定 `provider.list` 的 `listing` 取自 `ModelInfo.listing`，`ModelInfo` 里留着手写的旧值，两处就不一致了。
  - 另开一个键（如 `defaultFamilyByProfile`）记指针：一个默认分两处记，谁优先又要定一遍；在原值上加 `latestOf`，旧构建还能读成钉住的值。
  - 代次写成一个小数（5.5）：5.10 会读成 5.1。
  - 菜单一律写钉住的值：第一次在菜单里选模型就把指针换掉（§点名 (g)）。
  - 会话不换不管手填的 id（第三轮修订的写法）：理由是连接器分不出手填的 id 和撤掉的行，可 `model_selected` 本来就记着 `capabilitySource`。Ollama 表只有一行，手填是 Ollama 的主路径；不管的话，在别的会话里选一次公网模型，手填 Ollama id 的会话下一条就换过去，与 owner 定的「不论默认怎么变都不换」不符。
  - 由本 spec 修补 presentation-r1 的第一把 key（第三轮修订的写法，`Amends:` 加它、§点名 (h)）：它还是 `ready`，修补只用于 `implemented` 的 spec；它 `c60760d` 的第 1 条已自己写了指针一支，两边都说归自己，修补会是一条什么都没改的记录。
  - 自动用厂商新发布的模型：见 §目标与非目标。

## 修订记录

从 2026-10-23 起记在这里，此前的修订见页头 `Revisions:`。

- 2026-10-23 · 页头 `Tier:`、`Replaces:`、`Related:`；§验收标准 第 12 条与开头一句；§已有规则已覆盖、不用改的「逐条 effort」退路；§开放问题（已定）第 6 条 · 按 sdd v2 接入（ADR-004 A5）的澄清，不改任何要求：补 `Tier: standard`；02 已冻结，不写 02 正文的行末指针，只在 02 页头加 `Changed by`；presentation-r1 已合入并 `implemented`，第一把 key 的「有」一支由本 spec 实现；验收 12 的标记改成 spec-check 认的（live）；live 结果与花费改记 log.md，花费上限写 2 美元（估计不到 1 美元的两倍，收紧） · PR #61、PR #55
