由 spec-check --index 生成，勿手改

# 入口页

## 规格一览

- [00](architecture/00-foundation/spec.md) · implemented · 00 · 地基（Foundation） · 需要你：—
- [01](architecture/01-provider-and-tape/spec.md) · implemented · 01 · Provider 抽象 + 会话存储（Tape） · 需要你：—
- [02](architecture/02-agent-loop/spec.md) · implemented · 02 · Agent loop · 需要你：—
- [03](architecture/03-mcp-host/spec.md) · implemented · 03 · MCP host 完整版 · 需要你：—
- [04](architecture/04-sandbox/spec.md) · implemented · 04 · 沙箱与出网（阶段 4a） · 需要你：—
- [05](architecture/05-file-bridge/spec.md) · ready · agent 改你的文件之前自动留底，一轮任务做完能一键还原；同时补上改文件时的几道保护。 · 需要你：无
- [claude-5-5-models](features/claude-5-5-models/spec.md) · ready · Claude 5.5 两行与模型目录跟随最新 · 需要你：无
- [custom-vendors](features/custom-vendors/spec.md) · implemented · 自定义厂商（M6） · 需要你：—
- [model-display-names](features/model-display-names/spec.md) · implemented · 模型显示名 · 需要你：—
- [presentation-r1](features/presentation-r1/spec.md) · implemented · 呈现修订第一轮（presentation-r1） · 需要你：—

## 被改过的节

- 00 §HostAdapter ← 04 ← 05 ← 01 ← 02
- 00 §本地持久化布局 ← 05
- 01 §所有权与依赖方向 ← 02
- 01（整份） ← 04
- 01 §保留命名空间 ← 05
- 01 §Provider 层 ← claude-5-5-models ← custom-vendors ← model-display-names
- 01 §desktop 接线 的 `provider.configure` ← presentation-r1
- 02 §主进程与 kernel 的循环接口 ← 03
- 02 §工具调用的收口 ← 04
- 02 §可逆性 ← 05
- 02 §内置工具的默认档位 ← 05
- 02 §「在不在工作区里」 ← 05
- 02 §内置工具与参数 ← 05
- 02 §决策表与各层输入 ← 05
- 02 §载荷 ← 05
- 02 §作用域与授权键 ← 05
- 02 §工作区 ← 05
- 02 §点停止时各状态怎么收 ← 05
- 02 §对 01-provider-and-tape 的修补 ← claude-5-5-models ← custom-vendors ← model-display-names
- 02 §会话形态 ← presentation-r1
- 02 §工具调用的收口 的工具结果视图 ← presentation-r1
- 03 §地址与出网 ← 04
- custom-vendors §写入规则 的「新建」与「保存实例的 key」：第一次存 key ← presentation-r1
- model-display-names §对 02 的修补「设置卡」 ← claude-5-5-models
- presentation-r1 §审批卡 ← 05
- presentation-r1 §结算行 ← 05
- presentation-r1 §工具行 ← 05 ← 05
