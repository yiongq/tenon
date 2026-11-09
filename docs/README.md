由 spec-check --index 生成，勿手改

# 入口页

## 规格一览

- [00](architecture/00-foundation/spec.md) · implemented · 00 · 地基（Foundation） · 需要你：—
- [01](architecture/01-provider-and-tape/spec.md) · implemented · 01 · Provider 抽象 + 会话存储（Tape） · 需要你：—
- [02](architecture/02-agent-loop/spec.md) · implemented · 02 · Agent loop · 需要你：—
- [03](architecture/03-mcp-host/spec.md) · implemented · 03 · MCP host 完整版 · 需要你：—
- [04](architecture/04-sandbox/spec.md) · implemented · 04 · 沙箱与出网（阶段 4a） · 需要你：—
- [05](architecture/05-file-bridge/spec.md) · implemented · agent 改你的文件之前自动留底，一轮任务做完能一键还原；同时补上改文件时的几道保护。 · 需要你：无（2026-11-06 owner「4d 挪阶段 6」，06 单独算预算；下一份是 06 起草）。
- [06](architecture/06-approval-modes/spec.md) · draft · 加一个自动档：工作区里能还原的改动、关在沙箱里的命令不再问你；撤不回的、越出文件夹的、按规则拦下的照样问。 · 需要你：无。挑刺评审 r2 做完、草稿放进仓库后，请你读「给你看的一页」，回一句带编号的话，比如「06 改 ready」。
- [auto-tier-hardening](features/auto-tier-hardening/spec.md) · implemented · 在开「自动档」（06）之前，给 Tenon 自己的沙箱和权限检查补三道保护，堵住三个会让别人借你的身份执行代码、或把你的数据外带出去的缺口。 · 需要你：本轮无；lead 完成突变实跑核验后交 owner 验收，Status 只由 owner 决定。
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
- 01 §desktop 接线 ← 06
- 01 §Provider 层 ← claude-5-5-models ← custom-vendors ← model-display-names
- 01 §desktop 接线 的 `provider.configure` ← presentation-r1
- 02 §主进程与 kernel 的循环接口 ← 03 ← 06
- 02 §工具调用的收口 ← 04
- 02 §可逆性 ← 05 ← 06
- 02 §内置工具的默认档位 ← 05
- 02 §「在不在工作区里」 ← 05
- 02 §内置工具与参数 ← 05 ← 06
- 02 §决策表与各层输入 ← 05 ← 06
- 02 §载荷 ← 05 ← 06
- 02 §作用域与授权键 ← 05
- 02 §工作区 ← 05
- 02 §点停止时各状态怎么收 ← 05
- 02 §会话形态 ← 06 ← presentation-r1
- 02 §会话事实 ← 06
- 02 §名字总表 ← 06
- 02 §合并：两步 ← 06
- 02 §Inspector 接口与合议 ← 06
- 02 §挂点与会话视图 ← auto-tier-hardening ← 06
- 02 §外带检查 ← auto-tier-hardening ← 06
- 02 §railguard 映射 ← 06
- 02 §判决记录与摘要 ← 06
- 02 §主循环与 Run 的结束 ← 06
- 02 §权限 ← 06
- 02 §授权 ← auto-tier-hardening
- 02 §对 01-provider-and-tape 的修补 ← claude-5-5-models ← custom-vendors ← model-display-names
- 02 §工具调用的收口 的工具结果视图 ← presentation-r1
- 03 §地址与出网 ← 04
- 03 §连接器卡 ← auto-tier-hardening
- 04 §档位计划写进判决 ← 06
- 04 §告诉模型 ← 06
- 04 §档位到 srt 配置 ← auto-tier-hardening
- 04 §已知限制 ← auto-tier-hardening
- 05 §给 06 的接口 ← 06
- 05 §硬链接 ← auto-tier-hardening
- 05 §已知限制与代价 ← auto-tier-hardening
- custom-vendors §写入规则 的「新建」与「保存实例的 key」：第一次存 key ← presentation-r1
- model-display-names §对 02 的修补「设置卡」 ← claude-5-5-models
- presentation-r1 §审批卡 ← 05 ← 06 ← 06
- presentation-r1 §结算行 ← 05
- presentation-r1 §工具行 ← 05 ← 05 ← 06
- presentation-r1 §拦截回执 ← 06
