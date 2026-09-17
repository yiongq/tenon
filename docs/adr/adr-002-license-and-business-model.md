# ADR-002：许可证、CLA 与商业模式边界

- **状态**：采纳
- **日期**：2026-09-17（同日两次修订：apps/server 措辞；删去市场判断一节，改为节奏一句）
- **背景**：仓库于 2026-09-17 转公开。此时没有一行产品代码、没有外部贡献者，是改许可证成本为零的唯一时刻。owner 要求把「以后要盈利怎么弄」里现在必须定的部分定下来，其余留到阶段 7。

---

## 决策

1. **本仓库全部内容维持 Apache-2.0**（`LICENSE` 自首个 commit 起存在）。`packages/kernel`、`packages/contracts`、`apps/desktop`、`examples/`、`docs/` 永远开源，不改为 AGPL 或 source-available。
2. **付费能力与开源核心物理分开。** 付费部分（管理员策略控制台、SSO、审计导出、计费、组织管理界面）不放在 Apache-2.0 的目录树里，放独立目录 `ee/`（自带 `LICENSE`，源码可见、使用需授权，照 OpenWork `/ee`、n8n `/packages/@n8n/*-ee` 的做法）或独立仓库；具体在阶段 6b 开工时定。`apps/server` 属于开源部分，是服务端 host 本身，**含多租户隔离机制**（`tenantId` 贯穿与跨租户隔离测试是 AGENTS.md 硬规则与 6b 硬门禁，不能放进付费层）；付费层只做管理与合规能力，不持有隔离机制。（同日修订：初稿写「单租户 / 自托管核心」，与 master-reference §13 阶段 6b、AGENTS.md 的「多租户云端 host」矛盾，以本句为准。）
3. **外部贡献必须签 CLA**（个人 + 企业两版，文本取自 Apache ICLA / CCLA 改写，走 cla-assistant）。CLA 上线前不合并任何外部 PR。版权持有人为 Yiong（yiongq），日后可整体转给公司。
4. **商标不随许可证授出**（Apache-2.0 §6 已排除）。「Tenon」名称与 Logo 由 owner 保留；修改版不得以 Tenon 名义发布。注册与否在阶段 7 定。
5. **商业模式方向：开源核心（open core）。** 桌面端与内核永久免费；收费面是团队 / 企业服务端：私有部署、管理员策略、审计、SSO、境内模型接入与合规。**不做**桌面端订阅、广告、模型 token 转售（后者若做只作便利功能，不作收入）。定价、计费、SSO、审计日志按主参考 §13 阶段 7 处理。

---

## 为什么是 Apache-2.0 而不是 AGPL 双许可

| 方案 | 谁在用 | 对 Tenon 的利弊 |
|---|---|---|
| Apache-2.0 + 独立付费层 | OpenWork（MIT + `/ee`）、Dify（Apache + 附加条款 + 企业版）、n8n（fair-code + 企业）、LobeChat（开源 + 云） | 采用门槛最低，企业法务不抵触；桌面端本就难被 SaaS 化，AGPL 防的那件事对我们威胁小；付费层靠目录与许可证隔离即可 |
| AGPL-3.0 + 商业授权 | Cherry Studio | 能卖「闭源使用授权」，但要 CLA 才能出售、企业用户避 AGPL、社区贡献意愿下降；我们自己也从 Apache 项目（DeepChat / Goose / sandbox-runtime）抄代码，AGPL 出站合法但与主参考「不碰 AGPL」的姿态相悖 |
| MIT | LibreChat、OpenCode | 比 Apache 少专利授权条款与商标条款，对一个要卖企业版的项目保护更弱 |

Apache-2.0 的专利授权（§3）与商标排除（§6）正是企业产品需要的两条，AGPL 多出来的那层保护对桌面 + 私有部署形态用处不大。

## 为什么现在就要 CLA

不签 CLA，每个外部贡献者都保留自己那部分的版权；以后无论是给 `ee/` 换许可证、整体转给公司、还是应对专利主张，都要逐个找人签字。DCO 不解决这个问题（它只声明「我有权提交」，不转让也不宽授权）。CLA 唯一的代价是吓退一部分贡献者，对一个单人起步、以学习和最佳实现为目标的项目，这个代价可以接受。

## 商业化节奏

商业化动作不早于阶段 5 完成；阶段 5 之前只攒用户、可信度与评测证据。市场判断、目标客户、定价另记在仓库外的私有笔记，不进公开文档。

---

## 被否决的方案

- **先不定，等有人用了再说**：等到有代码和贡献者时，换许可证和补 CLA 的成本从零变成「逐个找人签字」。
- **整仓 source-available（BSL / SUL）**：失去「开源 Claude Desktop 替身」这个传播点，和主参考 §7「端到端吃透、业界最佳实现」的定位冲突。
- **模型 token 转售当主收入**：毛利薄、合规负担重、和模型厂商正面竞争，参考 OpenCode Zen 只是引流。

## 后续动作

- `CONTRIBUTING.md` 加 CLA 一条（本 ADR 同一 PR）。
- cla-assistant 与 CLA 文本：第一个外部 PR 出现前完成，记在阶段 0 plan 的交接区。
- 阶段 6b spec 里定 `ee/` 的目录、许可证文本与授权校验方式。
- 阶段 7 定定价、商标注册、发票与合规。

## 参考

- [OpenWork](https://github.com/different-ai/openwork)：MIT + `/ee`，团队版前 5 席免费、之后按席位收费（主参考 §5.2）
- Cherry Studio：AGPL-3.0 + 商业授权，另有企业版（主参考 §14）
- [Apache License 2.0 §3 专利授权、§6 商标](https://www.apache.org/licenses/LICENSE-2.0)
- [Apache ICLA / CCLA](https://www.apache.org/licenses/contributor-agreements.html)
- 主参考 §6.1 非技术原因、§7 路线 A、§13 阶段 6b / 7
