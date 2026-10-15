# 设计令牌值替换表（阶段 0 临时皮肤）

这是 [master-reference §8.5](../architecture/master-reference.md) 要求的两样缺失规格之一（另一样是 `components.md`），对应 [plan](../architecture/00-foundation/plan.md) 步骤 10.7。**它是一张待誊抄的表**，不是 CSS 文件——步骤 10 的实现者照这张表写 `apps/desktop/src/styles/tokens.css`。

- **分层**按 §8.5 定的语义层：surface / text / border / fill / alpha / radius / h-control / weight / ease / dur / z，亮暗两套，壳层背景独立一层。`space` / `type` / `role` 三层是本文在 §8.5 之外自己加的（间距单位、字号行高、别名层），§8.5 没列，也没禁。
- **键名**用 `--t-` 前缀、kebab-case；层名与层内的一部分档位名沿用 §8.5 允许保留的那套语义分层——§8.5 的原话是「键名可进，**值不进**」，键名稳定正是换装只改一处的前提。
- **值**全部是 Tenon 自己的。颜色：种子是下面三个临时皮肤色（2026-10-15 起；此前取 §8.1 借来的赤陶奶油，那三个值不再生效，§8.1 的表是历史记录），其余每一个颜色值都由下面四条派生规则算出来，算式写在表里。字族与两档字号：§8.1 与 [spec 的「国际化」一节](../architecture/00-foundation/spec.md)的原值。几何与节奏（radius、h-control、dur、z、weight、alpha 不透明度、字号倍率）：§8.1 只给了 4px 单位和两档圆角，其余是本文按写明的算式自己推的，各表里注明。
- **暗色是暂定反相**，§8.3 定稿时整套重算，见末尾「怎么换装」。2026-10-15 换种子时暗色里有几档按对比度挪了步长，记在那一节。

## 种子与派生规则

三个颜色种子（2026-10-15 起；此前是 §8.1 的 `#f0ece0` / `#1f1e1d` / `#c96442`）：

| 种子 | 值 | 角色 |
|---|---|---|
| `bg` | `#f4f5f3` | 中性梯级的 0 端 |
| `text` | `#15191a` | 中性梯级的 100 端 |
| `accent` | `#1e5e4a` | 强调色种子 |

四条派生规则，所有颜色值都从这里算：

1. **中性梯级 `N(p)`** ＝ 在 sRGB 空间把 `bg` 向 `text` 线性插值 p%。取档：`0 / 4 / 8 / 12 / 16 / 20`（面与壳用，密）＋ `36 / 52 / 68 / 84 / 100`（字与线用，疏）。
2. **提亮 `L(p)`** ＝ 把 `bg` 向 `#ffffff` 插值 p%（亮色下高于底面的面）；**压暗 `B(p)`** ＝ 把 `text` 向 `#000000` 插值 p%（暗色下低于底面的面）。取档 20 / 40 / 70。
3. **暗色梯级 `D(p) = N(100 − p)`**——同一条梯级反向读。这就是「暂定反相」的全部含义。
4. **强调与语义色**：`A→text(p)` / `A→bg(p)` 把 `accent` 向两端插值；语义色取与 `accent` 相同的 HSL 饱和度（现在的 accent 是 51.6%，取整 52%；换种子要重算），只换色相（danger 358° / success 148° / warning 40°）与明度，明度按「在自己那一套的底面上 ≥ 4.5:1」反推。

插值一律在 sRGB 的 0–255 整数通道上算，结果**四舍五入取整，`.5` 进位**（上一组种子里 `L(70)` 的红通道 240 + 15 × 0.7 = 250.5 → 251，所以是 `#fbf9f6` 不是 `#faf9f6`；现在这组种子没有哪个通道恰好落在 .5 上，但换种子时会再碰到）。这条不写明，誊抄的人算不出同一个值。

计算好的梯级（誊抄时直接查这两行）：

```
N   00 #f4f5f3  04 #ebecea  08 #e2e3e2  12 #d9dbd9  16 #d0d2d0  20 #c7c9c8
    36 #a4a6a5  52 #808382  68 #5c5f5f  84 #393c3d  100 #15191a
L   20 #f6f7f5  40 #f8f9f8  70 #fcfcfb        B  20 #111415  40 #0d0f10
```

多个语义键指向同一梯级是正常的——梯级是调色板，语义键是接口。**组件只认语义键，永远不引用梯级，也不引用别的语义键**（`--t-role-*` 那一层例外，它显式做别名）。

## 与主题无关的层

写在 `:root`，亮暗两套都不覆盖。

### radius（5 档，由 §8.1 的 6 / 12 推）

| 键 | 值 | 算式 | 用在哪 |
|---|---|---|---|
| `--t-radius-xs` | `3px` | sm ÷ 2 | 行内代码、小角标 |
| `--t-radius-sm` | `6px` | §8.1 原值 | Button / IconButton / Chip / Switch 轨 |
| `--t-radius-md` | `12px` | §8.1 原值 | 卡片、Popover、Menu、消息气泡 |
| `--t-radius-lg` | `18px` | sm × 3 | Composer 外框、Modal |
| `--t-radius-pill` | `9999px` | — | 胶囊 Chip、头像 |

> `parity-audit` 记的「行内代码 4px 圆角」是对照对象的值；Tenon 用同一档位的自己的值 `3px`，视觉等价。
>
> Composer 不另立圆角键——它和 Modal 共用 `--t-radius-lg`，少一个只服务一个组件的键。

### h-control（5 档）

§8.1 没给控件高度，梯级是本文推的：**控件高 ＝ 该档文字的行高 ＋ 2 × 垂直内边距**，内边距只取 `--t-space-unit` 的倍数（0 / 4 / 8），于是每档自然落在 4px 的倍数上。行高取下面 `type` 表里的值。小的三档按**用途**命名而不按 `xs/sm`——它们各自只服务一种位置，尺寸名反而说不清。

| 键 | 值 | 算式 | 用在哪 |
|---|---|---|---|
| `--t-h-control-inline` | `20px` | leading-ui ＋ 0 | 嵌在文本行里的小钮，与界面行高齐平不撑行（消息动作条，阶段 2） |
| `--t-h-control-nested` | `24px` | leading-micro ＋ 2×4 | 控件内部再嵌的控件 |
| `--t-h-control-compact` | `28px` | leading-ui-sm ＋ 2×4 | 侧栏行、Menu item、Chip |
| `--t-h-control` | `36px` | leading-ui ＋ 2×8 | 默认 Button / IconButton |
| `--t-h-control-lg` | `44px` | leading-body ＋ 2×8 | Composer 发送键、主按钮 |

### space

| 键 | 值 |
|---|---|
| `--t-space-unit` | `4px`（§8.1 原值） |

所有间距是它的整数倍，不另立 `--t-space-1..n`——Tailwind 的 `--spacing` 接这一个值就能生成整条 `p-*` / `gap-*` 梯级（见下文）。

### type

字族按 spec「国际化」一节：界面无衬线 / 正文衬线的区分必须保留（§8.1 唯一的不可动条款），但**衬线令牌的 CJK 回落是系统无衬线**，不用中文衬线体。

| 键 | 值 |
|---|---|
| `--t-font-sans` | `"Inter", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif` |
| `--t-font-serif` | `"Source Serif 4", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", serif` |
| `--t-font-mono` | `"Source Code Pro", ui-monospace, monospace` |

> `Inter` / `Source Serif 4` 来自 §8.1（2026-09-12 建仓时就写在那里，`7cb3f00`）；CJK 回落三款来自 spec「国际化」。等宽栈两处都没给，2026-10-15 补上 `Source Code Pro`（与 Source Serif 4 同属 Adobe 的 Source 家族），后面的 `ui-monospace` / `monospace` 是通用关键字兜底。挑字体的标准只有一条：§8.1 与 spec 已经指定的照用；两处都没给、要新挑的，只挑在 uxkit 里零命中的名字（见末尾自查）。
>
> **zh 下的字族栈首项换成别名**（2026-10-15）：`Tenon Sans Latin` / `Tenon Serif Latin` 是同一批 Inter、Source Serif 4 文件的别名，`unicode-range` 去掉了 U+2000-206F（通用标点）。中文句子里的 “” ‘’ —— …… 是中文字符，照 spec「国际化」落到 CJK 回落字体，不由拉丁字体画成窄字形；en 下字族栈不变。声明在 `src/styles/fonts.css` 文末，换栈写在 `theme.css` 的 `html[lang^='zh']` 里（与 zh 降字重同一处），`tokens.css` 仍逐表誊抄本表。
>
> **三款字体现在都随包分发**（2026-10-15，此前只在这里写了名字，没有任何文件，所有拉丁字符其实落到了 PingFang）：`@fontsource-variable/inter`、`@fontsource-variable/source-serif-4`（正体 + 斜体）、`@fontsource-variable/source-code-pro`，SIL OFL 1.1，版权记在仓库根的 `NOTICE`（版权行取自字体文件 name 表 ID 0；两个 Source 包自带的 `LICENSE` 与 `metadata.json` 把版权方写成 Google Inc.，与字体文件不符，不照搬）。只带拉丁子集、可变字重；声明在 `src/styles/fonts.css`，family 名就是上表里的名字，所以本机装没装这几款都渲染同一套字形。中文字符落到 CJK 回落三款，这也是 `font-style: italic` 在 `:lang(zh)` 下关掉的原因（CJK 字体没有斜体字面，浏览器会硬拧伪斜体，强调改用字重）。
>
> 打包发布时需要随应用附上每款字体的 OFL 1.1 全文（OFL 要求字体的每份拷贝都附许可证；woff2 里只有许可证 URL，name 表 ID 14，没有 ID 13 的正文），版权行用 `NOTICE` 列出的、取自字体文件的那一行，不照搬 fontsource 包的 `LICENSE`；现在没有打包流程，所以这件事记在 `NOTICE`，不在代码里。

字号与行高。`ui`（14 / 20）与 `body`（16 / 28）是 spec 的原值——`zh-CN` 下「谁在说话」靠这两档的排版差异承担；其余按 `body` 的倍率推——倍率是本文挑的，spec 只给了 14 / 20 与 16 / 28 两档；行高一律取 ≥ 字号 1.3 倍的最小 4 倍数（`body` 例外，正文有意更松）。

| 键 | 字号 | 行高键 | 行高 | 算式 | 用在哪 |
|---|---|---|---|---|---|
| `--t-size-micro` | `12px` | `--t-leading-micro` | `16px` | body × 0.75 | 相对时间、角标 |
| `--t-size-ui-sm` | `13px` | `--t-leading-ui-sm` | `20px` | body × 0.8125 | 行内代码、次级界面文字 |
| `--t-size-ui` | `14px` | `--t-leading-ui` | `20px` | spec 原值 | 界面基准 |
| `--t-size-body` | `16px` | `--t-leading-body` | `28px` | spec 原值 | 助手正文（衬线） |
| `--t-size-h3` | `18px` | `--t-leading-h3` | `28px` | body × 1.125 | 正文子节标题 |
| `--t-size-h2` | `20px` | `--t-leading-h2` | `28px` | body × 1.25 | 正文节标题 |
| `--t-size-h1` | `24px` | `--t-leading-h1` | `32px` | body × 1.5 | 正文章标题 |

Markdown 标题按级别落档：h1 → `--t-size-h1`、h2 → h2、h3 → h3，**h4 与正文同号**（见下面 weight 表，靠字重区分）。Streamdown 写死的类名是 `text-3xl` / `2xl` / `xl` / `lg`，`theme.css` 把这四档依次接到这四档上。
### weight

四档是 CSS 标准字重，§8.1 没给，挑哪四档由本文定。`regular` ↔ 400、`medium` ↔ 500 是 `font-weight` 规范自带的名值对应，任何一套令牌都只能这么写。

| 键 | 值 | 用在哪 |
|---|---|---|
| `--t-weight-regular` | `400` | 正文、界面文字 |
| `--t-weight-medium` | `500` | 侧栏当前行、按钮文字 |
| `--t-weight-semibold` | `600` | h2 / h3、Modal 标题 |
| `--t-weight-bold` | `700` | h4（与正文同号，靠字重区分） |

### dur / ease

**行为照做，数字自己定。**`interactions.md` §0 / §5 给的是节奏与配对关系——hover / focus 走最短档、浮层与动作条出现走次短档、消失比出现快一档、Modal 与侧滑走最长的过渡档、循环类单列一档、reduced-motion 全降级——这些是行为，AGENTS.md 与 §8.5 都允许复刻。毫秒数与贝塞尔控制点**没有取包里的**：时长以 60Hz 下 5 帧（≈80ms）为一格，取 1 / 2 / 3 / 4 / 6 格；四条曲线按下面写的形状自己拟控制点，不抄现成曲线目录（Material、easings.net 那几条都没用）。

| 键 | 值 | 算式 | 用在哪 |
|---|---|---|---|
| `--t-dur-fast` | `80ms` | 1 格 | hover / focus 颜色过渡；浮层消失 |
| `--t-dur-snap` | `160ms` | 2 格 | Menu、Tooltip、消息动作条（阶段 2）出现 |
| `--t-dur-base` | `240ms` | 3 格 | 折叠展开、侧栏折叠 |
| `--t-dur-sheet` | `320ms` | 4 格 | Modal、右面板（阶段 5）进出 |
| `--t-dur-slow` | `480ms` | 6 格 | 骨架呼吸、流式流光（循环类，阶段 2） |

| 键 | 值 | 形状 | 用在哪 |
|---|---|---|---|
| `--t-ease-snap` | `cubic-bezier(0.3, 0.84, 0.36, 1)` | 起步即快、尾段收紧 | **默认**：hover / focus、浮层与动作条显隐 |
| `--t-ease-out` | `cubic-bezier(0.14, 0.7, 0.28, 1)` | 全程减速 | 进入、展开 |
| `--t-ease-in-out` | `cubic-bezier(0.62, 0.04, 0.34, 1)` | 两端对称 | 位移、尺寸变化 |
| `--t-ease-overshoot` | `cubic-bezier(0.3, 1.42, 0.62, 1)` | 过冲后回落 | Chip 落位一类需要回弹的 |

配对写死在这里，组件不自己挑：hover / focus ＝ `--t-dur-fast` ＋ `--t-ease-snap`；浮层 / 菜单 / 动作条 进 ＝ `--t-dur-snap` ＋ `--t-ease-snap`、出 ＝ `--t-dur-fast` ＋ `--t-ease-snap`；折叠与侧栏 ＝ `--t-dur-base` ＋ `--t-ease-in-out`；Modal 与右面板 ＝ `--t-dur-sheet` ＋ `--t-ease-out`；循环类 ＝ `--t-dur-slow` ＋ `--t-ease-in-out`。

**减动效**（`interactions.md` 要求必须复刻）：在 `@media (prefers-reduced-motion: reduce)` 与 `[data-reduce-motion]` 下把五个 `--t-dur-*` 全部重写成 `1ms`，不逐个组件写降级分支。依赖 `transitionend` 的组件改用状态驱动，别依赖事件一定触发。

### z

五档与档间的 100 步长是本文定的（§8.1 没给），顺序按「谁能压住谁」排。

| 键 | 值 | 用在哪 |
|---|---|---|
| `--t-z-sticky` | `10` | 顶栏、消息流粘顶分隔 |
| `--t-z-popover` | `100` | Popover / Menu |
| `--t-z-modal` | `200` | Modal 与它的遮罩 |
| `--t-z-tooltip` | `300` | Tooltip（要能压在 Modal 上——Modal 里的 IconButton 也要有气泡提示） |
| `--t-z-toast` | `400` | 全局提示（阶段 0 不做 Toast，键先立） |

引导层（coachmark）是阶段 0 之后的东西，现在不立键；将来插在 `--t-z-sticky` 与 `--t-z-popover` 之间，不用改已有的五档。

## 亮暗两套

亮色写在 `:root`；暗色在 `@media (prefers-color-scheme: dark)` 里以 `:root:not([data-theme="light"])` 写一遍，再在 `[data-theme="dark"]` 里写一遍——默认跟随系统（2026-09-13 简化决定），显式切换两个方向都要压得住。

### shell（壳层背景，独立一层）

侧栏与顶栏不属于 surface 梯级，它们是内容列的底衬。

| 键 | 亮 | 亮算式 | 暗 | 暗算式 | 用在哪 |
|---|---|---|---|---|---|
| `--t-shell-bg` | `#e2e3e2` | N08 | `#0d0f10` | B40 | Sidebar（264px）+ TopBar 底 |
| `--t-shell-row-hover` | `#d0d2d0` | N16 | `#15191a` | D00 | 侧栏行 hover |
| `--t-shell-row-selected` | `#c7c9c8` | N20 | `#272b2b` | D08 | 侧栏当前会话行 |

### surface

| 键 | 亮 | 亮算式 | 暗 | 暗算式 | 用在哪 |
|---|---|---|---|---|---|
| `--t-surface-0` | `#f4f5f3` | 种子 bg | `#15191a` | 种子 text | 内容列底 |
| `--t-surface-1` | `#f8f9f8` | L40 | `#272b2b` | D08 | 抬起一层：卡片、空态卡、表格容器 |
| `--t-surface-2` | `#ebecea` | N04 | `#1e2223` | D04 | 沉一档：用户气泡、行内代码、表头、Chip |
| `--t-surface-3` | `#d9dbd9` | N12 | `#303334` | D12 | 沉两档：代码块底、内容列内选中块 |
| `--t-surface-panel` | `#f6f7f5` | L20 | `#111415` | B20 | 右侧面板底（阶段 0 留空，键先立） |
| `--t-surface-overlay` | `#fcfcfb` | L70 | `#393c3d` | D16 | Popover / Menu / Modal 容器 |
| `--t-surface-inverse` | `#15191a` | N100 | `#f4f5f3` | D100 | Tooltip 底；Toast 底（阶段 0 不做，键先立） |

> 亮色里「沉」是变暗、「抬」是变亮；**暗色里两个方向都往上走**（暗色下更深读作洞，不读作层次），所以 `surface-2` / `-3` 在暗色里高于 `surface-0`。这是有意的，不是反相时抄漏了。

### text

对比度列是在自己那一套的 `--t-surface-0` 上的实测比值。

| 键 | 亮 | 比 | 暗 | 比 | 算式 | 用在哪 |
|---|---|---|---|---|---|---|
| `--t-text-primary` | `#15191a` | 16.2 | `#f4f5f3` | 16.2 | N100 / D100 | 正文、标题 |
| `--t-text-secondary` | `#393c3d` | 10.2 | `#d0d2d0` | 11.6 | N84 / D84 | 次级说明；思考面板正文（阶段 2） |
| `--t-text-muted` | `#5c5f5f` | 5.9 | `#adafae` | 8.0 | N68 / D68 | 相对时间、占位、状态行 |
| `--t-text-disabled` | `#a4a6a5` | 2.2 | `#656868` | 3.1 | N36 / D36 | 禁用态（不承载信息） |
| `--t-text-accent` | `#1c4d3e` | 8.8 | `#92b0a5` | 7.6 | A→text(24) / A→bg(54) | 链接、强调文字 |
| `--t-text-danger` | `#932f32` | 7.1 | `#d37377` | 5.5 | HSL(358, 52%, 38% / 64%) | 错误文案 |
| `--t-text-success` | `#25744a` | 5.2 | `#5ccc90` | 8.9 | HSL(148, 52%, 30% / 58%) | 完成态 |
| `--t-text-warning` | `#745a25` | 5.9 | `#cca65c` | 7.7 | HSL(40, 52%, 30% / 58%) | 提醒、跳过档 |
| `--t-text-on-accent` | `#ffffff` | 8.5 | `#15191a` | 5.2 | — | 实心强调底上的文字 |
| `--t-text-on-danger` | `#ffffff` | 6.3 | `#ffffff` | 6.3 | — | 实心危险底上的文字 |

> `--t-text-on-accent` 亮暗**不同向**：亮色下强调按钮是深底白字，暗色下是亮底深字。这是对比度反推的结果，不是笔误。
>
> 现在的 `accent`（`#1e5e4a`）在亮色底面上有 7.0:1，本身就能承载文字；`--t-text-accent` 仍取它的 24% 加深版（8.8:1），与 `--t-fill-accent-hover` 同一档，链接和主按钮 hover 是同一个颜色。暗色下 accent 比底面还暗（对 `--t-surface-0` 只有 2.2:1），所以暗色的 accent 族（`border-focus` / `fill-accent-hover` 取 A→bg(44)，`text-accent` 取 A→bg(54)，`fill-accent` 取 A→bg(36)，`fill-brand` 取 A→bg(24)）都是向 `bg` 提亮的版本，实心强调底上放深字（`--t-text-on-accent` ＝ `text` 种子）。暗色 `text-accent` 比焦点环再亮一档，是因为链接也出现在弹窗和菜单的 `surface-overlay` 上：A→bg(44) 在那里只有 3.9:1，A→bg(54) 是 4.7:1。

### border

| 键 | 亮 | 亮算式 | 暗 | 暗算式 | 用在哪 |
|---|---|---|---|---|---|
| `--t-border-subtle` | `#d9dbd9` | N12 | `#303334` | D12 | 表格行线、消息分割发丝线 |
| `--t-border-default` | `#c7c9c8` | N20 | `#898b8b` | D52 | 输入框、卡片、Menu 外框 |
| `--t-border-strong` | `#808382` | N52 | `#adafae` | D68 | 次要按钮描边、引用块竖线 |
| `--t-border-focus` | `#1e5e4a` | 种子 accent | `#7ca094` | A→bg(44) | 焦点环（2px，offset 2px） |

### fill

| 键 | 亮 | 亮算式 | 暗 | 暗算式 | 用在哪 |
|---|---|---|---|---|---|
| `--t-fill-brand` | `#1e5e4a` | 种子 accent | `#518273` | A→bg(24) | 指示条、选中点、品牌标记（不带字） |
| `--t-fill-brand-quiet` | `#d2ddd8` | bg→A(16) | `#19352d` | text→A(40) | 强调淡底：选中 Chip、引用高亮 |
| `--t-fill-accent` | `#1d5644` | A→text(12) | `#6b9487` | A→bg(36) | 主按钮实心底 |
| `--t-fill-accent-hover` | `#1c4d3e` | A→text(24) | `#7ca094` | A→bg(44) | 主按钮 hover / active |
| `--t-fill-neutral` | `#d9dbd9` | N12 | `#303334` | D12 | 次要按钮 / IconButton 底 |
| `--t-fill-neutral-hover` | `#d0d2d0` | N16 | `#393c3d` | D16 | 次要按钮 hover |
| `--t-fill-danger` | `#ab363a` | HSL(358, 52%, 44%) | `#ab363a` | 同 | 破坏性按钮实心底 |

### alpha

叠在未知底色上的洗色与遮罩。**亮暗的基色不同**：亮色用 `text` 叠暗，暗色用 `bg` 叠亮。五个不透明度是本文定的（§8.1 没给），按「洗色 / 按下 / 分隔 / 遮罩」四种用途分档，暗色一律比亮色高 2 个百分点——同一层叠色在深底上看着更浅。

| 键 | 亮 | 暗 | 用在哪 |
|---|---|---|---|
| `--t-alpha-1` | `rgb(21 25 26 / 0.04)` | `rgb(244 245 243 / 0.06)` | 图像/代码块上的行 hover |
| `--t-alpha-2` | `rgb(21 25 26 / 0.08)` | `rgb(244 245 243 / 0.1)` | 按下态、拖拽落点 |
| `--t-alpha-3` | `rgb(21 25 26 / 0.16)` | `rgb(244 245 243 / 0.18)` | 分隔线叠在图像上、滚动条拇指 |
| `--t-scrim` | `rgb(21 25 26 / 0.48)` | `rgb(0 0 0 / 0.6)` | Modal 遮罩、图片灯箱底 |

### role（别名层）

§8.5 没列这一层，是本文加的：唯一允许指向别的语义键的一层，用来把「这块面是什么」和「它长什么样」解耦——换装时只改上面的表，这一层不动。

| 键 | 亮 | 暗 |
|---|---|---|
| `--t-role-user-bubble` | `var(--t-surface-2)` | `var(--t-surface-2)` |
| `--t-role-code-bg` | `var(--t-surface-3)` | `var(--t-surface-3)` |
| `--t-role-tooltip-bg` | `var(--t-surface-inverse)` | `var(--t-surface-inverse)` |
| `--t-role-tooltip-fg` | `#f4f5f3` | `#15191a` |

## 接到 Tailwind 4

两个文件，职责分开：

- `apps/desktop/src/styles/tokens.css` —— **只有上面这些表**。纯 CSS 自定义属性，三个块（`:root` / `@media (prefers-color-scheme: dark)` 下的 `:root:not([data-theme="light"])` / `[data-theme="dark"]`），不 import Tailwind，不写任何选择器规则。
- `apps/desktop/src/styles/theme.css` —— `@import "tailwindcss";` + `@theme inline { ... }`，把令牌接进 Tailwind 的命名空间，生成工具类。

**必须用 `@theme inline`**：非 inline 的 `@theme` 会把变量在编译期求值固化，生成的背景色工具类就锁死成亮色的那个 hex，`[data-theme="dark"]` 切不动。`inline` 让工具类输出 `background-color: var(--t-surface-0)`，主题切换才落得下来。

映射方式（示例，不是全文件——照着这几行把每一层铺完）：

```css
@import "tailwindcss";

@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));

@theme inline {
  /* 清空 Tailwind 自带调色板，bg-red-500 这类直接不存在 */
  --color-*: initial;

  --color-shell-bg:     var(--t-shell-bg);
  --color-surface-0:    var(--t-surface-0);
  --color-text-primary: var(--t-text-primary);
  --color-border-default: var(--t-border-default);
  /* …每个 --t-<layer>-<step> 对应一个 --color-<layer>-<step>；
     工具类的名字是这套键名的机械结果，不从任何外部样式表摘 */

  --spacing: var(--t-space-unit);          /* p-2 = 8px，一行接完整条梯级 */
  --radius-sm: var(--t-radius-sm);         /* rounded-sm */
  --font-sans: var(--t-font-sans);         /* font-sans */
  --font-serif: var(--t-font-serif);       /* font-serif */
  --text-ui: var(--t-size-ui);             /* text-ui */
  --text-ui--line-height: var(--t-leading-ui);
  --font-weight-medium: var(--t-weight-medium);
  --ease-snap: var(--t-ease-snap);         /* → ease-* 工具类 */
}
```

对应关系：`--color-*` → `bg-* / text-* / border-*`；`--spacing` → 全部 `p-* / m-* / gap-* / size-*`；`--radius-*` → `rounded-*`；`--font-*` → `font-*`；`--text-*`（配 `--text-*--line-height`）→ `text-*` 一个类同时给字号和行高；`--font-weight-*` → `font-*`；`--ease-*` → `ease-*`。

两个没有主题命名空间的：

- **h-control / z**：Tailwind 没有对应 namespace。用本文自己命名的工具类补，`@utility ctl-h { height: var(--t-h-control) }`（`ctl-h-compact` / `ctl-h-lg` 同理），或组件里直接 `style`/`@apply` 写 `var(--t-h-control)`。不要写 `h-9` 这种数字类。
- **dur**：`duration-*` 在 Tailwind 4 里是数字工具类，不读主题。写 `duration-[var(--t-dur-snap)]`，或在组件 CSS 里写 `transition-duration: var(--t-dur-snap)`。不要写 `duration-200`。

## 组件不许写生色

**任何组件文件里不得出现颜色字面量。** 具体禁的：`#rrggbb`、`rgb(` / `rgba(` / `hsl(` / `oklch(` 直接量、Tailwind 自带调色板类（`bg-gray-100`、`text-red-500`、`border-neutral-300`）。只允许两种写法：本表键名映射出来的工具类（`bg-*` / `text-*` / `border-*`，名字由 `--t-` 键名生成），或 `var(--t-*)`。

三道拦：

1. `@theme inline` 里写 `--color-*: initial;`，Tailwind 自带调色板被清空——`bg-red-500` 不是"不该用"，是编译不出来。
2. lint 规则：`apps/desktop/src/**/*.{ts,tsx,css}` 里匹配 `#[0-9a-fA-F]{3,8}\b` 与 `\b(rgb|rgba|hsl|hsla|oklch)\(` 即失败，例外只有 `styles/tokens.css` 一个文件。挂在 `pnpm lint` 上（与 `i18n:check` 同一道门）。
3. 同一条规则适用于内联 `style`、`<svg fill>`、Streamdown 与 assistant-ui 的样式覆写——第三方组件的 class 覆写也走令牌。

几何同理：间距只用 4 的倍数（走 `--spacing`），控件高度只用 `--t-h-control-*`，圆角只用 `--t-radius-*`。

## 怎么换装

§8.3 定稿（一个主色 + 一套中性色阶、避开暖橙系、一套测过中英混排的开源字体）之后，改动范围：

- **必改，且只改这两个文件**：`apps/desktop/src/styles/tokens.css`（三个块里的值）和本文（表 + 派生规则里的种子行）。两者必须同一个 PR 里改，否则这张表立刻失真。
- **不改**：`theme.css` 的 `@theme inline` 映射（键名稳定，这正是这套键名存在的理由）、任何组件文件、`components.md`。
- **换装流程**：换三个种子 → 按派生规则重算两条梯级和强调 / 语义色 → 校验每个 `--t-text-*` 在自己那一套的 `--t-surface-0` 上 ≥ 4.5:1（`--t-text-disabled` 除外）、每个 `on-fill` 在对应实心底上 ≥ 4.5:1 → 换字族 → 重跑验收 12 的 Playwright 双语言截图，更新基线。
- **换装时不能动的**：「界面无衬线 + 助手正文衬线」的区分（§8.1 唯一不可动条款）；`zh-CN` 下正文 16/28 与界面 14/20 的排版差（字族在中文字符上不区分，靠它承担「谁在说话」）；壳层背景是独立一层，不能并进 surface 梯级。
- **暗色**现在是纯反相（`D(p) = N(100 − p)`），定稿时**必须重新配**，不能继续反相：反相后的暖色底在暗色下会偏脏，语义色的明度也要重新按暗底反推。这是 §8.3 的交付物之一。
- 遗留冲突：旧种子的 `accent #c96442` 与 `warning` 色相只差 25°，视觉上区分不足；换成绿色主色后这一对消失了，但出现同类的一对——`accent` 色相 161° 与 `success` 148° 只差 13°，两个都是绿。现在 `success` 只出现在带图标和文字的完成态里，`accent` 是链接与按钮，位置不重叠，暂不处理；定稿时若两者会并排出现，`success` 要另换色相。

### 2026-10-15 临时换装记录

owner 决定离开 Claude 式的赤陶奶油，先换一组临时种子（`bg #f4f5f3` / `text #15191a` / `accent #1e5e4a`），定稿仍留给 §8.3。按上面的流程重算，下面几处不是机械照抄旧步长，因为新 accent 比暗色底面还暗，旧步长算出来过不了对比度：

| 键 | 暗色旧值（算式） | 暗色现值（算式） | 为什么 |
|---|---|---|---|
| `--t-border-default` | D20 | D52 | 输入框边框要在 Settings 弹窗（暗色里最亮的面 `surface-overlay`）上 ≥ 3:1：D20 只有 1.2:1，D52 是 3.3:1 |
| `--t-border-strong` | D52 | D68 | 保持比 default 更强 |
| `--t-border-focus` / `--t-fill-accent-hover` | A→bg(24) | A→bg(44) | 焦点环在 overlay 上 ≥ 3:1（3.9） |
| `--t-text-accent` | A→bg(24) | A→bg(54) | 链接在 `surface-0` 上 ≥ 4.5:1（7.6），在弹窗、菜单的 `surface-overlay` 上也 ≥ 4.5:1（4.7）；同日先取过 A→bg(44)，overlay 上只有 3.9:1（暗色设置页的「去取 key」），复核后提亮 |
| `--t-fill-accent` | A→bg(12) | A→bg(36) | 深字（`text-on-accent`）压在它上面要 ≥ 4.5:1（5.2） |
| `--t-fill-brand` | 同亮色（不反相） | A→bg(24) | 种子对暗色底面只有 2.2:1，指示条会消失；提亮后 4.0:1 |
| `--t-fill-brand-quiet` | text→A(20) | text→A(40) | 20% 在暗底上与底面几乎分不出 |

语义色的饱和度随 `accent` 从 56% 变成 52%，明度步长（38 / 30 / 30 与 64 / 58 / 58）不变，对比度仍都 ≥ 4.5:1。亮色的 `--t-border-default`（N20）对面只有 1.5:1，这次没动——亮色输入框轮廓偏淡是另一个问题，等 §8.3 一起定。`test/tokens-skin.test.ts` 用本文的种子和规则重算 `tokens.css` 的每个颜色，并守这些对比度。

## 值的来源声明

**这张表里没有一个值来自 uxkit**（plan 步骤 10.7 的硬要求）。键名是另一回事，§8.5 写得很清楚：`tokens.css` 的「键名可进，**值不进**」。

- **键名与分层照 §8.5 的允许保留**：读 `../tenon-uxkit/tokens.css` 的方式是 `sed -E 's/:[^;]*;/: <redacted>;/'`，值在进入上下文之前就被替换掉。层名（surface / text / border / fill / alpha / radius / h-control / weight / ease / dur / z）与层内的一部分档位名和那份键表一致，这是 §8.5 要的结果——键名稳定，换装才只改值。前缀换成 `--t-`。
- **由键名生成的 Tailwind 工具类**（`bg-*` / `text-*` / `ease-*` …）是键名的机械后果，不是从任何外部样式表摘来的类串。本文不写任何外部样式表里的类名；需要自定义工具类的地方（`ctl-h`）用本文自己的名字。
- **时长与缓动**：`interactions.md` §0 / §5 给的**节奏与配对关系**照做（AGENTS.md 与 §8.5 把它划为行为不是品牌），具体的毫秒数和贝塞尔控制点没有取包里的——五档时长是本文按 60Hz 下 5 帧一格排的梯级，四条曲线是本文按形状自己拟的控制点，也不抄公开曲线目录里的成品。
- `animations.json` 只含关键帧名与属性名，没有取用。
- **颜色**：2026-10-15 起是本文「种子与派生规则」里的三个临时种子，其余颜色都由那四条规则算出；§8.1 的赤陶奶油三色只作历史记录，不再生效。三个种子不出自 §8.1，也不出自包：取自 2026-09-12 十三款产品差异化调研的推荐值（仓库外，另记），当时记的是 owner 尚未确认。owner 2026-10-15 定的是离开赤陶、先换一组中性临时种子；这三个值本身算不算 owner 定稿，仓库里没有记录，按临时值对待，在本 PR 评审中由 owner 确认，定稿照 §8.3。
- **字族、字号、圆角**：来自本仓库的 §8.1 与 spec「国际化」，或由本文写明的算式推出。三款 CJK 回落在包里大量出现，那是两边都回落到同一批常见系统字体。`Inter` 与 `Source Serif` 在包里各只出现在 README 与实现说明里的同一句话中：那句话建议用三款开源字体替换包里的私有字体，三款正是 Inter、Source Serif 与 JetBrains Mono（只数位置，没有摘录）。Inter 与 Source Serif 4 是 §8.1 在 2026-09-12 建仓时（`7cb3f00`）就指定的，早于读包；本分支只是把它们随包分发。等宽栈 2026-10-15 起是 `Source Code Pro`（此前一个具体字体名都不写），它是新挑的，所以按「新挑的只挑零命中」排除了 JetBrains Mono，自查见下文「自查」与 type 表下的注。**§8.1 和 spec 都没给的**（等宽字族、h-control 梯级、z 梯级、weight、alpha 不透明度、字号倍率、时长与缓动），本文在对应表里注明是自己定的，并写出推法。
- 没有引用 `css/`，没有摘任何 class 串。

**自查**：把本表里的每个 hex、每条贝塞尔控制点、每个字体名，以及每个「键名 ＋ 值」组合（按包里的写法变体展开：`--x--sm:`、`.12s` 这类）在 uxkit 全包里逐个 grep 过一遍。2026-10-15 换装后又按同样的方式（只数命中，不读内容）重查了新的 46 个颜色值与新增的字体名：颜色里只有 `#fcfcfb`（`L(70)` 作用在 `bg #f4f5f3` 上的机械结果，规则定死，没有第二种写法）和白 `#ffffff` 有命中，字体里 Source Code Pro 零命中——候选里的 JetBrains Mono 在 uxkit 出现过（4 处，其中 2 处就是上面那句替换建议），等宽字体是新挑的，所以没有用它。同日复核后又查了两类，同样只数命中：暗色 `text-accent` 的新值 `#92b0a5` 零命中；`theme.css` 里每个自定义的 `@utility`、`@keyframes`、`@property`、`@custom-variant` 名字（`ctl-h-*` 五个、`edge-mask-y`、`edge-mask-end` 与它们的 `--edge-mask`、`ebb`、`overflow-hint` 与 `--overflow-hint-start` / `-end`、`mac`）也都是零命中——`dark` 是 Tailwind 自带变体的名字，这里只是改写它的选择器。此前有几个名字已经改名，以避开私有拆解包里的名字；以后在 theme.css 新增这几类名字，照此先数一遍。命中的只有这几类，都是绕不开的重合，不是取用：

| 命中 | 为什么绕不开 |
|---|---|
| `#ffffff` / `#000000` | `L(p)` / `B(p)` 两条派生规则的端点，白和黑没有第二种写法 |
| `#fcfcfb` | 当前种子下 `L(70)` 的结果，近白色，撞上是巧合；换种子就消失 |
| `24px` / `32px` | `--t-size-h1` / `--t-leading-h1`（body × 1.5，行高取 ≥ 1.3 倍的最小 4 倍数），通用像素值 |
| `regular` ↔ `400`、`medium` ↔ `500` | `font-weight` 规范自带的名值对应 |
| `system-ui` / `serif` / `monospace` / `ui-monospace` / `sans-serif` | CSS 通用字体关键字，不是字体名 |
| 三款 CJK 回落 | spec「国际化」指定的，两边都回落到同一批常见系统字体（见上一条） |
| `Inter`（2 处）、`Source Serif`（2 处） | 只在包里一句「换成这几款开源字体」的建议里出现；两款都是 §8.1 建仓时（`7cb3f00`）指定的，早于读包（见上一条） |
