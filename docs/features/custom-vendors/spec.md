# 自定义厂商（M6）

Status: ready
Kind: features
Owner: 裁决由 owner 拍板（2026-10-01 第一轮，2026-10-02 第二到四轮；13 题都选推荐项，T1–T13 照写，裁决卡、选择记录与厂商调研原文在仓库外 `../tenon-notes/2026-10-02-m6-custom-vendors/`）；起草在 Claude Code（2026-10-02）
Amends: [01-provider-and-tape](../../architecture/01-provider-and-tape/spec.md) §Provider 层、§desktop 接线；[02-agent-loop](../../architecture/02-agent-loop/spec.md) §对 01-provider-and-tape 的修补（第 2、6、7 小节立的成员）、§主进程与 kernel 的循环接口、§02 的 Tape 事实、§会话形态、工作区与模型选择（表外模型与不发工具）、§内置工具与工具来源（工具来源、命名与权限键）、§工具目录与冻结、§上下文管理、§搜索与抓取、§界面范围。只增不改，全文见 §对 01 的修补、§对 02 的修补；不属纯粹只增的在 §点名
Related: [ADR-003](../../adr/adr-003-provider-layer.md)（厂商分档：本 spec 是「能接上」一档的交付物，ADR-003:48）
Revisions: 2026-10-02 首版；同日按六视角评审修订（实例地址只取描述（readConfig 剔除实例的 providerConfig）、续跑按冻结的 capabilitySource 发工具、key 保存在写完钥匙串后计数、openai-chat 实例请求用量、没通过的 anthropic 行照回传签名、百炼新加坡补 Anthropic 地址、订阅地址事实更正并加开放问题 3、实例出网不跟随重定向、内置厂商按官方 https 源判、开发默认不改 TENON_PROVIDER、点名补 (g) 与测试接缝）；同日第二轮评审修订（前缀检查缺省照 02 只按 id、自定义行写 false；被拒地址改用 `refused`（码与源）并覆盖实例；探测中止回 `aborted`；assemble 按与 key 同一次读重造实例行；测试接缝只改投到回环、不继承、要 `TENON_DEV_ENV=off`；金样改法；模型行 id 去重；已知键加 `name`；百炼 429 限流探测记 `rate-limit`；订阅条款依据更正并补方舟 Agent Plan；方舟 key 链接定下，开放问题 1 收窄；.env.example 与评测同模型列的实际后果）；同日 owner 定三题（Q15 别家订阅地址第一版不拦；Q16 开发期日常对话走内置智谱，`TENON_PROVIDER=zhipu` 默认生效；Q17 评测同模型列照算费用），撤掉开放问题 3，过目接受 §推出的读法，Status 改 ready；同日实现第 4 步时就地修订：§合成 的 `maxTokensField` 不看 `outcome`（旧：只给通过的行写；改因：与验收 16 矛盾，没通过的行退回仅文字时对拒收 `max_tokens` 的端点每次 400）；§列表与上限 补响应头 30 秒、正文 8 MiB 两个上限（旧：没写，永不应答的 /models 只能等 signal）；§探测「何时、走哪条路」检查器按 SSE 事件读（与 openai SDK 解码器同）、读到 `[DONE]` 即停、读的字节不超过适配器读到的、非 2xx 的响应体不分流，一个事件（旧：一行）解析不了就跳过；§不认识的字段 的「每个 SSE 块」改为「每个 SSE 事件」（旧：按 `data:` 行读，未写停读与界限；改因：解码器按整个事件解析，多行 data 与 BOM 按行读会误判；读过 `[DONE]` 或读过适配器的检查器，在端点不关流、空闲看门狗撤流或错误体不结束时会卡住探测与实例的探测锁）；§两步 T10 的 `unsupported_parameter` 一支加「且 `detail` 含 `max_tokens`」，§推出的读法 22 同改（旧：只看 `providerCode` 为 `unsupported_parameter`；改因：OpenAI 对任何参数都回这个码，别的参数（如 `tools`）的 `unsupported_parameter` 会让 ① 重发、快照记 `max_completion_tokens`，而 §合成 不看 `outcome`，没通过的行就改发端点从没认过的 `max_completion_tokens`）；§结果与原因码 表下加一条：anthropic-messages 线 ① 报 `malformed_tool_input`（tool_use 的 input 不是 JSON 对象）记 `bad-tool-call`（旧：没写，按表里的 `unknown` 落到 `service`；改因：同一种模型错误在 openai-chat 线是解码器丢掉调用、记 `bad-tool-call`，记 `service` 会把用户引去查网络）；§两步 T10 末句改为快照的字段只在 ① 回答了时改写（重发过记 `max_completion_tokens`，没重发且 ① 没报错记 `max_tokens`，其余沿用该行原快照的值、没有原快照记 `max_tokens`）（旧：「重发过就在快照记 max_completion_tokens，否则记 max_tokens」；改因：§合成 不看 `outcome`，学到 `max_completion_tokens` 的行重新探测时 ① 遇上 429、5xx、断网或发出之前就失败，会被记回 `max_tokens`，此后仅文字的请求每次 400）；§结果与原因码 表下加一条：① 折叠出的轮编不进 ②（canonicalJson 拒收工具输入或厂商块）时不发 ②、记 `bad-tool-call`（旧：没写，编码的报错漏出 `probeModel`，它便在没有中止时 reject、不造快照，违背「只在中止时 reject」）；同日开第 6 步前补用户取消探测：§IPC 只增路由 `customVendor.cancelProbe`，设置卡探测中显示「取消」，中止回 `aborted`、不存（旧：没写，SSE 注释行不断重置空闲看门狗时探测只有应用退出、删实例、保存 key 能结束，实例一直回 `busy`；不设总时长上限，因为会截断正当的长思考探测）；同日第 5 步评审后定：config.json 的写入改为临时文件加改名（旧：没写，`DesktopFs` 先截断再写，锁外读可能读到半个文件、写到一半失败会丢掉全部实例）；手改坏文件与清快照丢掉 `maxTokensField` 两处写成已知局限；同日第 7 步第二轮评审后定：模型行 id 不带首尾空白（`customModelSchema.id` 加 refine，`customVendor.update` 拒收，/models 返回的这种 id 跳过、不预填，`readConfig` 先丢掉这一行并记日志、不丢实例，见 §存储、§列表与上限）（旧：没写，`modelIdSchema` 收首尾空白；改因：`resolveChoice` 对 ② / ③ 的模型 id 取 trim，`assemble` 对实例只按 id 精确找行、不合成（§实例被删或改坏），这样的行新会话永远够不着、每条首发都是 `config-missing`，或落到去掉空白后同名的另一行；`resolveChoice` 照 §行标记 不改）；同日第 7 步第三轮评审后记：§错误（T11）的已知局限加 DeepSeek 错 key 的 401（`type: authentication_error`、`code: invalid_request_error`，2026-10-01 实录）在 openai-chat 线运行时读作 `invalid-request`、探测记 `request-rejected`（anthropic-messages 线与 /models 读作 `auth`），验收 24 改为钉三个现状（旧：只列智谱数字码与百炼 429；改因：DeepSeek 预设走 openai-chat 线，共用词表先读通用的 `code`、不看 401，错 key 的用户看到通用的请求被拒，不是 key 的文案；照「第一版不改」只记不改映射）；同日第 7 步第四轮评审后记：§错误（T11）的已知局限加预设厂商表示余额或计费停用的 429（Kimi `exceeded_current_quota_error`，方舟 `SetLimitExceeded` 与免费额度的 `QuotaExceeded`，百炼 `PrepaidBillOverdue`、`PostpaidBillOverdue`、`BudgetLimitExceeded`、`CommodityNotPurchased`）：两条线按 429 读作可重试的 `rate-limit`，运行时重发到 3 次、以限流失败卡结束，探测记 `rate-limit`；验收 24 改为钉四个现状，加 Kimi 的按文档夹具（旧：已知局限只列智谱数字码、百炼 TPM 的 `insufficient_quota` 与 DeepSeek 错 key 的 401，验收 24 钉三个；改因：这类 429 落在六个预设里的三个（Kimi、方舟、百炼），余额用完的用户看到的是限流、稍后再试，第 9 步的文案与第 12 步的实测要按同一份现状读；照「第一版不改」只记不改映射）；同日第 7 步评审后定：HTTP 401 一律读作 `auth`（点名 (h)；旧：按体里的类型判，DeepSeek 错 key 显示成请求被拒）；余额类 429 读作限流写成已知局限；评测同模型列的价格改在 runner 算费用时给（旧：包在实例定义外，到不了模型行；§需求价格条、Q17 行、读法 17 同步改）；同日第 7 步收尾评审后对齐点名 (h)：§错误（T11）已知局限删去 DeepSeek 错 key 那句，实录的 body 并入 401 那条；验收 24 改为钉三个现状，DeepSeek 错 key 的 401 两条线运行时与探测都读作 `auth`，没有已知码的 403 仍读作 `auth`；「403 不动」的括注改为如实的读法（旧：已知局限与验收 24 仍写 openai-chat 线读作 `invalid-request`、探测记 `request-rejected`，括注写「02 把部分 403 归作 `account-config`」；改因：与点名 (h) 及改过的测试矛盾，02 与代码里都没有把 403 归作 `account-config` 的映射）；同日第 8 步第四轮评审后定：§点名 测试接缝还要 `TENON_SECRETS=memory`，否则主进程与 e2e 启动器拒绝启动（旧：只要 `TENON_DEV_ENV=off`，守卫只看环境里的值；改因：钥匙串各 profile 共用，接缝开着、机密走钥匙串时，开发者存在钥匙串里的官方 Anthropic key 会被改投到本机假服务器，02 裁决 M4）；2026-10-03 owner 定 Q18（方舟预设第一版不带 Anthropic 线），开放问题 1 关闭；2026-10-03 第 11 步实测 glm-4.7-flash 在 `/api/anthropic` 上探测通过，开放问题 2 关闭

## 背景与问题

02 只保证智谱与 Anthropic 官方端点；其余兼容端点只能改内置定义的 `baseURL`，或在内置厂商下手填表外模型（只能纯文本）（02 spec:68-80、:85）。ADR-003 把「能接上」一档交给本 spec：通用定义工厂加数据，探测通过后开工具，不保证（ADR-003:48-53）。02 给本 spec 留的口子：`modelMarkSchema` 的 `probed`（02 spec:901、:2886），实例 id 与 https 规则（A9 行，02 spec:149），每个 provider 的工具数上限与厂商差异数据面（02 spec:3402），内置行改主机之后的去向（开放问题 23，02 spec:3389）。

现状里决定形状的四处（只读代码地图，dev `e6c7bf5`）：

- `custom:<uuid>` 放不进工具表键。`toolTableKey` 的 provider 段只收 `[a-z0-9._-]`（packages/kernel/src/tape/provenance.ts:45、:165-172、:216-224），而 02 把键定为 `view:v1:tool_table:<incarnationId>:<g>:<providerId>`（02 spec:1167）。
- 注册表不覆盖、没有 unregister（packages/kernel/src/provider/registry.ts:17-25；01 spec:269-273）；desktop 在读 config.json 之前就注册完（apps/desktop/src/main/index.ts:136-139）。
- openai-chat 线解码只读 delta 的 `content`、`reasoning_content`、`reasoning`、`tool_calls`，tool_call 只读 `index`、`id`、`type`、`function`、`custom`（packages/kernel/src/provider/wire/openai-chat.ts:744-760），其余字段丢掉。
- 搜索后端按定义 id 加主机选（apps/desktop/src/main/run-assembly.ts:316-327），自定义实例永远没有后端。

## 目标与非目标

### 目标

1. 设置卡里新建「自定义厂商」实例：选预设或填地址、选线协议、填 key。实例是通用工厂加一份纯数据，不逐家写定义文件（裁决 Q3；ADR-003 决策 3）。
2. 每个（实例，模型）点按钮做两步往返探测；通过的行在对话、任务两种形态都带工具，标「本机探测 · 不保证」（裁决 Q5、Q6）。
3. 内置 `zhipu`、`anthropic` 只认官方主机；原来靠改内置 `baseURL` 接的端点改走实例（裁决 Q8）。
4. 验收：智谱当自定义厂商测两条线，DeepSeek 一家真实探测与往返（裁决 Q11）。

### 非目标

- 用户可调的请求参数：思考开关、`tool_stream`、任何白名单开关都不开；自定义请求头也不开（裁决 Q9；02 裁决 A6）。需要特定参数才能用工具的模型探测不过，留在纯文本。
- 思考档位：不传，菜单不显示档位子菜单（T5）。
- 自定义实例的网络搜索（裁决 Q10）。WebFetch 照常。
- openai-chat 线的不透明字段往返（裁决 Q14）。
- 图片：自定义行 `supportsVision` 一律 false，探测不测图片（推出）。
- 价格：自定义行没有 `pricing`，界面不算它的费用；评测的同模型列由 runner 算费用时用该列的评测专用价（Q17，§点名 (d)）。
- 按厂商的错误词表（T11）；可配的用量路径（T10）。
- 回环、私网实例的工具（裁决 Q7）。窗口策略随「Ollama 进 agent 验收」那份 spec（02 spec:83、:154）。
- 订阅登录（02 裁决 M8）；新线协议（`openai-responses` 按 ADR-003 另做，不加 ai-sdk 线）。
- 自动迁移旧配置（裁决 Q8）。
- 按模型的厂商规则：预设只带地址（裁决 Q3 的 A′）。

## 裁决索引

全文与依据在裁决卡（2026-10-01 v2，仓库外 `../tenon-notes/2026-10-02-m6-custom-vendors/cards-v2.md`，同目录有厂商事实表与调研原文）。本 spec 按下表 id 引用，题号沿用卡片，没有 Q12。

| id | 决定 | 落点 |
|---|---|---|
| Q1 | 放 `docs/features/custom-vendors/`，开工规则补 features spec | §文档同步 |
| Q2 | 两条线都开；非空签名原样往返，空签名照 01 守卫规则 6 丢；前缀检查改成 ModelInfo 数据，自定义行默认不套 | §模型行；§运行时「前缀检查」；§对 01 的修补 |
| Q3 | 只带地址的预设；能力一律靠探测；上限 /models 预填、用户可改 | §预设；§模型行 |
| Q4 | 预设：DeepSeek、Kimi（国内、国际）、百炼、火山方舟、MiniMax（国内、国际）、智谱国际站；其余走「其他兼容端点」 | §预设 |
| Q5 | 两步往返探测 | §探测 |
| Q6 | 探测通过的行能跑任务形态，标「本机探测 · 不保证」 | §运行时「行标记」 |
| Q7 | 回环、私网实例一律纯文本，不显示探测按钮 | §探测「回环与私网」；§运行时 |
| Q8 | 内置定义只认官方主机；旧配置读作未配置；五处改走实例；删 02 spec:2738 的搜索分支 | §点名 |
| Q9 | 第一版没有任何用户可调的请求参数 | §非目标；§模型行 |
| Q10 | 自定义实例没有 WebSearch，界面写明 | §运行时「搜索」 |
| Q11 | 智谱两条线 + DeepSeek 真实探测与往返；其余只有按文档写的夹具 | §验收标准 |
| Q13 | 预设只指按量地址；手填含 `/api/coding/paas/v4` 的地址拒存；共用地址只提醒 | §地址校验；§预设 |
| Q14 | openai-chat 线不做不透明字段往返；探测见到不认识的字段不给通过 | §探测「不认识的字段」 |
| T1 | 实例 id 为 `custom-<uuid>`（小写） | §实例 id |
| T2 | 主机与线协议建好后不能改 | §实例 id；§IPC |
| T3 | 快照按（实例，模型）存；保存实例 key 时清掉全部快照；不过期，不存 key 指纹 | §存储 |
| T4 | 探测只在点按钮时发，按钮旁写明请求次数；不带会话内容 | §探测 |
| T5 | 不传思考档位，不显示子菜单 | §模型行 |
| T6 | 上限：用户填的优先，/models 预填，两样都没有不能保存，不落到 01 spec:708 的 128000 / 4096 | §模型行 |
| T7 | 点「获取模型列表」才请求 /models，也可手填 | §模型行 |
| T8 | 实例列表存 config.json 的 `customVendors`；降级会丢，不加 configVersion；key 按实例分键，删实例在配置锁内按名删 | §存储 |
| T9 | 只增的改动都走 Amends | §对 01 的修补；§对 02 的修补 |
| T10 | ModelInfo 只增输出上限字段名与前缀检查开关；新字段缺省时内置行字节不变；编码器版本照规则加一 | §对 01 的修补 |
| T11 | 通用实例只认标准错误码 | §运行时「错误」 |
| T12 | 会话用的实例被删或改坏：续跑按 provider 错误结束，不换模型，文案单列 | §运行时「实例被删或改坏」 |
| T13 | 每请求工具数上限改成定义上的数据，实例缺省 128 | §对 01 的修补；§对 02 的修补 |
| Q15 | （2026-10-02）别家的订阅地址第一版不拦：条款明文禁止自建应用的只有智谱；百炼允许的工具里有桌面客户端，Kimi 允许第三方工具，方舟措辞含糊 | §地址校验 |
| Q16 | （2026-10-02）开发期日常对话走内置智谱：`.env.example` 的 `TENON_PROVIDER=zhipu` 默认生效 | §点名 (d) |
| Q17 | （2026-10-02）评测同模型列照算费用：runner 算费用时用该列的评测专用价，实例定义不带 pricing | §点名 (d) |
| Q18 | （2026-10-03）方舟预设第一版不带 anthropic-messages 线（两页文档路径不一致，没有 key 实测），关闭开放问题 1 | §预设；§开放问题 |

## 身份、工厂与注册表视图

### 实例 id

- 形如 `custom-<uuid>`，uuid 是小写的 canonical UUID：`^custom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`。主进程在新建时铸造，永不复用（T1）。
- 长 43，合 `providerIdSchema` 的 64 上限（packages/contracts/src/ipc/provider.ts:26）与 provenance 的身份段（provenance.ts:45）。
- ADR-003:48、02 spec:85、:2018 写的 `custom:<uuid>` 以本条为准；ADR-003 记一行勘误，02 正文不改（T1）。
- 实例的线协议与 `baseURL` 建好后不变（T2）。改地址就新建实例。思考块、原样块按 `providerId` 隔离（01 spec:332），一个 id 永远只对着一个端点，01 守卫规则 1 因此天然隔开两个实例。T2 写的是主机；本 spec 把整个 `baseURL` 定为不可改（推出：裁决给的路由里没有「改地址」，同一主机下换路径照样可能换了厂商）。

### 实例描述与通用工厂

kernel 新增 `packages/kernel/src/provider/definitions/custom.ts`。实例描述是纯数据，能 JSON 序列化；工厂是纯函数，不碰 I/O。

```ts
export const CUSTOM_PROVIDER_ID_PATTERN = /^custom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const CUSTOM_TOOLS_PER_REQUEST = 128                    // T13

export interface CustomVendorDescription {
  readonly id: ProviderId                                      // custom-<uuid>
  readonly wire: 'openai-chat' | 'anthropic-messages'
  readonly baseURL: string                                     // 建好后不变（T2）
  readonly keyRequired: boolean                                // 只有回环、私网实例为 false（§key）
  readonly models: readonly CustomModelRow[]
}
export interface CustomModelRow {
  readonly id: string
  readonly contextLimit: number                                // 正整数，用户填或 /models 预填（T6）
  readonly maxOutputTokens: number
  readonly probe?: ProbeSnapshot                               // §探测；没有 = 没探测过
}
/** 一行 ModelInfo，规则见 §模型行「合成」 */
export function customModelInfo(d: Pick<CustomVendorDescription, 'id' | 'wire'>, row: CustomModelRow): ModelInfo
/** 实例的 ProviderDefinition：wire 二选一，复用两个线协议适配器 */
export function customVendorDefinition(d: CustomVendorDescription): ProviderDefinition
```

`customVendorDefinition` 的产物：

| 成员 | 取值 |
|---|---|
| `id`、`wire` | 描述里的同名字段；id 不合 `CUSTOM_PROVIDER_ID_PATTERN` 就抛 `ProviderInvalidArgumentError` |
| `nameKey` | 通用键 `provider.custom.name`。用户起的名字不进 i18n 键，经 provider.list 的 `displayName` 走（§对 01 的修补） |
| `configKeys` | `apiKey`（机密，`required: keyRequired`，labelKey `provider.custom.config.apiKey`）；`baseURL`（非机密、必填，`default` 为描述里的 `baseURL`，labelKey `provider.custom.config.baseURL`）。声明 `baseURL` 是为了让 02 的 key 绑定主机、目标主机显示、`endpointOrigin` 原样生效（01 修补 6 取「定义声明的默认地址」） |
| `builtinModels` | `models.map((row) => customModelInfo(d, row))`，顺序同描述 |
| `finishReasons` | 不声明（T11） |
| `maxToolsPerRequest` | `CUSTOM_TOOLS_PER_REQUEST`（T13；成员见 §对 01 的修补） |
| `create()` | openai-chat 建 `OpenAIChatProvider`，anthropic-messages 建 `AnthropicMessagesProvider`，传法照 zhipu.ts、anthropic.ts；`baseURL` 只取描述里的值，不读 `config.baseURL`；anthropic-messages 只传 `apiKey`（`x-api-key`），`authToken` 传 null。交给 SDK 的 `network` 包一层：照原样转给 `network.fetch`，但 `init.redirect` 定为 `'error'`，3xx 不跟随、读作 `network` 错误（先例 packages/kernel/src/tools/search/backends.ts:33；推出）；`fetchRemoteModels` 用同一层包装，探测经 `create()` 继承。内置定义照 02 spec:753 默认跟随，不改 |

### 注册表视图（推出）

- desktop 新增 `apps/desktop/src/main/custom-vendors/registry.ts`：一个实现 01 `ProviderRegistry` 的组合视图。`get(id)`、`list()` 先查内置注册表，再查实例；实例的定义按 config.json `customVendors` 的当前快照用工厂现做。`register()` 只转给内置注册表，传 `custom-` 开头的 id 就抛。
- 快照来源照 run-assembly 的 `stored`：启动时读的那份，之后每次写入经 `watchConfig` 同步换（run-assembly.ts:87-94）。新建、改名、改模型、删除写完即生效，不重启。
- 内置三家的顺序和内容不变；`list()` 里实例排在内置之后，按 `customVendors` 的顺序。
- `assemble` 对实例 id 不用进入时视图给的定义（run-assembly.ts:164 先取定义、:176 才读稳定，provider.ts:189-200 的重读不换定义）：行（`supportsToolCalling`、`capabilitySource`、`toolsWithheld`、`maxOutputTokens` 都由它出）按读稳定后那份 `read.config.customVendors` 用工厂重造，与 key 同一次读；重造后实例或行没了，照 §实例被删或改坏 按 `ProviderConfigMissingError` 处理（推出：否则读到一半落下的 key 保存会让新 key 配上旧快照的「通过」）。
- 实例不读 `providerConfig`：主进程的 `readConfig`（apps/desktop/src/main/host/profile.ts:27）剔除 `providerConfig` 里 id 合 `CUSTOM_PROVIDER_ID_PATTERN` 的条目（读作没有，下次写入随之消失），`provider.configure` 对实例也不写 `providerConfig[id]`。于是 key 绑定、`provider.list` 的 `endpoint`、`endpointOrigin` 与 `resolveChoice` 的数据去向确认都落到定义声明的默认地址，即描述里的 `baseURL`，这几处代码不用改（T2；01 修补 6 的绑定规则不变）。
- 理由：kernel 循环不用注册表，用它的只有 desktop 与评测；不 amend 01 的 `ProviderRegistry`。被否的做法见 §被否决的方案。

## 地址、预设与 key

### 地址校验

新建实例时主进程按下表依次判，第一条不过就拒存，钥匙串和 config.json 都不动。规则在 desktop（`custom-vendors/address.ts`），kernel 的 `assertBaseUrl`（transport.ts:54-90）不改。

| # | 规则 | 依据 | 拒绝码 |
|---|---|---|---|
| 1 | 能被 `URL` 解析，协议是 `https:` 或 `http:` | transport.ts:54-75（kernel 已拒非 http(s)） | `invalid-address` |
| 2 | `http:` 只给回环、私网主机（`reachOf`，apps/desktop/src/main/endpoint.ts:58-79） | A9（02 spec:85） | `https-required` |
| 3 | 不带 userinfo；原串不含 `?`、`#` | A9；transport.ts:78（kernel 只拒非空的 query、fragment） | `invalid-address` |
| 4 | 路径逐段 percent-decode 后小写、去重复斜杠、去尾斜杠，不含 `/api/coding/paas/v4` | Q13 | `subscription-endpoint` |
| 5 | anthropic-messages 线的路径最后一段不是 `v1`（SDK 自己会加） | transport.ts:83-88 | `invalid-address` |

- 存的是 `new URL(输入).href` 去掉尾斜杠，界面显示与规则匹配都用这一份（推出）。
- Q13 点名拒存的订阅路径是智谱 Coding Plan 的 `/api/coding/paas/v4`（`https://open.bigmodel.cn/api/coding/paas/v4`、`https://api.z.ai/api/coding/paas/v4`；docs.bigmodel.cn/cn/coding-plan/tool/others、docs.z.ai/devpack/tool/others）。别家另有专用的订阅地址，第一版规则 4 不拦（Q15）：百炼 Coding Plan `coding.dashscope.aliyuncs.com`、`coding-intl.dashscope.aliyuncs.com` 与 Token Plan `token-plan.cn-beijing.maas.aliyuncs.com`、`token-plan.ap-southeast-1.maas.aliyuncs.com`（help.aliyun.com/zh/model-studio/coding-plan、…/base-url；alibabacloud.com/help/en/model-studio/base-url）；方舟 Coding Plan `https://ark.cn-beijing.volces.com/api/coding`、`…/api/coding/v3`（docs.volcengine.com/docs/82379/1928261）与 Agent Plan `…/api/plan`、`…/api/plan/v3`（docs.volcengine.com/docs/82379/2373746），都与方舟预设同主机；Kimi Code `https://api.kimi.com/coding/`、`https://api.kimi.ai/coding/`（kimi.com/code/docs）。百炼、方舟只许在 AI 编程工具里用：百炼禁止用于自动化脚本、自定义应用后端与非交互批量调用，它列出的可接工具含 Cherry Studio、Chatbox 这类桌面客户端；方舟写明套餐「不可用于 API 调用」（docs.volcengine.com/docs/82379/1925114）。Kimi Code 写明订阅 key 可接入第三方开发工具与平台（kimi.com/code/docs）。
- 分不出的共用地址只提醒：智谱 `https://open.bigmodel.cn/api/anthropic` 同时列在按量 API 与 Coding Plan 文档里（docs.bigmodel.cn/cn/guide/develop/claude/introduction）。主机为 `open.bigmodel.cn` 或 `api.z.ai` 的实例，key 一栏下写「只能填按量付费的 key；GLM Coding Plan 的 key 不得用于 Tenon（订阅协议第六条第 2 款）」（Q13）。MiniMax 的 `/anthropic` 地址按量与订阅共用（models.dev 的 minimax-coding-plan、minimax-cn-coding-plan）：主机为 `api.minimax.cn`、`api.minimax.io`、`api.minimaxi.com` 的实例，key 一栏下写「填『接口密钥』页的按量 key，不要填 Token Plan / M Plan 的订阅 key」（Q13）。
- 回环、私网照 02 的判定按拼写、不查 DNS；解析到内网地址的普通域名读作公网（Q7）。

### 预设

预设是纯数据，只带厂商名、各地区、各线的 `baseURL`、「去取 key」链接和默认线，不带按模型的规则（Q3）。放在 desktop 主进程（`custom-vendors/presets.ts`），经 `customVendor.list` 交给渲染端（推出：encode 不读它，所以不进 kernel；contracts 只放 schema；渲染端不能 import kernel）。地址与链接 2026-10-02 对官方文档核过：

| 预设 | 地区 | openai-chat | anthropic-messages | 默认线 | 去取 key | 出处 |
|---|---|---|---|---|---|---|
| DeepSeek | — | `https://api.deepseek.com` | `https://api.deepseek.com/anthropic` | openai-chat | `https://platform.deepseek.com/api_keys` | api-docs.deepseek.com；…/guides/anthropic_api；…/quick_start/agent_integrations/claude_code |
| Kimi | 国内 | `https://api.moonshot.cn/v1` | `https://api.moonshot.cn/anthropic` | openai-chat | `https://platform.kimi.com/console/api-keys` | platform.kimi.com/docs/api/overview |
| Kimi | 国际 | `https://api.moonshot.ai/v1` | `https://api.moonshot.ai/anthropic` | openai-chat | `https://platform.kimi.ai/console/api-keys` | platform.kimi.ai/docs/api/overview |
| 百炼 | 华北2（北京） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `https://dashscope.aliyuncs.com/apps/anthropic` | openai-chat | `https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key` | help.aliyun.com/zh/model-studio/get-api-key、…/base-url |
| 百炼 | 新加坡 | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `https://dashscope-intl.aliyuncs.com/apps/anthropic` | openai-chat | `https://modelstudio.console.alibabacloud.com/ap-southeast-1/settings/api-key` | help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions、…/base-url；alibabacloud.com/help/en/model-studio/get-api-key |
| 火山方舟 | 华北2（北京） | `https://ark.cn-beijing.volces.com/api/v3` | 不带（开放问题 1） | openai-chat | `https://ark.volcengine.com/region:cn-beijing/apiKey` | volcengine.com/docs/82379/1298459；docs.volcengine.com/docs/82379/1541594 |
| MiniMax | 国内 | `https://api.minimax.cn/v1` | `https://api.minimax.cn/anthropic` | anthropic-messages | `https://platform.minimax.cn/user-center/basic-information/interface-key` | platform.minimaxi.com/docs/guides/quickstart-preparation.md |
| MiniMax | 国际 | `https://api.minimax.io/v1` | `https://api.minimax.io/anthropic` | anthropic-messages | `https://platform.minimax.io/user-center/basic-information/interface-key` | platform.minimax.io/docs/guides/quickstart-preparation.md |
| 智谱国际站 | 国际 | `https://api.z.ai/api/paas/v4` | 不带 | openai-chat | `https://z.ai/manage-apikey/apikey-list` | docs.z.ai/api-reference/introduction |

- 百炼用文档写明仍可用的旧主机（help.aliyun.com/zh/model-studio/base-url：原有中心化共享域名当前可继续使用，建议迁移到业务空间专属域名）；新的按业务空间分的主机要 WorkspaceId，预设不用。百炼 key 按地区绑定（help.aliyun.com/zh/model-studio/get-api-key：「不能跨地域混用」；跨地区回 401 `invalid_api_key` 见 help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope）。
- 方舟只有国内一处：国际站是另一家平台 BytePlus ModelArk，不进预设。方舟 Anthropic 端点的路径两处文档不一致（`/api/compatible/v1/messages` 与 `/api/v3/compatible/v1/messages`，volcengine.com/docs/82379/2655179 与 /2636748），不猜。「去取 key」指 API Key 管理页；Coding Plan 的快速开始链到同一页，计费按 Base URL 分，`/api/v3` 不走订阅额度（docs.volcengine.com/docs/82379/1928261），所以预设仍只指按量地址（Q13）。
- MiniMax 默认 anthropic-messages 线（厂商推荐这条线）。它的按量 key 与 M Plan 订阅 key 互相独立，「去取 key」指「接口密钥」页，不指「订阅管理 > M Plan」（两处前置准备页原文分列两种 key）。
- 智谱国际站只给 openai-chat：`https://api.z.ai/api/anthropic` 只出现在 GLM Coding Plan 的文档里（docs.z.ai/devpack/tool/others），按量 key 能不能用没写。
- 每个预设各地区一条；百炼只带北京、新加坡（另有美国（弗吉尼亚）、中国香港两地区，走「其他兼容端点」；推出）。表里没有任何订阅路径（Q13）。「其他兼容端点」不带预设，地址、线协议都由用户填，照 §地址校验。
- 默认线：MiniMax 照厂商推荐；其余取 openai-chat（推出：它是 Tenon 的验收基准线；DeepSeek 的「带工具缺回传就 400」只写在 OpenAI 格式的文档里，api-docs.deepseek.com/guides/thinking_mode）。
- 预设里选好地区和线之后，地址只读；要别的地址改选「其他兼容端点」（推出：Q13 要预设只指按量地址）。

### key

- 只进钥匙串，按实例分键：服务名 `com.yiongspace.tenon`（apps/desktop/src/main/host/secrets.ts:5），账户 `keyFor(identity, 'provider', <实例 id>, 'apiKey')`，即 `<tenantId>:provider:custom-<uuid>:apiKey`（packages/kernel/src/host/key.ts:10-21）。不进 config.json、IPC 应答与日志（T8；01 spec:142；AGENTS.md 硬规则）。
- 新建时 key 随 `customVendor.create` 一起交来；之后改 key 走现有的 `provider.configure`（实例只声明 `apiKey` 一个可写键）。
- 公网实例 `keyRequired: true`。回环、私网实例可以不填（本机服务常不校验 key）；没填时工厂给 SDK 一个固定占位串 `tenon-local`（推出：01 spec:326 要求 openai-chat 的 `apiKey` 非空）。占位串只在工厂里用；Ollama 是把 `apiKey` 声明成带默认值的非机密键（ollama.ts:48-52），实例不这样做，因为私网服务可能真要 key。
- `keyRequired: false` 的实例，`provider.list` 的 `configured` 不套 isConfigured 的「至少存了一把机密」那一条（apps/desktop/src/main/provider-routes.ts:311-315）：没存 key 也为 true，只看 key 绑定（unbound 为空），其余照 02（推出）。
- anthropic-messages 实例只用 `x-api-key`。DeepSeek、MiniMax、百炼的 Anthropic 端点文档写明收 `x-api-key`，Kimi 的文档示例用 Anthropic SDK 的 `api_key` 传；只收 Bearer 的网关探测会以 `auth` 失败（推出）。

## 存储

### config.json 的 `customVendors`（T8）

```ts
// packages/contracts/src/ipc/config.ts —— configSchema 只增
customVendors: z.array(customVendorSchema).default([])
// packages/contracts/src/ipc/custom-vendor.ts —— 新文件
export const customProviderIdSchema = z.string().regex(CUSTOM_ID_REGEX) // 与 kernel 的 CUSTOM_PROVIDER_ID_PATTERN 同一个式子
export const wireSchema = z.enum(['openai-chat', 'anthropic-messages'])
export const probeReasonSchema = z.enum(['no-tool-call', 'output-limit', 'no-finish', 'config', 'auth', 'quota',
  'rate-limit', 'request-rejected', 'echo-rejected', 'bad-tool-call', 'opaque-fields', 'service']) // §探测「结果与原因码」
export const probeSnapshotSchema = z.object({
  outcome: z.enum(['passed', 'not-detected', 'failed']),
  reason: probeReasonSchema.nullable(),                                  // passed 时为 null；码见 §探测
  probedAt: z.number().int().nonnegative(),                              // HostClock 的 epoch ms，只显示
  reasoningField: z.enum(['reasoning_content', 'reasoning']).nullable(), // openai-chat 线识别到的思考字段；anthropic 线恒 null
  maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).nullable(), // anthropic 线恒 null（T10）
  usageSeen: z.boolean(),                                                // 标准路径上拿到过用量
  responseModelId: z.string().max(200).nullable(),                       // 只显示，不判（Q5）
  unknownFields: z.array(z.string().max(64)).max(16),                    // Q14：只记键名，不记值
})
export const customModelSchema = z.object({
  id: modelIdSchema.refine((id) => id === id.trim()),                    // 不带首尾空白（§列表与上限）
  contextLimit: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  probe: probeSnapshotSchema.optional(),                                 // T3：按（实例，模型）存
})
const distinctIds = (rows: readonly { id: string }[]) => new Set(rows.map((r) => r.id)).size === rows.length
export const customVendorSchema = z.object({
  id: customProviderIdSchema,
  displayName: z.string().trim().min(1).max(64),
  wire: wireSchema,
  baseURL: z.string().min(1).max(PROVIDER_VALUE_MAX_LENGTH),
  presetId: z.string().min(1).max(64).optional(),                        // 只用于显示从哪个预设建的
  models: z.array(customModelSchema).max(200).refine(distinctIds),      // 行按 id 寻址，id 互不相同
})
```

- 只由主进程写，不进 `configSetRequestSchema`（config.ts:81-84）。`readConfig` 对 `customVendors` 单独逐条过 schema：先丢掉条目内 id 带首尾空白的模型行（日志只记条目下标，手改只丢这一行、不丢实例与它的 key 绑定），把 id 重复的模型行只留第一行，再过 schema，不过的丢掉，实例 id 重复的只留第一条，日志只记条目下标与原因、不记地址，其余照读（推出：`readConfig` 现在对坏字段整字段回落到默认，apps/desktop/src/main/host/profile.ts:36-58，一条坏条目会让下一次写入清掉全部实例）。过了 schema 的条目再按 §地址校验 1–5（按条目的 wire）判；不过的保留，注册表视图照样为它造定义，但把它的 `create()` 换成抛 `ProviderConfigMissingError`，`customVendor.fetchModels` 在发出前回 `config`、探测在发出前记失败 `config`，都是 0 次请求；`provider.list` 给它 `configured: false` 与 `refused`（码同 §地址校验 表，§对 01 的修补 4），`customVendor.list` 的这一条带同一个 `refused`，设置卡据此标出（推出：手改与旧文件同样要过 A9 与 Q13）。
- 快照非机密，跟着模型行放在 config.json（T3）。不设过期时间，不存 key 指纹（T3）。快照不进 `ModelInfo`，只由它推出 ModelInfo 的几个字段（§模型行）。
- 降级：M6 之前的构建按 02 的 configSchema 剥掉不认识的 `customVendors`，下次写入就没了；钥匙串里留下孤儿 key（`HostSecrets` 不能列举）。接受，不加 configVersion（T8）。
- 已知局限（接受）：手改 config.json 改到解析不了时照 02 读作默认，下次写入就丢掉全部实例、留下孤儿 key——手改不在支持范围内；保存 key、改输出上限清掉整份快照时，学到的 `maxTokensField` 一并清掉，重新探测即恢复。

### 写入规则

全部在每个 profile 的配置锁里串行，与 `provider.configure` 同一把锁（01 修补 6），锁内重读 config.json。config.json 的每次写入都先写同目录的临时文件、再改名替换（只改主进程写 config.json 的那条路径，不改 `HostFs` 的通用写入）：锁外的读只会看到旧文件或新文件，写到一半失败时旧文件不动。

- **新建**：校验地址（预设按 §IPC 从 presets.ts 取）→ 铸 id → 写 key（有的话）→ 写 config.json 加条目。写 config 失败就删回刚写的 key 再抛；回删也失败时记一行日志（只记实例 id）。这把孤儿 key 的账户含永不复用的 id，任何路径都读不到它（推出）。
- **保存实例的 key**（`provider.configure`，T3）：先写 config.json，把该实例每行的 `probe` 清掉，再写钥匙串。写 key 失败时停在「快照已清、旧 key 还在」，工具是关的。这一顺序与 02 对同主机保存的「先写机密」相反（推出：T3 要的是失败时工具关着）。
- **删除**（T8）：先删钥匙串里该实例声明的每个机密键，不看读出了什么；删出错就整次拒绝，config.json 不动；再写 config.json 去掉条目。任一步失败都不会留下「条目已删、key 还在」。「先失效再删 key」读作：删掉 key 即失效，下一次组装起读作未配置、发送按缺 key 拒绝（推出）。同一次锁内的 config 写入里，`provider` 与 `defaultModelByProfile.chat` / `.cowork` 指向被删实例的一并清掉（`provider: null`，删掉该 profile 的键），新会话照五层回落到 ④⑤（推出）。
- **改名与模型**：只改 `displayName` 与 `models`。保留的模型 id 连同快照不动，但改了 `maxOutputTokens` 的行清掉快照；新加的 id 没有快照；删掉的 id 连快照一起删，指向它的新会话默认照「删除」一并清掉（推出）。
- 删除与保存 key 先中止该实例进行中的探测（不存结果）；已在跑的 Run 用组装时读出的 key 跑完这一轮，不中止（与 02 spec:1102 正在跑的 Run 沿用 provider 相同）。
- 改了某实例条目的写入计入该实例的 `providerSettingsGeneration`（profile.ts:113-120 现在只数 `providerConfig`）；另外，实例 key 的每次保存（含清空，含写 key 失败）在锁内写完钥匙串之后再把它加一，不论条目变没变，所以在两次写之间开始的探测读到旧 key 也存不下（推出）。探测的保存与 02 的读稳定规则都看它。

## 模型行

### 列表与上限（T6、T7）

- 模型 id 可手填，也可点「获取模型列表」从端点取；不点就 0 次 /models 请求（T7）。
- 取列表：openai-chat 发 `GET <baseURL>/models`，anthropic-messages 发 `GET <baseURL>/v1/models`；先过 02 的 key 绑定检查，经 `fetchThroughHost`（transport.ts:162）与 A6 的请求头白名单发出。kernel 新增 `provider/remote-models.ts` 的 `fetchRemoteModels()`，只解析 `data[].id` 与下面这些上限字段（推出，字段依据见裁决卡 Q3 与同目录的厂商事实表）；失败只回原因码与 HTTP 状态，不记、不回响应体：

| 读法 | 键（`data[i]` 上） | 已知来源 |
|---|---|---|
| 上下文 | `context_window`、`context_length`、`max_model_len`，取第一个正整数 | DeepSeek；Kimi、千帆、OpenRouter；vLLM |
| 输出 | `max_output_tokens`、`max_completions_tokens`、`top_provider.max_completion_tokens`，同上 | DeepSeek；千帆；OpenRouter |

- 模型行的 id 不带首尾空白（§存储 的 `customModelSchema`）：`customVendor.update` 拒收，/models 返回的这种 id 跳过、不预填，设置卡手填的 id 先去掉首尾空白再发（推出：`resolveChoice` 对 ② / ③ 的模型 id 取 trim，§实例被删或改坏 的 `assemble` 只按 id 精确找行、不合成，带空白的行新会话够不着）。
- 取到的上限只预填，用户可改。上下文和输出两样都要有正整数才能保存这一行；没有就不能保存，不落到 01 spec:708 的 128000 / 4096（T6）。
- 列表取不到（404、非 JSON、没有 `data`）回 `unsupported`，界面提示手填。响应头 30 秒内没到回 `service`（`status: null`）；正文超过 8 MiB 就停读、回 `unsupported`；正文中途停顿照实例请求的字节级空闲上限；应用退出时经 `signal` 中止。方舟文档没写数据面的 /models（只在控制面、Access Key 鉴权的 ListFoundationModels 里列模型；volcengine.com/docs/82379/1262847），取不到时照此回 `unsupported`。
- 菜单里不给自定义实例手填模型 ID：模型只在设置卡里加，带上限（推出：T6）。`provider.select`、`session.selectModel` 对实例里没有的模型 id 返回 `unknown-model`（这个码在 contracts 里保留着，provider.ts:119-125）；内置厂商的手填照 02 不变。

### 合成（`customModelInfo`）

| 字段 | 探测通过的行 | 其余行（没探测、没测出来、失败） |
|---|---|---|
| `id` | 行的 id | 同左 |
| `providerId` | 实例 id | 同左 |
| `canonicalId` | 不写（守卫按 `id` 比，01 spec:333） | 同左 |
| `contextLimit`、`maxOutputTokens` | 行里用户确认的值（T6） | 同左 |
| `reasoning` | false（只有 anthropic 线的 `thinkingEffortSupport` 读它，anthropic-messages.ts:702-706；T5 不传档位；推出） | false |
| `supportsToolCalling` | true | false |
| `supportsStreamingToolCalls` | true（探测本身就是流式工具调用） | false |
| `supportsVision` | false（§非目标） | false |
| `supportsCacheControl` | false（探测不测缓存；推出） | false |
| `thinkingPreservationFormat` | openai-chat：快照有 `reasoningField` 为 `'reasoning-content'`，没有为 `'drop'`；anthropic-messages：`'signed-blocks'`（Q2） | openai-chat：`'drop'`；anthropic-messages：`'signed-blocks'`（Q2：非空签名原样往返与探测无关；空签名照规则 6 丢） |
| `reasoningEchoField` | openai-chat 且有 `reasoningField` 时取它；否则不写 | 不写 |
| `usageNeedsOptIn` | openai-chat：true（发 `stream_options.include_usage`，用量仍只读块级 `usage`，即 T10 的标准路径；百炼、方舟、千帆、OpenAI、腾讯 TokenHub 的文档写明流式用量只在开了它时给，Kimi 不开时用量在非标准的 `choices[0].usage`，DeepSeek、智谱、OpenRouter 开了照收；推出）；anthropic-messages：false（该线编码器不读它） | 同左 |
| `pricing`、`thinkingSpec`、`requestParams`、`purposeKey`、`listing` | 不写（§非目标；T5；Q9） | 同左 |
| `maxTokensField`（新增） | openai-chat 线、快照为 `'max_completion_tokens'` 时写它，否则不写（T10） | 同左：这是线上的事实，不是能力，不看 `outcome` |
| `checksThinkingPrefix`（新增） | 写 false（Q2；缺省会按 02 的 id 规则回落，§运行时「前缀检查」） | 同左 |

- 「通过」只看 `probe.outcome === 'passed'`。回环、私网实例永远拿不到通过的快照（探测被拒）；手改 config.json 塞进去的也不开工具，由 §运行时 的范围规则挡住。

## 探测

### 何时、走哪条路

- 只在设置卡里点「探测」时发，每个（实例，模型）一个按钮。按钮旁写「会用你的 key 发 2–3 次请求，思考模型每次可能较长」（T4）。
- 在主进程跑。kernel 新增 `provider/probe.ts` 的 `probeModel()`，desktop 的路由调用它：

```ts
export interface ProbeQuery {
  readonly definition: ProviderDefinition                 // 实例的定义（customVendorDefinition 的产物）
  readonly row: CustomModelRow
  readonly network: HostNetwork                           // host.network；探测在外面包一层只读的分流（下文）
  readonly clock: Pick<HostClock, 'now' | 'setTimeout'>
  readonly config: Record<string, string>
  readonly secrets: Record<string, string>                // 与 run-assembly 同一次 readSettledInputs 读出
  readonly maxTokens: number                              // 与 RunAssembly.maxTokens 同一算法（run-assembly.ts:237-239）
  readonly policy: PolicyState                            // desktop 传 host.policy.current()
  readonly tenantId: string                               // host.identity.tenantId
  readonly ids: { uuid(): string }                        // 探测请求的 runId
  readonly signal: AbortSignal                            // 应用退出、删除或保存 key 时中止
}
export type ProbeSnapshot = { /* 与 contracts 的 probeSnapshotSchema 同形，类型测试互赋 */ }
export function probeModel(q: ProbeQuery): Promise<ProbeSnapshot>
```

- 请求走该实例自己的 Provider：`definition.create()` 之后同一个 `encode()` 与 `stream()`（推出：这样 A9、A6 的白名单、出网收口与真实请求一致）。发之前过 02 的读稳定与 key 绑定检查（apps/desktop/src/main/provider.ts:184-247）；不过就不发，结果为失败、原因 `config`。
- 探测请求不进任何会话的 Tape，不写 `provider/attempt_completed`；不带会话内容（T4）。数据去向的确认只管会话历史（02 spec:1107），探测不触发它。
- `network` 外包一层分流：照原样转给 `host.network.fetch`，把响应体 `tee()` 一份给检查器（只用 web 标准 API，kernel 的出网口仍只有 `HostNetwork`，01 spec:109）。检查器按 SSE 事件读（与 openai SDK 的解码器同），读到 `[DONE]` 即停，读的字节不超过适配器读到的；非 2xx 的响应体不分流。它做两件事：认出思考字段（下文 ①）、找不认识的字段（§不认识的字段）。一个事件解析不了就跳过，坏帧由适配器自己报。
- 同一实例同一时刻只跑一个探测，第二个回 `busy`。探测没有总时长上限（思考模型一步可能很长，T4）；设置卡在探测进行中显示「取消」，点了走 `customVendor.cancelProbe`，主进程中止该探测的 `signal`，`customVendor.probe` 回 `refused`、`aborted`，不存结果，该行原快照不动。
- 保存：在配置锁里写进该行的 `probe`，前提是实例与模型 id 还在、且探测读稳定时以来该实例的 `providerSettingsGeneration` 没变（期间保存或清空 key、改名、改模型、删实例都算变；保存 key 在写完钥匙串后恒计一次）。不满足就不存，应答带 `saved: false`。锁内先看 `signal.aborted`，为真不存、照下条回 `aborted`。
- 中止的探测（应用退出、保存 key）回 `refused`、`aborted`，删除中止的回 `not-found`；都不存结果，该行原快照不动；退出时不为探测写 config.json。`probeModel` 见 `signal` 中止（含 `stop{ reason: 'aborted' }`）就以中止 reject，不造快照；`stop{aborted}` 不进 §结果与原因码 的表。

### 两步（Q5）

公共部分：

- 工具表：任务形态在这个实例下开表时会冻结的那张。候选取 `builtinCandidates({ profile: 'cowork', available: (name) => PRODUCT_BUILTINS.has(name), search: null })`（packages/kernel/src/tools/registry.ts:92-108），过 `openToolTable` 的排除与上限：策略、tenantId 取 `q.policy`、`q.tenantId`，没有搜索后端（WebSearch 记 `no-search-backend`），上限取定义的 `maxToolsPerRequest`。不写 `view/tool_table`。
- 不传 system、`thinking`、`effort`、`temperature`（T5）；不带 `requestParams`（Q9）。
- 输出上限：取运行时会给的值 `q.maxTokens`，不另设探测专用的上限（推出：「给足」，且端点拒收的上限值在探测里就暴露）。
- `tool_choice` 不写，即 auto（两条线的编码器都不写它）。
- 提示：一条固定的英文 user 消息，请模型调一次 `Read`，`file_path` 为 `/tenon-probe/ping.txt`，再用一句话说读到了什么。

① 第一次请求，行用 `customModelInfo(row 去掉 probe)` 再把 `supportsToolCalling` 置真（没有历史，回传格式不影响字节；推出）。

- `max_tokens` 被拒（T10）：只在 openai-chat 线、只在 ①：错误为 `invalid-request`、`status` 400，且错误点名了替代字段——`providerCode` 为 `unsupported_parameter` 且 `detail` 含 `max_tokens`，或 `detail` 同时含 `max_tokens` 与 `max_completion_tokens`（OpenAI 原文 "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."）——换 `maxTokensField: 'max_completion_tokens'` 重发一次；还拒就按下表判。只提到 `max_tokens` 的 400（取值越界、超窗）不重发，记 `request-rejected`。快照的字段：重发过记 `max_completion_tokens`；没重发且 ① 没有报错（端点收下了 `max_tokens`）记 `max_tokens`；其余（发出之前失败、① 报错且没重发）沿用该行原快照的值，没有原快照记 `max_tokens`。
- 端点拒收 `stream_options`（openai-chat 行一律带它，§合成）同样按下表记 `request-rejected`。
- 思考字段：检查器按解码器的同一表达式取 `reasoning_content ?? reasoning`，取到非空文本时记取到它的那个键名，否则记 null（openai-chat.ts:824）。

② 第二次请求，行就是「通过之后会存的那一行」：`customModelInfo({ ...row, probe: 假定通过的快照 })`。messages：① 的 user 消息；① 折叠出的 assistant 轮原样（思考块、工具调用块）；一条 user 轮，给 ① 的每个完整调用各一个合成的 `tool-response`，内容为固定文本 `ok`，`isError: false`。工具绝不派发，执行器 0 次调用。思考块按守卫的正常规则回传：openai-chat 按识别出的字段（规则 4，请求带 tools），anthropic-messages 非空签名原样送回（规则 7），空签名丢（规则 6）。末轮是 user，满足 02 的 A2。

### 结果与原因码

三态：通过；没测出来（可以再点一次）；失败（带原因码，同样能再点）。原因码与界面文案一一对应，两份 locale 各有一键 `customVendor.probe.reason.<code>`；通过一态的键是 `customVendor.probe.passed`：

| 情形 | 态 | 码 | zh-CN | en |
|---|---|---|---|---|
| ② 以 `end-turn` 或 `tool-use` 正常结束，没有错误，没有不认识的字段 | 通过 | — | 本机探测通过 · 不保证 | Probed on this computer · not guaranteed |
| ① 只回文字、拒答或内容过滤，没有工具调用 | 没测出来 | `no-tool-call` | 模型这次没有调用工具，可以再试一次 | The model did not call a tool this time; try again |
| ① 或 ② 停在 `max-tokens` | 没测出来 | `output-limit` | 输出上限内没答完，可以再试或调大输出上限 | It ran out of output tokens; try again or raise the output limit |
| ② 以其他原因结束，没有错误 | 没测出来 | `no-finish` | 带上工具结果后没有正常收尾 | It did not finish normally after the tool result |
| 发出之前：缺 key、key 绑定的主机不符、读到一半有保存、地址过不了 §地址校验 | 失败 | `config` | key 没配好 | The key is not set up |
| `auth` | 失败 | `auth` | key 无效或没有权限 | The key was rejected |
| `quota-exhausted`，或 HTTP 402 | 失败 | `quota` | 额度或余额不足 | Out of quota or balance |
| `rate-limit` | 失败 | `rate-limit` | 请求太频繁，稍后再试 | Rate limited; try again later |
| ① 的 `invalid-request`、`context-overflow`、`account-config` | 失败 | `request-rejected` | 端点拒绝了带工具的请求 | The endpoint refused a request with tools |
| ② 的同上三种 | 失败 | `echo-rejected` | 端点拒绝了工具结果或思考回传 | The endpoint refused the tool result or the thinking echo |
| ① 停在 `tool-use` 却没有完整的调用，或调了表外的工具 | 失败 | `bad-tool-call` | 模型发出的工具调用不完整 | The model's tool call was malformed |
| 检查器在 ① 或 ② 见到不认识的字段 | 失败 | `opaque-fields` | 有无法回传的字段：{fields} | It returns fields Tenon cannot send back: {fields} |
| `overloaded`、`server`、`network`、`egress-denied`、`unknown` | 失败 | `service` | 服务出错或连不上 | The service failed or could not be reached |

- `rate-limit`、`service` 是「报错」，照 Q5 记失败，文案提示稍后再试；`status` 为 402 先于 `invalid-request` 判，记 `quota`；`status` 为 429 且错误码为 `invalid-request` 时同样先判，记 `rate-limit`（百炼的限流，§运行时「错误」）。
- 不认识的字段优先：同一次响应既有错误又有不认识的字段，按 `opaque-fields` 记。
- anthropic-messages 线把 input 不是 JSON 对象的 tool_use 报成错误（码 `unknown`，`providerCode` 为 `malformed_tool_input`）；① 见到它记 `bad-tool-call`（「没有完整的调用」），不按 `unknown` 记 `service`。openai-chat 线的解码器丢掉这样的调用，① 停在 `tool-use` 没有完整调用，同样记 `bad-tool-call`。
- ① 折叠出的轮编不进 ②（canonicalJson 拒收其中的工具输入或厂商块：带 `toJSON` 键、嵌套超过 100 层）时不发 ②，记 `bad-tool-call`（Tenon 没法把这次调用带回去，与上条同理）；不用 `echo-rejected`，那条文案说的是端点拒收，而这里什么也没发。
- 顺带记下：`usageSeen`（任一次拿到 final 用量）；`responseModelId`（StreamEvent `response-model`，超过 200 字符截断，只显示，不判对错：DeepSeek 等有文档写明的别名路由）。

### 不认识的字段（Q14）

- 只在 openai-chat 线查。范围：每个 SSE 事件 `choices[*].delta`（非流式时是 `choices[*].message`）对象上的键；其中 `tool_calls[*]` 每个对象上的键；以及它的 `function` 对象上的键。块级与 choice 级的键（`id`、`model`、`usage`、`logprobs`、`finish_reason`、`system_fingerprint` 等）不查。
- 已知键：delta / message 上 `role`、`name`、`content`、`reasoning_content`、`reasoning`、`tool_calls`；tool_call 上 `index`、`id`、`type`、`function`；function 上 `name`、`arguments`。即解码器读的键去掉 tool_call 上的 `custom`、加 `role` 与 delta / message 上的 `name`（推出：带 `custom` 的调用解码器跳过，无法往返；`name` 是参与者名，不需回传，MiniMax 的 openai-chat 线每帧带 `name: "MiniMax AI"`，platform.minimax.io/docs/api-reference/text-chat-openai.md）。
- 值为 `null`、空串、空数组、空对象的键算没出现。键名区分大小写。检查器按出现顺序最多记 16 个键名，每个截到 64 字符。
- 验收目标不会被误判：智谱 `open.bigmodel.cn` 的流式 delta 只有 `role`、`content`、`reasoning_content`、`tool_calls`（另有只在 `glm-4-voice` 上出现的 `audio`），tool_call 只有 `index`、`id`、`type`、`function{name, arguments}`（docs.bigmodel.cn 对话补全参考），与 2026-09-22 的实测流一致（glm-4.6，packages/kernel/test/provider/fixtures/openai-sse.ts:117-121：每个 delta 都重复 `role`，收尾块的 delta 带 `content` 键）；DeepSeek 的 delta 只有 `content`、`reasoning_content`、`role`、`tool_calls`，收尾块里 `role` 为 null（api-docs.deepseek.com/api/create-chat-completion 的示例）。两家都在已知集合内。
- 会被挡下的（第一版只能纯文本）：方舟 doubao-seed 2.1 等型号消息级的 `encrypted_content`（volcengine.com/docs/82379/2636748）；OpenRouter 推理模型的 `reasoning_details`（openrouter.ai/docs/guides/best-practices/reasoning-tokens）；Gemini 3 在 tool_call 上的 `extra_content`（ai.google.dev/gemini-api/docs/generate-content/thought-signatures）；腾讯 TokenHub 思考模型的 `reasoning_details`（cloud.tencent.com/document/product/1823/135872）。
- 两条线的差别：anthropic-messages 线已有 01 修补 2 的原样块与 `vendorFields`，未知块、已知块上的未知字段同模型原样往返（02 spec:722-725），探测不查不认识的字段；openai-chat 线解码时丢掉它们，所以只能靠探测把住「标签不说谎」。

### 回环与私网（Q7）

- `reachOf(实例主机)` 为 `loopback` 或 `private` 的实例：设置卡不显示探测按钮，`customVendor.probe` 回 `local-endpoint`、0 次请求。
- 判定复用 desktop 的 `reachOf`（endpoint.ts:58-79），按拼写、不查 DNS。

## 运行时

### 行标记、菜单与任务形态

| 行 | `mark` | 菜单第二行（文案见 §对 02 的修补 1） | 任务形态 | `capabilitySource` |
|---|---|---|---|---|
| 公网实例、探测通过 | `probed` | `model.mark.probed` | 可选、可发 | `probed` |
| 公网实例、没有通过的快照 | `unverified-text-only` | `model.mark.unprobed` | 置灰并写明原因 | `user` |
| 回环、私网实例的行 | `local-text-only` | 照 02 的 `local-text-only` 文案 | 置灰 | `user` |

- `mark` 只增 `probed`（02 spec:901 已预告）；没通过的行沿用 `unverified-text-only`，文案换成 `model.mark.unprobed`，渲染端在条目带 `displayName`（只有实例带）时用它（推出）。
- 任务形态的置灰规则：apps/desktop/src/renderer/src/components/composer/ModelMenu.tsx:256、:336-337 现在把所有非 `verified` 的行置灰、禁发，改成「`verified` 与 `probed` 以外置灰」（Q6）。02 正文只要求两类仅文字对话的行置灰（02 spec:1118、:2886），不改 02 正文。
- 权限、审批、收口与厂商无关，照 02（Q6）。目标主机显示、「从本机切到公网」的原地确认照 02 对实例生效（02 spec:1105-1107）：实例声明了 `baseURL` 默认值、`readConfig` 又剔除了实例的 `providerConfig`（§注册表视图），`endpointOf` 与 `resolveChoice` 不用改。
- `capabilitySource` 由 run-assembly 给（mailbox 把 `assembly.capabilitySource` 写进 `session/model_selected`，packages/kernel/src/loop/mailbox.ts:959-964）：实例行通过为 `probed`，其余为 `user`（推出：`user` 在 02 里是「手填」，实例行的能力是用户填的上限加保守位）。`assemble` 对实例 id 按与 key 同一次读重造的行算（§注册表视图），不照传 `q.choice.capabilitySource`，只有它为 `probed`（续跑的冻结值，见 §不发工具）时照传；`session.modelChoice` 路由（apps/desktop/src/main/model-routes.ts:57-67）对实例 id 同样按当前行改写应答。`resolveChoice`、`selectionOf` 与 kernel 的 `choiceOf` 不改，给实例行的仍是 `builtin` / `user`（mailbox.ts:3440-3447），所以新一轮的 choice 永不带 `probed`。
- 菜单与设置卡里实例的名字用 `displayName`；一个实例一组，排在内置厂商之后。

### 不发工具

- 公网实例：run-assembly 在它这次解析出的行（与 key 同一次读重造，§注册表视图）没有通过的快照、且 `q.choice.capabilitySource !== 'probed'` 时给 `toolsWithheld = 'not-probed'`，否则给 null。续跑与重开已用 provider 的表时，choice 带冻结的 `capabilitySource`（mailbox.ts:1721、:2282），冻结时通过即为 `probed`，所以续跑照冻结的行发工具（`RunAssembly.model` 只管新一轮，`toolsWithheld` 两种都管：mailbox.ts:2242、run.ts:1634）。新一轮的 choice 由 `resolveChoice` / `choiceOf` 给，按当前行判。给了 `not-probed` 时 kernel 照常开表、冻结，请求省略 `tools`，由带转不带的第一次写 `view/tools_withheld`，`reason: 'not-probed'`（T9）。kernel 只看标记，不按 providerId 特判（02 spec:2071 的写法）。
- 回环、私网实例：run-assembly 给 `'provider-text-only'`，与 Ollama 同一条范围规则（02 裁决 A14；run-assembly.ts:60、:240）；两种形态都不发工具。
- 换回通过的行或别的带工具的行，照冻结原文重发（02 裁决 E2）。

### 前缀检查（Q2 附带）

- `checksThinkingPrefix`（packages/kernel/src/loop/compaction.ts:16-18）改读 `ModelInfo.checksThinkingPrefix`。内置 anthropic 的 `claude-opus-5-5`、`claude-fable-5-1` 两行写 `true`（数据改动）；全部自定义行写 `false`；其余内置行不写。
- 键缺省时照 02 的规则只按 id 判：id 是上面两个之一的读作 true，不看 `providerId`，其余读作 false（02 spec:2573）。M6 之前冻结在 Tape 里的 model_info 没有这一键，判法因此与 M6 之前相同（推出：续跑取冻结的行，02 spec:362）；自定义行恒写 false，id 叫什么都读作 false。

### 搜索（Q10）

- 自定义实例没有搜索后端：run-assembly 只给 `zhipu`、`anthropic` 两个定义 id 建后端（run-assembly.ts:316-327），不改；开表时 WebSearch 记 `no-search-backend`（02 spec:2738）。WebFetch 是本机抓取，照常在表里。
- 设置卡的实例区写一句「自定义厂商不提供网络搜索；网页抓取照常」（Q10）。

### 错误（T11）

- 实例只认两条线已有的标准映射，不声明 `finishReasons`，不加按厂商的错误词表（T11）。
- 已知局限：openai-chat 线的错误映射里写死了智谱的数字码（1113、1261、1302、1308–1311、1313–1321）和中文溢出短语（openai-chat.ts:1222-1258、errors.ts:234-235），对所有走这条线的厂商生效；Anthropic 线的花费上限识别同样对所有网关生效（anthropic-messages.ts:1292-1330）。别家碰巧回同样的码会被这样归类。百炼的 TPM/TPS 限流回 429 `insufficient_quota`（help.aliyun.com/zh/model-studio/error-code），按 OpenAI 词表读作不可重试的 `invalid-request`（openai-chat.ts:1249、:1190）。有的预设厂商用 429 表示余额或计费停用，不是限流，等多久都不会好：Kimi 的 `exceeded_current_quota_error`（两条路由；platform.kimi.ai/docs/api/errors），方舟的 `SetLimitExceeded`（用量上限，服务已暂停）与免费额度用完的 `QuotaExceeded`（方舟另有排队任务超限的 `QuotaExceeded`，是真的可重试限流，只看码分不开；volcengine.com/docs/82379/1299023），百炼的 `PrepaidBillOverdue`、`PostpaidBillOverdue`、`BudgetLimitExceeded`、`CommodityNotPurchased`（help.aliyun.com/zh/model-studio/error-code）。两条线都按 429 读作可重试的 `rate-limit`：运行时重发到 3 次，以限流失败卡（稍后再试）结束；探测记 `rate-limit`。第一版不改。
- HTTP 401 一律读作 `auth`，先于响应体里的错误码与类型（点名 (h)）：DeepSeek 对错 key 回 401 `{type: 'authentication_error', code: 'invalid_request_error'}`（2026-10-01 实录，厂商调研，两条路由同一个 body），openai-chat 线原先先读 `code`、归成 `invalid-request`，运行时与探测都显示成「请求被拒」；现在两条线运行时与探测都读作 `auth`，/models 按状态回 `auth`。403 不动：体里没有已知码时照状态表读作 `auth`；openai-chat 线体里的不可重试词表码仍先于状态（如带 `invalid_request_error` 的 403 读作 `invalid-request`）。
- 已知局限（接受）：Kimi、方舟、百炼的余额或账单类 429 照 HTTP 码读作可重试的 `rate-limit`，重试次数照 02 的上限；第一版不加按厂商的词表（T11）。
- 已知局限：会话中途从别的 provider 或模型切到 DeepSeek 这类「带 tools 时要求所有历史轮的 `reasoning_content`」的端点（api-docs.deepseek.com/guides/thinking_mode），守卫规则 1、2 丢掉的轮会让每次带工具的请求 400；探测测不出，第一版不处理，失败卡照 02。

### 实例被删或改坏（T12）

- 「改坏」指：实例被删；会话所选的模型 id 从实例的列表里删了；实例的 key 被清空。
- 新一轮（`user-message` 或 `continue`）：①（本会话的选择）照 02 优先（02 spec:1097-1099），不回落到形态默认。拿不到定义或行按配置错误处理，照 02 的「缺 key」什么都不写，`run-ended{ recorded: false }`（`provider-error`，`errorCode: 'auth'`，02 spec:432）。实例的行没了：`assemble` 对实例只按 id 在 `builtinModels` 里找，不调用会合成的 `selectModel`；找不到就走 run-assembly.ts:171-172 的 `definition === null || model === null` 分支，由 `provider()` 抛 `ProviderConfigMissingError`，`assemble` 本身不 reject（packages/kernel/src/loop/ports.ts:50）；`resolveChoice` 里照 `definitionOf` 抛（推出）。
- 续跑：沿用暂停时冻结的 provider、模型（02 不变量 25）；provider 建不出来就以 `provider-error` 结束这一轮，不自动换模型（02 spec:1102）。
- 保存实例 key 清掉快照之后，暂停中的 Run 续跑仍用冻结的那一行、照发工具（§不发工具），下一条用户消息起才按新快照（推出：02 不变量 25）。
- 文案单列：失败卡在会话选择的 providerId 合 `custom-` 式、而 `provider.list` 里没有这个实例或这一行时（只看有没有，不看 `configured`；地址过不了校验的实例照列，§存储），第一行用 `error.customVendorGone`（与 `error.auth` 并列）：「这个会话用的自定义厂商或模型已删除。在模型菜单里换一个模型再发送。」/ "This conversation's custom provider or model was removed. Pick another model in the model menu and send again."；key 被清空的照 02 的缺 key 文案。模型菜单的触发器在同样条件下写模型 id 加「（已删除）」。

## IPC

新文件 `packages/contracts/src/ipc/custom-vendor.ts`，全部经 `defineRoute`、两向 schema 校验，主进程用 `registerRoute` 注册（AGENTS.md 硬规则）。渲染端不碰 Node；key 只从渲染端单向交给主进程，任何应答都不带回 key。

```ts
export const customVendorErrorCodeSchema = z.enum([
  'invalid-address', 'https-required', 'subscription-endpoint', // §地址校验
  'key-required',        // 公网实例新建时没给 key
  'not-found',           // 实例已不存在
  'keychain',            // 钥匙串读、写或删失败，什么都没改（或已按 §写入规则 回退）
])
export const customVendorWriteResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), code: customVendorErrorCodeSchema }),
])
export const vendorPresetSchema = z.object({
  id: z.string().min(1), nameKey: z.string().min(1), defaultWire: wireSchema,
  regions: z.array(z.object({ id: z.string().min(1), labelKey: z.string().min(1),
    keyPageURL: z.string().url().nullable(),
    endpoints: z.object({ 'openai-chat': z.string().url().optional(), 'anthropic-messages': z.string().url().optional() }) })),
})
export const customVendorList = defineRoute('customVendor.list', {
  request: z.object({}),
  response: z.object({ presets: z.array(vendorPresetSchema),
    instances: z.array(customVendorSchema.extend({ refused: providerRefusalSchema.optional() })) }), // §存储；schema 见 §对 01 的修补 4
})
export const customVendorCreate = defineRoute('customVendor.create', {
  request: customVendorSchema.pick({ displayName: true, wire: true }).extend({
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('preset'), presetId: z.string().min(1).max(64), regionId: z.string().min(1).max(64) }).strict(),
      z.object({ kind: z.literal('custom'), baseURL: customVendorSchema.shape.baseURL }).strict()]),
    apiKey: z.string().max(PROVIDER_VALUE_MAX_LENGTH) }).strict(),
  response: z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), id: customProviderIdSchema }),
    z.object({ ok: z.literal(false), code: customVendorErrorCodeSchema })]),
})
export const customVendorUpdate = defineRoute('customVendor.update', { // 改名与模型；没有地址和线协议（T2）
  request: z.object({ id: customProviderIdSchema, displayName: customVendorSchema.shape.displayName.optional(),
    models: z.array(customModelSchema.omit({ probe: true }).strict()).max(200).refine(distinctIds).optional() }).strict(),
  response: customVendorWriteResultSchema,
})
export const customVendorDelete = defineRoute('customVendor.delete', {
  request: z.object({ id: customProviderIdSchema }).strict(), response: customVendorWriteResultSchema,
})
export const customVendorFetchModels = defineRoute('customVendor.fetchModels', { // T7：只在点按钮时
  request: z.object({ id: customProviderIdSchema }).strict(),
  response: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), models: z.array(z.object({ id: modelIdSchema,
      contextLimit: z.number().int().positive().optional(), maxOutputTokens: z.number().int().positive().optional() })) }),
    z.object({ ok: z.literal(false), code: z.enum(['not-found', 'config', 'auth', 'unsupported', 'service']) }),
  ]),
})
export const customVendorProbe = defineRoute('customVendor.probe', {
  request: z.object({ id: customProviderIdSchema, modelId: modelIdSchema }).strict(),
  response: z.discriminatedUnion('status', [
    z.object({ status: z.literal('done'), snapshot: probeSnapshotSchema, saved: z.boolean() }),
    z.object({ status: z.literal('refused'), code: z.enum(['not-found', 'unknown-model', 'local-endpoint', 'busy', 'aborted']) }),
  ]),
})
export const customVendorCancelProbe = defineRoute('customVendor.cancelProbe', { // 用户取消进行中的探测
  request: z.object({ id: customProviderIdSchema }).strict(),
  response: z.object({ cancelled: z.boolean() }), // 该实例没有进行中的探测时为 false，什么都不做
})
```

- T2 在路由层：`update` 用 `.strict()`，带 `baseURL` 或 `wire` 的请求过不了 schema；`provider.configure` 对实例只收 `apiKey`，带 `baseURL` 回 `invalid-value`（`configKey: 'baseURL'`），什么都不写。
- `create` 的 `source` 为预设时，主进程按 `presetId`、`regionId` 从 presets.ts 取该 `wire` 的地址；预设或地区不存在、该地区没有这条线，回 `invalid-address`。`presetId` 只在这种情况下存进条目（推出：预设地址只读不能只靠渲染端，AGENTS.md:19）。
- `create` 的 `apiKey` 去掉首尾空白后为空：公网实例回 `key-required`，回环、私网实例照存（不写 key）。
- 实例改 key 照用 `provider.configure`，附带 §写入规则 的清快照；`provider.list` 照列实例条目（§对 01 的修补），设置卡的「已配置」照 02 的算法，`keyRequired` 为 false 的实例除外（§key）。
- 通用的 ProviderSettings 卡跳过带 `displayName` 的条目（它现在把每个条目的每个 configKey 渲染成输入框，ProviderSettings.tsx:293）；实例的 key 与只读地址只在实例区显示。

## 对 01 的修补

01 已 `implemented`。下面全部只增，01 正文不改，01 顶部加一行 `Amended by`（§文档同步）。读法照 02 的 01 修补 1：给既有对象类型加可选键算新增成员。

1. **`ModelInfo` 只增两个可选键**（T10；Q2）：

```ts
export interface ModelInfo {                              // 已存在（packages/kernel/src/provider/types.ts:28）
  /** 输出上限写在哪个键（T10）。缺省 = 'max_tokens'，即 01 的行为；只有 openai-chat 线读，anthropic-messages 的行不写（definitions 测试断言） */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  /** 这个模型按思考块产生时的前缀校验回传（02 §压缩时机与估算）。缺省 = 按 02 的 id 规则（compaction.ts:16-18）；encode 不读 */
  checksThinkingPrefix?: boolean
}
```

2. **`ProviderDefinition` 只增可选的 `maxToolsPerRequest?: number`**（T13；先例是 02 的 `finishReasons`）。每个请求最多带几个工具；缺省为不按个数裁。`zhipu` 写 128（原 packages/kernel/src/tools/registry.ts:55-57 的常量搬到 zhipu.ts），`anthropic`、`ollama` 不写，工厂写 128。
3. **openai-chat 编码器**：`maxTokensField === 'max_completion_tokens'` 时写 `max_completion_tokens`、不写 `max_tokens`，值仍取 `req.maxTokens ?? model.maxOutputTokens`（01 spec:289）；请求快照的 `maxTokens` 照记。`RESERVED_KEYS`（openai-chat.ts:144-153）加 `max_completion_tokens`，`requestParams` 不能再写它（现有行都没写）；openai-chat.ts:137-138 注释里把它当透传的那句改写为「由 `maxTokensField` 写出」（照 02 spec:733 改 :414-418 注释的先例）。编码器版本 1 → 2（02 spec:979：凡改变编码结果的提交都加一）；anthropic-messages 编码器不变（仍是 3）。金样（packages/kernel/test/provider/wire/encoder-version.test.ts）：金样请求的 `OPENAI_ROW` 加 `maxTokensField: 'max_completion_tokens'`，`GOLDEN['openai-chat']` 追加版本 2 的哈希（与版本 1 不同，body 里只有 `max_completion_tokens`）；另加一条断言：同一请求去掉该字段时 `promptHash` 仍等于版本 1 那行（内置行字节不变，M6 不变量 5）。
4. **contracts `provider.ts`**：
   - `providerEntrySchema` 只增 `displayName: z.string().min(1).max(64).optional()`：只在自定义实例的条目上有，内容是用户起的名字，渲染端优先用它，没有才解析 `nameKey`；另只增 `refused: providerRefusalSchema.optional()`，`providerRefusalSchema = z.object({ code: z.enum(['official-host-only', 'subscription-endpoint', 'invalid-address', 'https-required']), origin: z.string().optional() })`：内置 zhipu、anthropic 当前生效地址的源不是官方源时给 `official-host-only` 与这个源（§点名 (b)、(c)），zhipu 生效地址的路径含订阅路径时给 `subscription-endpoint`（§点名 (b)），实例地址过不了 §地址校验 时给表里的码（§存储）。
   - `providerWriteErrorCodeSchema`（provider.ts:119-125）只增 `'official-host-only'`（§点名 (a)）与 `'subscription-endpoint'`（§点名 (e)）。两份 locale 各加 `settings.providers.error.officialHostOnly`、`settings.providers.error.subscriptionEndpoint`，ProviderSettings.tsx:404-412 的 `ERROR_KEY`（`satisfies Record<CardErrorCode, string>`）同一步补这两项。
5. **contracts `config.ts`**：`configSchema` 只增 `customVendors`（§存储）。旧文件没有这个键，解析为 `[]`。
6. **desktop 接线**：
   - 注册表视图（§注册表视图）：主进程交给 run-assembly、provider 路由与模型路由的是视图（apps/desktop/src/main/index.ts:136-137、:165-172、:292-299 现在交内置注册表）。
   - `provider.configure` 对实例：只收 `apiKey`；保存前清快照（§写入规则）。对内置：§点名 (a)、(e)。
   - `provider.list` 对实例：条目带 `displayName`，`nameKey` 为通用键，模型行按 §运行时 的表给 `mark`，不给 `effortLevels`。
   - key 的账户名照 01 spec:142 与 `providerSecretKey`（apps/desktop/src/main/provider.ts:295-301），实例 id 只是又一个 `ProviderId`。

## 对 02 的修补

02 已 `implemented`。下面全部只增或收紧 02 标「暂定」的选型，02 正文不改，02 顶部加一行 `Amended by`（§文档同步）。

1. **`modelMarkSchema` 只增 `'probed'`**（packages/contracts/src/ipc/provider.ts:38；02 spec:901）。两份 locale 加 `model.mark.probed`「本机探测 · 不保证 · {host}」/ "Probed on this computer · not guaranteed · {host}" 与 `model.mark.unprobed`「尚未通过探测 · 仅文字对话 · {host}」/ "No passing probe · text conversation only · {host}"。
2. **`capabilitySource` 只增 `'probed'`**：kernel `CapabilitySource`（packages/kernel/src/loop/ports.ts:20）、`ModelSelectedPayload.capabilitySource`（packages/kernel/src/tape/entry.ts:208；02 spec:974）、`session.modelChoice` 的应答（packages/contracts/src/ipc/session.ts:232；02 spec:880）同步。
3. **`ToolsWithheldPayload.reason` 只增 `'not-probed'`**（entry.ts:333；02 spec:1230-1233），`RunAssembly.toolsWithheld` 的联合同步只增这个值（ports.ts:65；02 spec:366，「值与 ToolsWithheldPayload.reason 同名」）。这是给已有成员的联合加枚举值，不是加成员，按 spec-driven-dev.md:54 的「新增枚举值」处理。
4. **`RunConnector` 只增可选成员 `toolsPerRequest?(providerId: ProviderId): number | null`**：同步、不读密钥，desktop 返回该定义的 `maxToolsPerRequest ?? null`；kernel 开表（含摘要压缩时给每个用过的 provider 重开）按它裁，没有这个成员或返回 null 就不按个数裁（撤掉常量见 §点名 (g)）。收紧 02 spec:2005 的「上限写成 kernel 里按 `ProviderId` 查的常量（暂定）」；端口只增可选成员，合 02 开放问题 26。
5. **`checksThinkingPrefix`** 改读 `ModelInfo` 字段（02 spec:2573 已写明要只增修补 01；本 spec §对 01 的修补 1），旧行按 §运行时「前缀检查」回落。
6. **`WIRE_MODEL_FIELDS`**（packages/kernel/src/provider/wire/shared.ts:153-164；02 spec:980）加 `maxTokensField`；`checksThinkingPrefix` 不加（encode 不读）。新字段缺省时内置行的 `modelWireHash` 不变（缺的键不进 pick，shared.ts:171-178）。
7. **run-assembly 的范围规则**（02 裁决 A14 的「不带工具的 provider 名单」）扩到回环、私网实例，并给公网实例没通过的行 `'not-probed'`（§运行时「不发工具」）。
8. **界面**：模型菜单的置灰条件、行标记、实例分组与名字（§运行时）；设置卡加实例区。都是 02 §界面范围 之内的只增。

## 点名：不属纯粹只增的改动

照 02「对 01 修补 · 9 点名」的先例。(a)、(b) 的「读作未配置 + 一句提示」、(d) 的 live 组与评测行、(f) 直接出自 owner 2026-10-02 选定的 Q8；(b) 的 `refused` 与按钮、(a)–(c) 按 https 源判、(c) 的读法、(e)、(g) 与下面的测试接缝是推出，列在 §推出的读法，owner 2026-10-02 已过目接受。不 supersede 02。

| | 改了什么 | 为什么仍算 amend |
|---|---|---|
| (a) | `provider.configure` 拒绝把 `zhipu` 的 `baseURL` 改到源 `https://open.bigmodel.cn` 以外、把 `anthropic` 的改到 `https://api.anthropic.com` 以外（协议、主机、端口都比），返回 `official-host-only`（`configKey: 'baseURL'`），什么都不写；02 允许改指别处并仍标 `verified`（02 spec:78、:2886；开放问题 23，02 spec:3389）（Q8） | 02 spec:3402 把这些行交给 M6 二选一，并要求点名；owner 选「改走自定义入口」 |
| (b) | 已存的非官方地址升级后读作未配置：`provider.list` 的 `configured` 为 false 并带 `refused`（`official-host-only` 与被拒的源），设置卡一句话提示「这个地址只能用自定义厂商接入」并给「新建自定义厂商」按钮；内置 `zhipu` 已存地址的路径过不了 §地址校验 4 时同样读作未配置，`refused` 的码为 `subscription-endpoint`，设置卡用它的文案，不给按钮；发送按 `ProviderConfigMissingError` 拒绝，0 次请求；不自动迁移（Q8） | 同上；不做迁移，因为仓库没发过版，只影响 owner |
| (c) | 开发期回落：`DEV_ENV_FALLBACK`（apps/desktop/src/main/provider.ts:40-49）照旧读 `ANTHROPIC_BASE_URL`，指向官方源以外时 `anthropic` 读作未配置、`provider.list` 照 (b) 带 `refused`、记一行日志（Q8）。01 spec:708 的变量名不变 | 收紧环境变量能给的值；实例没有环境变量入口，开发期改在设置卡建实例 |
| (d) | `.env.example`：第 5–11 行（`ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic` 与兼容端点的 key 说明）改成注释：Anthropic 线的开发对话在设置卡建 anthropic-messages 实例（`https://open.bigmodel.cn/api/anthropic`，按量 key）并在模型菜单选中；`ANTHROPIC_AUTH_TOKEN` 不再给兼容端点用（否则 key 绑到默认主机 api.anthropic.com）。第 23–27 行只留 `TENON_LIVE_MAX_TOKENS`（:25，各组都读），`TENON_LIVE_MODEL`、`TENON_LIVE_AUTH_TOKEN` 只有仿真组读，随它删掉；第 29–30 行改成「内置智谱组与两组智谱实例都用 `ZHIPU_API_KEY`（按量 key）」；第 39–42 行改成「默认 zhipu；改成 anthropic 只走官方端点，Anthropic 线的开发对话在模型菜单选实例」；`TENON_PROVIDER=zhipu`（:43）改为默认生效，开发期日常对话走内置智谱（Q16）。live 套件的 Anthropic 线仿真组（apps/desktop/e2e/live-provider.spec.ts，glm-4.7-flash 经智谱 `/api/anthropic`）改成 anthropic-messages 实例组；评测专用行 `EVAL_GLM_53_ANTHROPIC`（apps/desktop/evals/models.ts）不再挂在 `anthropic` 定义上，改成实例列（Q8） | 测试与开发设置，不是产品契约；评测记录的列名不变（client、model、endpoint 都不变）；实例行没有 pricing，评测 runner 算费用时，这一列用它的评测专用价（¥8 / ¥28 每百万 token），不读 model_info 的 `pricing`（实例行每个 Run 由工厂按 `customVendors` 重造，包在定义外的价格到不了模型行），02 同模型列（02 spec:3078）的费用照算（Q17） |
| (e) | 内置 `zhipu` 的 `baseURL` 路径含 `/api/coding/paas/v4` 时拒存，返回 `subscription-endpoint`（Q13 的手填规则同样管内置厂商的手填地址） | 收紧未限定的选型；Coding Plan 不得在自建应用里调用（ADR-003「订阅登录不是 provider」） |
| (f) | 删掉 02 spec:2738 的分支「`anthropic` 定义指向 `/api/anthropic` 时用智谱搜索」：`searchDefinitionFor`（run-assembly.ts:316-327）只剩 zhipu → 智谱后端、anthropic + `api.anthropic.com` → Anthropic 后端（Q8） | 有 (a) 之后这条分支没有输入能走到；02 正文不改，以本条为准 |
| (g) | `TOOLS_PER_REQUEST`（packages/kernel/src/tools/registry.ts:55）撤掉、开表改读 `RunConnector.toolsPerRequest`（T13）：不实现它的 connector 不再按 zhipu 128 裁。仓库内三个实现方同一改动里补上：desktop 的 run-assembly.ts、apps/desktop/evals/runner.ts:207 的 `watchedConnector`（逐个转发成员）、kernel testing/loop-ports.ts:288 的 `createTestConnector` | 收紧 02 spec:2005 标「暂定」的选型；产品与评测今天只有内置工具，内置工具从不被裁（table.ts:64-65） |
| (h) | 两条线的错误映射里，HTTP 401 先于响应体的错误类型读作 `auth`（§运行时「错误」）：同样的 401 响应体，原先可能归成 `invalid-request` | 收紧一个原本按体判的分类；401 就是凭据被拒，内置厂商的 401 本来都读作 `auth` |

- 02 的 key 绑定主机、「已配置」算法（01 修补 6）不变，只多「源不是官方源」与 zhipu 订阅路径两种读作未配置；实例另见 §key。
- 评测的实例列跑之前先用同一个 `probeModel` 探测，不通过就不跑（推出：Q6 的工具只在探测通过后开，评测不另开豁免）。
- 测试宿主的官方 key 守卫扩到实例：e2e 与 live 往实例填 key 的助手在填入前检查，值像官方 key（`sk-ant-` 开头）而实例主机不是 `api.anthropic.com`，就抛错、不填（02 裁决 M4；启动时的 `assertOfficialKeyStaysHome`，apps/desktop/e2e/helpers/app-env.ts:83-97，看不到实例 key）。
- 测试接缝（推出）：未打包、`TENON_DEV_ENV=off`（只由测试启动器设，apps/desktop/e2e/helpers/app-env.ts:53；所以 `pnpm dev` 与 `.env.local` 开不了它）且设了 `TENON_TEST_ORIGIN_MAP`（`<https 源>=<http://127.0.0.1:port>`，逗号分隔）时，host.network 外面包一层，把列出的源改投到本机假服务器；左边不是 https 源、右边不是 `http://127.0.0.1:<port>` 或 `http://[::1]:<port>` 时主进程拒绝启动。做法照 apps/desktop/src/main/host/official-protocol-test-seam.ts:21-29，打包构建不读这个变量，`TENON_*` 也进不了 agent 的命令（apps/desktop/src/main/host/shell-env.ts:39）。官方源判定、`reachOf`、key 绑定与 A9 一律按改投之前的 URL 判。它进 `NEVER_INHERITED`（app-env.ts:20-27，apps/desktop/test/live-env.test.ts 钉住），只经 e2e 助手的 `options.env` 传；`assertOfficialKeyStaysHome` 在它存在且环境里有像官方 key 的值（`sk-ant-`）时拒绝启动。它还要 `TENON_SECRETS=memory`（测试启动器缺省就是）：钥匙串各 profile 共用同一个账户，开发者日常存的官方 key 在那里、环境里的守卫看不见，所以设了映射而机密不走内存时主进程与 e2e 启动器都拒绝启动（02 裁决 M4）；live 套件在运行者环境或 `.env.local` 里见到它就拒跑（否则官方组的 key 会被改投，02 裁决 M4）。02 现有指向 127.0.0.1 的 e2e（apps/desktop/e2e/helpers/tools.ts:13-15 的 `providerEnv` 等）与 desktop 单测改成「官方源 + 本接缝」（单测也可改用 fakeNetwork）；实例的 e2e 用 `https://vendor.e2e.test` 这类公网形主机。改投后内置行就是官方主机，`searchDefinitionFor` 会为 zhipu、anthropic 建搜索后端，依赖工具表或主机显示的 e2e 断言随之重定基线；专测回环显示、「从本机切到公网」确认的用例改用 Ollama 或回环实例。

## 文档同步

本 spec 起草时一起改（都只改所列的句子）：

- `AGENTS.md:7` 的「starts from `docs/architecture/<goal>/spec.md`」补上 features spec；`AGENTS.md:9` 与 `docs/spec-driven-dev.md:62` 的开工规则补一句：没有进行中的 architecture spec 时，找 `docs/features/*/spec.md` 里 `Status: ready`、plan 还有未勾步骤的那份，同时有两份就问（Q1）。
- 01、02 顶部各加一行 `Amended by`，正文一字不改（spec-driven-dev.md:54）。
- ADR-003 加一行带日期的勘误：实例 id 以 `custom-<uuid>` 为准（T1）。
- `docs/spec-driven-dev.md:5`、`:64` 去掉「在 Claude Desktop 项目里讨论」：架构由 owner 拍板，在哪个会话起草都行（owner 2026-10-01 另行决定；不属 M6 裁决，同批提交）。

实现时改（列在 plan）：`.env.example`（§点名 (d)）；`docs/ux/components.md:95` 的模型行补 `probed` 与「尚未通过探测」两种行标记；两份 locale 的新键。

## 不变量

每条有一个名字带「M6 不变量 N」的测试。

1. 每个实例 id 匹配 `CUSTOM_PROVIDER_ID_PATTERN`，并能作为 `toolTableKey` 的 provider 段通过 provenance 校验。
2. 没有任何路由能改实例的 `wire` 或 `baseURL`；改了它们的请求要么 schema 不过，要么返回拒绝且 config.json 不变。
3. 实例请求发往的主机、`provider.list` 的 `endpoint`、`session/model_selected` 的 `endpointOrigin` 与数据去向确认所比的主机，都等于实例 `baseURL` 的主机，与 config.json 的 `providerConfig` 里写了什么无关；实例的请求、探测与 /models 不跟随任何 3xx；地址过不了 §地址校验 的实例（含手改成公网 `http://` 的）0 次请求，`provider.list` 给 `configured: false` 与 `refused`。
4. encode 读的实例数据全在 ModelInfo 上：清空注册表后，对实例的每条 attempt 用组装清单里的 model_info 复算，`promptHash` 相等（沿用 02 不变量 33）。
5. 新字段缺省时，内置行的请求 body、`promptHash` 与 `modelWireHash` 与 M6 之前逐字节相同。
6. 自定义行的 `supportsToolCalling` 为真，当且仅当它的快照 `outcome` 为 `passed`。
7. 回环、私网实例的请求永不带 `tools`，也永不发起探测请求。
8. 探测请求只经实例 Provider 的 `encode()`、`stream()` 与 `host.network`，不写任何会话 Tape 事实，探测期间工具执行器 0 次调用。
9. 探测 ② 用的 ModelInfo 与通过后存下的快照合成出的 ModelInfo 相同（`modelWireHash` 相等）。
10. openai-chat 线的响应在 §不认识的字段 的范围内（delta / message、tool_call、function 对象上）出现已知集合之外的非空键时，结果不是 `passed`。
11. 自定义实例的请求里没有 `requestParams` 写的键、思考档位、`thinking` 对象和白名单之外的请求头。
12. 保存实例 key 的写入完成后，该实例没有任何 `probe`，直到一次在这次保存之后才开始的探测通过；开始早于这次保存的探测结果不存（含写 key 失败）。
13. 新建或删除实例的任一步失败之后，不会出现可被任何实例读到、却不属于 config.json 里某个实例的 key。
14. 实例的 key 只在钥匙串，账户带 tenantId；config.json、IPC 应答、日志里没有 key 的值。
15. 自定义实例的工具表里永远没有 WebSearch（`no-search-backend`）。
16. 内置 `zhipu`、`anthropic` 当前生效地址的源不是官方 https 源（`https://open.bigmodel.cn`、`https://api.anthropic.com`），或 `zhipu` 生效地址的路径含订阅路径时，发送 0 次请求，`provider.list` 的 `configured` 为 false。
17. 自定义行的 `checksThinkingPrefix` 读作 false，id 叫什么都一样；Opus 5.5、Fable 5.1 的内置行，以及没有这一键、id 是这两个之一的旧行（不看 `providerId`），读作 true。
18. 冻结行带工具的续跑，`toolsWithheld` 为 null。
19. 打包构建不读 `TENON_TEST_ORIGIN_MAP`；改投之后官方源判定、key 绑定、`reachOf` 与 A9 仍按改投前的 URL 算。

## 验收标准

全部通过才能标 implemented。不注明的在 CI 里跑夹具；〔智谱 live〕用 `.env.local` 的智谱 key 跑 `pnpm test:live`；〔DeepSeek live〕用钥匙串里的 DeepSeek key（plan 开头）。按文档写的夹具在测试名与夹具文件头标「按文档、未实测」。

### 身份与工厂

1. 新建实例得到 `custom-<uuid>` 形的 id；在实例上开表写出的 `view/tool_table` 键含这个 id，内存与 SQLite 两个 store 的 conformance 都通过（T1）。
2. 01 验收 1 的「第四个定义」路径：用工厂从纯数据造两个实例（两条线各一），经同一条 kernel 调用路径回放夹具，事件序列与 Tape 事实与内置定义同形；清空注册表后，这些 attempt 的 promptHash 复算相等（02 不变量 33）。
3. 新建、改名、改模型、删除实例后，`provider.list` 立即反映，不用重启；内置三家的条目与顺序不变。

### 地址、预设与 key

4. 公网 `http:`、带 userinfo、带 query 或 fragment、anthropic 线以 `/v1` 结尾、路径含 `/api/coding/paas/v4` 的地址都拒存，各回 §地址校验 表里的码，钥匙串与 config.json 不变；回环、私网的 `http:` 地址可存。`customVendor.create` 的预设或地区不存在、该地区没有所选线时回 `invalid-address`；公网实例 apiKey 去空白后为空回 `key-required`，钥匙串与 config.json 不变。
5. `customVendor.update` 带 `baseURL` 或 `wire` 时 schema 校验失败；`provider.configure` 对实例带 `baseURL` 回 `invalid-value`，什么都不写（T2）。
6. `customVendor.list` 的预设逐条等于 §预设 表：MiniMax 两地区默认 anthropic-messages，智谱国际站只有 openai-chat，方舟没有 anthropic 地址，没有任何地址含订阅路径，每个 key 链接都是按量 key 页（Q4、Q13）。
7. 主机为 `open.bigmodel.cn`、`api.z.ai` 的实例显示按量 key 与订阅协议的提醒；主机为 `api.minimax.cn`、`api.minimax.io`、`api.minimaxi.com` 的实例显示「填接口密钥页的按量 key」的提醒（Q13）。
8. 实例的 key 只在账户 `<tenantId>:provider:custom-<uuid>:apiKey` 下；config.json、`provider.list`、`customVendor.list` 的应答与日志里都没有它（T8）。

### 存储

9. 删除实例：删钥匙串失败时整次拒绝、config.json 不变；成功后条目与 key 都没了，其他实例与内置厂商不受影响（T8）。
10. 在设置卡保存实例的 key 之后，该实例全部快照清空、各行变回仅文字；写 key 失败时快照同样已清；快照不随时间过期（T3）。
11. M6 之前写的 config.json（没有 `customVendors`）照常解析，`customVendors` 为空、其余键不变；有一条坏实例条目的文件只丢那一条，其余实例照读（T8）。

### 模型行与探测

12. 不点「获取模型列表」时对 /models 0 次请求；/models 带 §列表与上限 的字段时预填；上下文或输出缺一样的行不能保存；可以手填 id；`provider.select`、`session.selectModel` 对实例表外 id 回 `unknown-model`（T6、T7）。
13. 通过的行逐字段等于 §模型行 的合成表；没通过的行不带工具，openai-chat 行 `thinkingPreservationFormat` 为 `drop`、anthropic-messages 行为 `signed-blocks`；openai-chat 实例行的请求带 `stream_options.include_usage: true`，百炼按文档写的夹具（用量只在末尾空 choices 块）探测记 `usageSeen: true`。
14. 探测只在点按钮时发，按钮旁有 T4 的文案；每次至多 3 次请求：通过时 2 次（T10 换字段重试时 3 次），① 没测出来或失败时不发 ②，发出前失败 0 次；经实例自己的 Provider 与 host 网络，请求头都过 A6 白名单，请求里没有会话内容，任何会话的 Tape 都不多事实（T4）。探测中保存 key 或点「取消」（`customVendor.cancelProbe`）回 `aborted`、删除实例回 `not-found`，都不存结果，原快照不变。
15. 两步：① 回工具调用、② 正常收尾 → 通过；① 只回文字 → 没测出来；① 报错 → 失败（按错误码）；② 报 400 → `echo-rejected`；每个原因码在 zh-CN、en 都有非空文案；快照记下 `usageSeen` 与 `responseModelId`，响应里的模型名与请求的 id 不同不影响结果（Q5）。
16. ① 因 `max_tokens` 被按字段名拒绝时换 `max_completion_tokens` 重试一次，快照记下；之后这一行的请求只写 `max_completion_tokens`；只提到 `max_tokens` 的取值越界 400 不重试、记 `request-rejected`（T10）。
17. 响应 delta 或 tool_call 上带 `encrypted_content`、`reasoning_details`、`extra_content` 的三个夹具探测失败（`opaque-fields`，文案列出键名）；DeepSeek 按文档写的夹具、智谱按实测形状写的夹具（每帧带 `role`、收尾块 delta 带 `content`；含值为 null 的键）、MiniMax 按文档写的 openai-chat 夹具（每帧 delta 带 `name: "MiniMax AI"`、`audio_content: ''`）通过（Q14）。
18. 回环、私网实例：设置卡没有探测按钮，`customVendor.probe` 回 `local-endpoint` 且 0 次请求；行标 `local-text-only`，两种形态的请求都不带 tools，`tools_withheld` 为 `provider-text-only`；不填 key 的回环实例 `configured` 为 true、在对话形态的菜单里可选（Q7）。

### 运行时

19. 通过的行标「本机探测 · 不保证」，`session/model_selected` 的 `capabilitySource` 为 `probed`，任务形态可选、可发，审批照常；没通过的行标「尚未通过探测 · 仅文字对话」、任务形态置灰、请求不带 tools、有一条 `tools_withheld`（`not-probed`）；实例行没有思考档位子菜单，`provider.list` 的实例行没有 `effortLevels`（Q6、T9、T5）。
20. 实例行显示目标主机；会话从本机切到公网实例时照 02 原地确认，确认前对该主机 0 次请求。
21. 实例的工具表里没有 WebSearch（`excluded` 记 `no-search-backend`），有 WebFetch；设置卡写明没有搜索（Q10）。
22. anthropic-messages 实例：非空签名的思考块同模型原样回传，空签名的记 `drop / missing-signature`；两个指向同一厂商的实例互相丢掉对方的思考块（`foreign-provider`）；自定义行做回合中途压缩，Opus 5.5、Fable 5.1 内置行（含冻结的旧行）不做（Q2）。
23. 实例的请求最多 128 个工具，智谱仍是 128，Anthropic、Ollama 不按个数裁；超出照 02 记 `over-limit`（T13）。
24. 实例返回智谱数字码时按共用词表归类，百炼按文档写的 429 `insufficient_quota` 夹具在运行时读作 `invalid-request`，Kimi 按文档写的余额 429 `exceeded_current_quota_error` 夹具在运行时读作 `rate-limit`、重发到 3 次，这三个现状有测试钉住（T11 已知局限）；百炼与 Kimi 的夹具在探测里记 `rate-limit`。DeepSeek 实录的错 key 401（`code: invalid_request_error`）两条线运行时与探测都读作 `auth`，/models 回 `auth`；没有已知码的 403 两条线仍读作 `auth`（点名 (h)）。
25. 删掉会话正在用的实例或从列表删掉那个模型后：新消息不发出、不写事实，续跑以 provider 错误结束，都不换模型；失败卡与菜单显示 §实例被删或改坏 的文案（T12）。删掉作为新会话默认的实例或模型后，新会话照常可发。

### 内置厂商（点名）

26. `zhipu`、`anthropic` 的 `baseURL` 改到官方源以外（含 `http://` 与非默认端口）回 `official-host-only`，`zhipu` 的路径含 `/api/coding/paas/v4` 回 `subscription-endpoint`，都什么不写；已存的非官方地址升级后读作未配置、带 `refused`（`official-host-only` 与该源）、设置卡一句提示、发送 0 次请求，已存的 zhipu 订阅路径同样读作未配置、`refused` 码为 `subscription-endpoint`、设置卡用它的文案；开发构建里 `ANTHROPIC_BASE_URL` 指向别处同样读作未配置；不再有「anthropic 指向 /api/anthropic 用智谱搜索」的路径（Q8、Q13）。
27. live 套件没有经 `ANTHROPIC_BASE_URL` 指向智谱的组；评测的 Anthropic 线列走实例；往实例填像官方 key 的值而主机不是 `api.anthropic.com` 时，测试助手拒绝填入（M4）。`TENON_TEST_ORIGIN_MAP` 在 `NEVER_INHERITED` 里；它的目标不是回环或源不是 https 时主进程拒绝启动；live 套件见到它拒跑。

### live

28. 〔智谱 live〕openai-chat 实例（`https://open.bigmodel.cn/api/paas/v4`，`glm-5.3-flashx`）从设置卡建、探测通过、识别出 `reasoning_content`，任务形态一次工具往返完成；anthropic-messages 实例（`https://open.bigmodel.cn/api/anthropic`，`glm-4.7-flash`）探测通过，一次往返完成（Q11）。
29. 〔DeepSeek live〕openai-chat 实例（`https://api.deepseek.com`，`deepseek-flash`）：「获取模型列表」预填上下文与输出上限；探测通过、思考字段为 `reasoning_content`、`usageSeen` 为 true；带工具跨两轮的会话每次回传 `reasoning_content`，不出 400（Q11）。
30. 其余预设厂商只有按文档写的夹具，都标「按文档、未实测」（Q11）。

### 收尾

31. 文档：AGENTS.md 与 spec-driven-dev.md 的开工规则能选中 features spec，spec-driven-dev.md:5、:64 不再写「Claude Desktop 项目」；01、02 顶部各多一行 `Amended by`、正文不变；ADR-003 多一行勘误（Q1、T1）。
32. 干净 clone 上 install、build、lint、typecheck、test、evals:gate、test:e2e 全部通过；§不变量 每条有名字带「M6 不变量 N」的测试；仓库、Tape、日志、plan 里没有任何 key 的值。

## 开放问题

1. ~~**方舟 Anthropic 端点的路径没核实**~~：owner 2026-10-03 定第一版不带（Q18），方舟预设只给 openai-chat；要走 Anthropic 线的用户用「其他兼容端点」自填，由探测判断通不通。
2. ~~**anthropic-messages 线的 live 验收用 glm-4.7-flash 能不能过探测**~~：2026-10-03 第 11 步实测通过（探测两步、一次工具往返，没碰上 1302），不用改模型，关闭。

## 被否决的方案

只记对形状有影响的。每条「理由；改判」。

- **Q1-B 放 `docs/architecture/03-custom-vendors/`**：与 02、ADR-003 写的去向不一致，03 又和主参考 §13 的「阶段 3 = MCP host」错开；改判：无。
- **Q2-B 只开 openai-chat**：MiniMax 官方推荐 Anthropic 线，Q8 之后开发用的智谱 `/api/anthropic` 也要靠这条线的实例；改判：无。
- **Q3-A 完整预设（按模型的方言数据）**：维护面最大、过期最快（模型按月退役、同名换回传机制）；改判：某家进保证档时随阶段 7 另写定义文件（ADR-003）。
- **Q3-C 打包 models.dev 快照**：缺回传策略、finish_reason 词表、用量路径与上限字段名，自填主机在目录里查不到；改判：无。
- **Q5-B 只做第 ① 步**：测不到「缺回传就 400」这个头号故障；改判：无。
- **Q7-A 回环、私网探测后开工具**：Ollama 超窗静默截断，并让指向同一台 Ollama 的实例绕开 02 的 A14；改判：随「Ollama 进 agent 验收」那份 spec 一起定。
- **Q8-B 保留内置改主机、改标 `probed`**：同样改 02 行为，五处开发与测试设置都得先探测或写豁免；改判：无。
- **Q9-B 白名单开关**：开关进实例数据与 promptHash，等于第一版就有按模型的参数面；改判：第一版用下来，「探测不过只因缺一个开关」的模型多到值得做时另立题。
- **Q10-B 借用智谱搜索**：改 02 spec:2739-2740「后端只用本会话 provider 的 key」的规则，搜索词发往另一家；改判：无。
- **Q13-C 只警告**：订阅 key 照样进 Tenon；改判：无。
- **Q14-A 不透明字段原样往返**：要动 openai-chat 的解码、编码与编码器版本；改判：方舟新模型或 Gemini 3 要进「能接上」时另做，届时 amend 本 spec。
- **Q14-C 不做也不检测**：方舟新模型会「通过」却悄悄降质，标签说谎；改判：无。
- **T1 的另一条路：保留 `custom:<uuid>`，改 provenance 的键构造器**：构造器要对现有 id 保持输出不变，又要为一个字符另开转义规则；改判：无。
- **注册表：给 01 的 `ProviderRegistry` 只增 `unregister` / `replace`**：要 amend 01 的接口，kernel 里没有调用方；desktop 的视图够用；改判：服务端 host（6b）也要运行时增删实例时再评估。

## 推出的读法（owner 2026-10-02 过目接受）

裁决之外、由裁决或现有契约推出的读法，每条一句：

1. 实例的整个 `baseURL` 不可改，不只是主机（T2 的路由里没有改地址）。
2. 注册表用 desktop 的组合视图实现，不 amend 01 的 `ProviderRegistry`。
3. 实例不读 `providerConfig`：`readConfig` 剔除实例的条目，地址、key 绑定、`endpointOrigin` 与数据去向确认都只按描述的 `baseURL` 算。
4. 预设数据放 desktop 主进程，经 `customVendor.list` 交给渲染端；新建时预设地址由主进程按 `presetId`、`regionId` 取。
5. 除 MiniMax 外，预设默认线取 openai-chat。
6. 预设里选定地区和线之后地址只读，要别的地址走「其他兼容端点」。
7. 回环、私网实例可以不填 key，工厂给 SDK 占位串 `tenon-local`；不填 key 时 `configured` 仍为 true。
8. anthropic-messages 实例只用 `x-api-key`，不声明 `authToken`。
9. 新建时先写 key 再写 config，写 config 失败就删回 key；回删也失败只记日志。
10. 保存实例 key 时先清快照再写 key（与 02 同主机保存「先写机密」的顺序相反）。
11. 删除实例先删 key 再删条目；「先失效」读作删掉 key 即失效；删除与保存 key 先中止该实例的探测，正在跑的 Run 不中止。
12. 改了实例条目的写入计入该实例的 `providerSettingsGeneration`；保存 key 在写完钥匙串后另计一次。
13. `customVendors` 逐条校验，坏条目只丢它自己，实例 id 重复留第一条，条目内模型 id 重复留第一行；地址过不了 §地址校验 的条目保留、读作未配置（视图照造定义但 `create()` 拒绝），拒绝码经 `refused` 给设置卡。
14. /models 只读 `data[].id` 与六个上限键，见 §列表与上限。
15. 菜单里不给自定义实例手填模型 ID；表外 id 对实例回 `unknown-model`。
16. openai-chat 没通过的行回传格式为 `drop`（无 tools 时规则 4 本就不回传）；anthropic-messages 行一律 `signed-blocks`。
17. 自定义行 `reasoning`、`supportsCacheControl`、`supportsVision` 一律 false，没有 `pricing`（界面不算费用；评测同模型列由 runner 算费用时用该列的评测专用价，Q17）。
18. 探测在主进程跑，经实例自己的 Provider；用 `tee()` 分流读原始响应，认思考字段、查不认识的字段。
19. 探测的工具表是任务形态在该实例下会冻结的那张；让模型调 `Read`，结果合成为 `ok`。
20. 探测输出上限取运行时会给的值，不另设；改了某行的输出上限即清该行快照。
21. ① 的行把 `supportsToolCalling` 置真；② 的行就是通过后会存的那一行。
22. `max_tokens` 换字段重试的判定：openai-chat、①、400 且错误点名了替代字段（`unsupported_parameter` 且详情含 `max_tokens`，或详情同时含两个字段名），只重试一次。
23. 同一实例同一时刻只跑一个探测；探测期间实例条目或 key 被改过、或探测被中止，就不存结果；中止回 `aborted`（删除中止的回 `not-found`），不造快照。
24. 报错的探测一律记失败（含限流与服务错误），文案提示可以再试；402 记 `quota`；429 且错误码为 `invalid-request`（百炼限流）记 `rate-limit`；同一次响应既有错误又有不认识的字段，按 `opaque-fields` 记。
25. Q14 的已知键集合是解码器读的键去掉 tool_call 上的 `custom`、加 `role` 与 delta / message 上的 `name`（MiniMax 每帧带 `name: "MiniMax AI"`，是参与者名，不需回传）；值为 null 或空的键算没出现；块级与 choice 级的键不查；最多记 16 个键名。
26. 没通过的实例行沿用 `unverified-text-only`，文案换成「尚未通过探测」，渲染端按条目有没有 `displayName` 选文案。
27. 实例行的 `capabilitySource`：通过为 `probed`，其余为 `user`；由 `assemble` 与 `session.modelChoice` 路由按当前行算，`resolveChoice`、`choiceOf` 不改。
28. 回环、私网实例走 `provider-text-only`，公网实例没通过的行走新值 `not-probed`。
29. `checksThinkingPrefix` 缺省时照 02 只按 id 回落（Opus 5.5、Fable 5.1 为 true，不看 `providerId`），M6 之前冻结的行判法不变；自定义行恒写 false。
30. 工具数上限经 `RunConnector.toolsPerRequest?` 交给 kernel，常量表 `TOOLS_PER_REQUEST` 撤掉（点名 (g)）。
31. 实例被删或模型被删时，对实例不做保守合成，按配置错误拒绝且 `assemble` 不 reject；失败卡按「会话的 provider 不在 `provider.list` 里」选单列文案。
32. 保存 key 清掉快照后，暂停中的 Run 续跑按冻结的 `capabilitySource` 照发工具。
33. Q13 的订阅路径规则同样管内置 `zhipu` 的手填地址与已存地址（点名 (b)、(e)）。
34. `DEV_ENV_FALLBACK` 照旧读 `ANTHROPIC_BASE_URL`，非官方源读作未配置。
35. 评测的实例列在跑之前先用同一个 `probeModel` 探测，不通过就不跑。
36. 内置厂商只认官方 https 源（协议、主机、默认端口），不只认主机；被拒的码与源经 `provider.list` 的新键 `refused` 告诉设置卡（zhipu 的订阅路径、过不了地址校验的实例同用这个键）。
37. openai-chat 实例行 `usageNeedsOptIn` 为 true（请求用量），anthropic-messages 行为 false。
38. ② 以 `end-turn` 或 `tool-use` 结束算通过，其他结束原因（无错误）算没测出来、可重试。
39. 实例出网（请求、探测、/models）不跟随重定向；内置定义照 02 跟随。
40. 地址按 `new URL` 规范化后存；规则 3 看原串，规则 4 先逐段 percent-decode 再匹配。
41. 删除实例或模型时，一并清掉指向它的新会话默认。
42. e2e 与单测经只在未打包且 `TENON_DEV_ENV=off` 时生效的 `TENON_TEST_ORIGIN_MAP`，把官方源与公网形主机改投到本机回环的假服务器；它不被继承，live 套件见到它拒跑。
43. 百炼预设只带北京、新加坡两地区，用 DashScope 共享域名（不带 WorkspaceId）；美国（弗吉尼亚）、中国香港走「其他兼容端点」。
44. `assemble` 对实例按与 key 同一次读出的 config 重造行，不用进入时视图给的定义。
45. 探测不设总时长上限；用户取消走只增的 `customVendor.cancelProbe`，中止与保存 key 的中止同样回 `aborted`、不存。
