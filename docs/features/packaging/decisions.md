# 安装包 · 决策卡

每张卡写明：编号、问题、每个选项的代价、★ 推荐、选错了难不难退。agent 自定的选择列在「agent 自定」一节，owner 批 ready 时一并看，可以推翻。

这一份原先和错误日志写在同一份 spec 里，2026-11-28 owner 定了拆开（D13）。卡号沿用拆开之前的编号，所以不连续；错误日志那份 spec（`docs/features/error-logs/`）用 D5、D8、D15–D20。D1、D4、D13、D14 两份都用到，两边各记一次，文字相同。12 张卡都已定。

## 2026-11-28 · owner 定的

### D1 · 这份 spec 按哪一档写
- A ★ heavy：先实测再写。四路调研、每路一份对抗核实，探针在批 ready 前跑。代价：起草更慢，探针要占 CI 时间。
- B standard：直接按调研写。代价：Electron 与打包后的行为（转储、主进程异常、helper 路径、钥匙串、签名）没实测，写错了要到实现或出包时才发现。

选错难退吗：不难。只影响把关多严。
结果：A · 2026-11-28（问卷）。

### D2 · 打出的包放哪
- A ★ 草稿 Release：CI 建草稿、附上包，owner 看过再手动发布。代价：每次发版要手动点一次发布。
- B 公开预发布：打 tag 就直接公开。代价：没签名的包和写错的说明一打 tag 就发出去了，撤不回别人已下载的。
- C 只留 CI 产物：不建 Release。代价：要去 Actions 页面找，有保留期，不方便给别人。

选错难退吗：中等。公开过的撤不回下载；A、C 之间换只改 workflow。
结果：A · 2026-11-28（问卷）。

### D3 · 打哪几个平台
- A ★ macOS arm64 + Linux x64。代价：Intel Mac 与 Windows 没有包。
- B 再加 macOS Intel。代价：CI 上没有能实际运行它的机器，包打得出来却没法冒烟（E6）。
- C 再加 Windows。代价：上游沙箱在 Windows 上还是 Alpha；Tenon 在 Windows 上没有 OS 级沙箱，也没测过。

选错难退吗：不难。以后加平台只加 job。
结果：A · 2026-11-28（问卷）。

### D4 · 「给你看的一页」用不用新格式
- A ★ 当试点：只在这份 spec 里手工用新格式（一张图、一个带数的例子、「你做 X → 你看到 Y」的场景、你定过的事逐条写），sdd 模板和 spec-check 不改。代价：这一页和别的 spec 长得不一样，仍要过现有检查。
- B 照旧格式。代价：新格式好不好用没有实例可看。

选错难退吗：不难。只是一页的写法。
结果：A · 2026-11-28（问卷）。

### D6 · Linux 发什么格式
- A ★ 只发 deb。代价：Debian / Ubuntu 系以外的发行版没有包。
- B deb + AppImage。代价：electron-builder 26 的 AppImage（legacy 运行时）生成的桌面入口无条件带 `--no-sandbox`，与硬规矩「每个窗口 `sandbox: true`」冲突；还要 FUSE（E8）。

选错难退吗：不难。以后加格式只加 target。
结果：A · 2026-11-28（问卷）。

### D7 · 安装版叫什么、数据放哪
- A ★ 叫 Tenon，和开发数据分开：productName 为 Tenon，appId 沿用钥匙串服务名 `com.yiongspace.tenon`；安装版数据在新的「Tenon」目录，开发模式继续用原来的「@tenon-app/desktop」目录。代价：安装版首次打开是空的。
- B 共用并迁移。代价：要写迁移；开发版和安装版抢同一个单实例锁，不能同时开。

选错难退吗：中等。A 改 B 要写迁移，B 改 A 要拆数据。
结果：A · 2026-11-28（问卷）。起草时补一句：会话和设置在数据目录里，是空的；key 不在数据目录里，在系统钥匙串里按服务名和账户名存，两边服务名相同，所以安装版读得到开发版存过的 key（macOS 上先弹框问一次）。要不要分开见 D9。

### D9 · 安装版和开发版共不共用钥匙串里的 key
背景：key 按服务名 `com.yiongspace.tenon`（00 §本地持久化布局）和账户名 `<tenantId>:<key>` 存在系统钥匙串里，两边服务名相同（E4、E5）。
- A ★ 共用，服务名不变。代价：macOS 上安装版第一次读每把 key 会弹一次钥匙串授权框，点「始终允许」之后不再弹，直到下一次重新打包（会不会再弹由 P4、P7 定）；两边改 key 会互相覆盖；Linux 没有按应用的授权，直接共用。
- B 安装版换一个服务名，从空的钥匙串开始。代价：要改 00 已 implemented 的服务名那一句（写增补并点名）；你要在安装版里把 key 重新填一遍。

选错难退吗：中等。换方向时，已经存在另一边的 key 要搬或重填。
结果：A · 2026-11-28（问卷）。P4 实测：同一份源码重打 CDHash 不变，改版本号、productName、内容或开 hardened runtime 都变，所以每装一个新版本，钥匙串都会对每把 key 再问一次；上面「直到下一次重新打包」那句照此读。

### D10 · MCP 连接器看到的 Tenon 版本号跟不跟着变
背景：kernel 握手时报给 MCP server 的版本写死成 0.0.0；kernel 不能读进程信息，要由 desktop 传进去（E13）。
- A 不变，仍报 0.0.0。代价：连接器那边的日志永远是 0.0.0，和包的版本对不上。
- B ★ 连接池选项只增一个可选成员，desktop 传应用的版本。代价：给 03 §接口 写一条只增可选成员的增补，03 页头加一行回链。

最小方案为什么不行：这份 spec 要做到版本号不再是 0.0.0，Tenon 对外报版本的地方里只剩这一处写死。
选错难退吗：不难。可选成员，缺省仍是 0.0.0。
结果：B · 2026-11-28（问卷）。这一条也是 owner 对「给 03 §接口 增补一个可选成员」的点名同意。

### D11 · 安装版里，沙箱禁止写的「沙箱组件目录」取哪里
背景：04 把 sandbox-runtime 的包目录写进禁止写的名单，免得沙箱里的命令改掉沙箱自己。开发构建里它是 node_modules 下的真实目录；打包后它在 app.asar 里面，不是真实目录，交给 bwrap 可能让沙箱整体起不来（E1、E2）。
- A ★ 取应用的资源目录（里面有 app.asar 和随包的两个 helper）。代价：沙箱里的命令连 Tenon 自己的程序文件也写不了，比开发构建管得宽一点；正常命令本来也不写它。
- B 只取随包 helper 所在的子目录。代价：工作区包含应用目录时，app.asar（里面有沙箱组件的代码）可被沙箱里的命令改写，下次启动生效。
- C 把整个沙箱组件解出 asar，用解出后的目录。代价：包里多一份代码；路径要从 app.asar 手工换成 app.asar.unpacked，正是 E1 说的易错处。

选错难退吗：不难。只改打包版取路径的一处。
结果：A · 2026-11-28（问卷）。

### D12 · Linux 包上写谁的名字和邮箱
背景：deb 必须写维护者的名字和邮箱，没有就打不出来，它随包公开（E8）。这要 owner 才知道。
- A ★ 用 GitHub 给你的 noreply 地址。代价：别人按这个地址联系不到你。
- B 你自己的邮箱。代价：邮箱随每个包公开。
- C 一个项目用的地址。代价：现在还没有，要先建。

选错难退吗：中等。发出去的包改不回来，之后的包可以换。
结果：A · 2026-11-28（问卷）。维护者写 `yiongq <11135932+yiongq@users.noreply.github.com>`（地址由 lead 同日转达）。

### D13 · 日志和安装包拆不拆成两份 spec
- A ★ 拆成两份：错误日志先做；安装包等日志做完、探针跑完再批。代价：两份各自维护；安装包的冒烟要读日志，依赖错误日志那份先做完。
- B 一份做到底。代价：安装包的细节大多要等探针，整份都批不了 ready，日志这一半本来可以先动手。

选错难退吗：不难。还没开工，合回去只是搬文字。
结果：A · 2026-11-28（问卷）。

### D14 · 探针能不能开 CI 草稿 PR 去跑
- A ★ 可以开：探针只在草稿 PR 里跑，不合并、不开自动合并，不在你的 Mac 上起 Electron。代价：占 CI 时间，macOS 机器的分钟数贵。
- B 先不跑，照调研写。代价：Electron 与打包后的行为写错了，要到实现或出包时才发现。

最小方案为什么不行：heavy 档要求探针在批 ready 之前跑完（D1）。
选错难退吗：不难。
结果：A · 2026-11-28（问卷）。

## agent 自定

起草者（lead）事先定的六项：
- 自定：放哪 · `docs/features/packaging/`，不占 architecture 编号；总参考阶段表加一行，写明是从阶段 7 提前的部分 · 07 已留给扩展层
- 自定：打包工具 · electron-builder，精确钉 26.18.0 · 总参考「阶段 0 之前」的发布规范表本来就写它；26.18.0 才修了 pnpm 下漏包，不能更低；27 还是 alpha（E7、E9）
- 自定：macOS 签名 · ad-hoc 签名，不公证；hardened runtime 照 P5 的结果开 · 完全不签在 Apple 芯片上的表现证据不一致（E7）；P5 实测 ad-hoc 加 hardened runtime 能加载两个原生模块、沙箱姿态生效
- 自定：原生模块 · better-sqlite3 与 @napi-rs/keyring 用自带的预编译件，`npmRebuild` 关掉 · 两个都是 Node-API 预编译，开着只是白跑一遍 node-gyp（E9）
- 自定：版本号 · 首个版本 0.1.0，手工改版本号再打 tag，不引入 release-please / changesets · 单人项目，一次改一个数字最简单；总参考「版本」那一格的 CHANGELOG 生成登记进「以后再说」
- 自定：macOS 包里的 helper · 带上启动检查要求的两个 helper，不改 04 的启动检查 · 改它属于改 implemented 的机制，读完 04 没有非改不可的理由（E3）

起草中定的：
- 自定：macOS 发什么文件 · 只发 zip，不发 dmg · 冒烟只要解压，少一个产物；探针里 dmg 也打得出、挂得上、能启动（P1 附加），以后要发随时加
- 自定：冒烟怎么起应用 · 照用户的方式（macOS `open -n -a`，Linux 用应用菜单里的那条启动命令），读日志判断，不用 Playwright · Playwright 在 Linux 默认加 `--no-sandbox`，会盖住 Chromium 沙箱这一项；打包版也不认测试接缝（E11、E12）
- 自定：冒烟测试放哪 · vitest 用例，没给出包的路径就跳过，在打包 job 里带路径跑 · 用例名能被 spec-check 点名，平时的 CI 里按（平台）跳过
- 自定：Release 谁建 · 两个构建 job 只构建，最后一个 job 用 `gh release create --draft --verify-tag` 一次建好 · 两个 job 各自发布会竞态建出两个草稿（E10）
- 自定：release 工作流什么时候跑 · 推 `v*` tag、手动触发、改了打包相关文件的 PR；只有 tag 才建 Release；不进 `ci-ok` · 打包的改动在 PR 上就看得见；进不进 `ci-ok` 要改分支保护，归 owner
- 自定：版本号对不上 · tag 与 `apps/desktop/package.json` 的版本不一致就在打包前失败 · 版本只在一处改（E10）
- 自定：哪些包改版本号 · 只改 `apps/desktop`；根目录、kernel、contracts 仍 0.0.0 · 后三个是私有包，不单独发布
- 自定：deb 的依赖 · 在默认列表上加 bubblewrap、socat、ripgrep · 沙箱要用它们，装包时一并装上（E2）
- 自定：依赖分类 · kernel、contracts 与只进打包产物的依赖挪到 devDependencies · 它们已打进 bundle；electron-builder 对 `workspace:`、`catalog:` 的收集没核实过，挪走就不经过它（E9）
- 自定：productName 写在哪 · 不写进 `apps/desktop/package.json`，只写在打包配置里，经 `extraMetadata` 注入包内的 package.json · Electron 优先取 productName，写进源码的 package.json 会让开发模式的应用名和数据目录跟着变（E15；P6 实测）
- 自定：许可证文件 · LICENSE、NOTICE 和一份「三行字体版权 + OFL 1.1 全文」放进包的资源目录 · NOTICE 要求随包附 OFL 全文（E13）
- 自定：package.json 的 repository 与版权 · repository 写 GitHub 仓库地址；版权沿用 NOTICE 第二行 · deb 要 homepage 或 repository 之一；两样都已在仓库里公开（E8）
- 自定：发布说明 · 仓库里放一份模板：未签名、macOS 怎么「仍要打开」、Linux 怎么装、日志在哪、已知限制 · 总参考里「首次打开需右键」在 macOS 15 起已失效（E14）
- 自定：srt 的 vendor 目录 · 不进 app.asar，只在资源目录下留一份 · 免得包里两份、路径交错（E1）
- 自定：Linux 打包与冒烟的 runner · 钉 `ubuntu-24.04` · `ubuntu-latest` 已是 26.04，04 实测那里沙箱自检失败（E6）
- 自定：Linux 产物的文件名 · `linux.artifactName` 写成 `tenon_${version}_${arch}.${ext}` · 默认文件名带包名里的斜杠，deb 打不出来（E16）

## owner 原话

- 2026-11-28 · 「把打包和错误日志提前做，起草 spec」 · 对话
- 2026-11-28 · 问卷：档位选「heavy (Recommended)」；发布位置选「草稿 Release (Recommended)」；平台选「macOS arm64 + Linux x64 (Recommended)」；试点选「当试点 (Recommended)」 · 对话
- 2026-11-28 · 「开跑」（同意 heavy 调研的规模） · 对话
- 2026-11-28 · 问卷：崩溃转储选「不留转储 (Recommended)」；Linux 包格式选「只发 deb (Recommended)」；名字和数据选「Tenon，和开发数据分开 (Recommended)」 · 对话
- 2026-11-28 · 问卷：界面报错选「只记第一行 (Recommended)」；钥匙串选「共用 (Recommended)」；沙箱保护范围选「整个应用资源目录 (Recommended)」；维护者邮箱选「GitHub 的 noreply 地址 (Recommended)」 · 对话
- 2026-11-28 · 问卷：03 接口增补选「跟着变，03 加可选项 (Recommended)」；拆不拆选「拆成两份 (Recommended)」；探针 PR 选「可以开 (Recommended)」 · 对话
- 2026-11-28 · 问卷：03 再加一项选「加这个可选项 (Recommended)」；两道保护选「都认可 (Recommended)」 · 对话
