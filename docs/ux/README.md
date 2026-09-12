# UX 规格

Tenon 的交互行为对齐 Claude Desktop（信息架构、状态机、快捷键、空 / 加载 / 错误态、动效降级），视觉是自己的。策略与边界见 [master-reference §8](../architecture/master-reference.md)。

## 规格从哪来

交互规格来自一份**私有的 UX 拆解包**（实拍的交互状态机、DOM 快照、令牌表）。它含有第三方的样式表、品牌令牌值和字体名，**不进仓库**。本地约定路径：

```
../tenon-uxkit/          # 与 tenon 平级，不在 git 里
  interactions.md        # 交互规格：状态机、点击行为、键盘、动效、空/加载/错误态（主规格）
  fixtures/index.html    # 状态快照浏览器，只用来看
  tokens.css             # 只抄键名与分层，不抄值
  css/                   # 不引用
```

代码 agent 需要时可以读 `../tenon-uxkit/interactions.md`，但不得把其中任何文件、class 串、令牌值或字体名复制进本仓库。

## 仓库里放什么

按阶段派生出来的、用 Tenon 自己的术语写的规格：

- `tokens.md` — 令牌的键名与分层（surface / text / border / fill / alpha / radius / h-control / weight / ease / dur / z，亮暗两套，壳层背景独立一层）以及 Tenon 自己的值。阶段 0。
- `components.md` — 每个界面到 shadcn/ui 组件的映射表。阶段 0。
- `shell.md` / `composer.md` / `message-stream.md` / `pages.md` — 各界面的状态机与验收点，在对应阶段从私有规格派生，去掉一切第三方标识。

派生规则：**行为可以一致，标识必须自己的。** 写"侧栏折叠后左上角有悬停触发区，悬停浮出临时侧栏，移开即收"是规格；写它的 class 名或颜色值不是。
