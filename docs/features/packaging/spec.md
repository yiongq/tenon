# 安装包

Status: draft
Tier: heavy — 沙箱 helper 在包里的路径、钥匙串在打包后的身份都要先实测，而且第一次对外发布安装包
Changes: 04 §依赖（增补：打包版的 helper 与沙箱组件目录）；03 §接口（增补：McpPoolOptions 只增可选成员 clientVersion）

## 给你看的一页

做什么：打 tag 时让 CI 打出 Mac 和 Linux 安装包，照用户的方式装上、打开、确认能用，再建一个只有你看得见的草稿发布。

```
推版本 tag ──► 比对 tag 和版本号，对不上就停
   │
   ├─► Mac 机器：打包 ─► 解开 ─► 照用户的方式打开 ─┐
   └─► Linux 机器：打包 ─► 装上 ─► 从应用菜单打开 ─┤
                                                     ▼
                     读日志：窗口出来了、沙箱生效、正常退出
                                                     ▼
                     建一个草稿发布，附两个包；你看过再公开
```

例子：你推 v0.1.0。几分钟后，发布页面多一个草稿，标题是 v0.1.0，附 2 个文件：Mac 一个、Linux 一个，文件名里都带 0.1.0。说明的第一句写着这是没签名的预览版。你点「发布」之前，别人看不到它。

怎么算做完：
- 你推一个版本 tag → 发布页面多一个只有你看得见的草稿，附两个包，说明里写着未签名和怎么打开（验收 2、4、8）
- 版本号和 tag 对不上 → CI 在打包之前就失败，不出草稿（验收 1）
- 你在 Mac 上下载那个包，到「隐私与安全性」点「仍要打开」→ Tenon 打开，关于窗口写 0.1.0（验收 2、9）
- 你在安装版里点「帮助 → 打开日志文件夹」→ 访达打开日志文件夹（验收 9）
- 你在 Ubuntu 24.04 上装 Linux 包 → 一次装好，从应用菜单打开，沙箱生效（在 GitHub 的 24.04 机器上验过，别的机器看设置里的沙箱状态）（验收 4）
- 你打开安装版 → 会话和设置是空的，开发版的不受影响（验收 5、10）
- 开发版里存过的 key → 安装版第一次用它时，钥匙串弹框问你一次，允许之后能用（验收 10）
- 你翻装好的包 → 里面有许可证和三套字体的许可文本（验收 6）

不做：签名和公证；自动更新；Windows 包；其他 Linux 格式和 Intel Mac 包；升级沙箱组件。错误日志在另一份 spec 里，这一份等它做完再开工。

代价和已知限制：Mac 包没签名，第一次打开要去「隐私与安全性」放行。每装一个新版本，钥匙串都会对每把 key 再问一次。Ubuntu 26.04 上沙箱用不了，命令每条都问。Linux 没有钥匙串服务时，key 重启就丢，也不提示。包里还没有第三方依赖的许可证汇总，发给别人之前要补。

要你定的：这一份的 12 张卡都已定。lead 还替你定了 22 项，都写在决策记录里，你不推翻就算认可；最要紧的 5 项列在最后。
- 你定了：打成草稿，你看过再公开（不是直接公开，也不是只留在 CI 里）。
- 你定了：只打 Apple 芯片的 Mac 和 x64 的 Linux（不是再加 Intel Mac 或 Windows）。
- 你定了：Linux 只发 Ubuntu、Debian 用的那种包（不是再加一种会关掉浏览器沙箱的便携格式）。
- 你定了：安装版叫 Tenon，数据和开发版分开（不是共用并迁移）。
- 你定了：钥匙串里的 key 两边共用（不是安装版另起一份）。另有 7 条见决策记录。
- lead 替你定的：Mac 包只做本机签名，不公证；首个版本 0.1.0，手工改版本号；打包工具用发布规范里早就写下的那一个；冒烟照用户的方式打开、读日志判断；草稿由最后一步一次建好，免得建出两个。

## 外部依据

- 依赖错误日志那一份（`docs/features/error-logs/`）：冒烟读日志判断「启动、窗口出来了、沙箱生效、正常退出」，靠的是那一份 §接口「日志行」里的 `app.start`、`window.shown`、`sandbox.posture`、`sandbox.helpers`、`app.quit` 与运行标记，由它的验收 17 保证写得出；SIGTERM 在 srt 装上信号监听之后、Tenon 登记之前只让 srt 复位、不退出，所以冒烟等沙箱状态那一行出来再发（那一份的 §日志怎么写「SIGTERM」）。读日志一律按 JSON 逐行解析、看 `event` 字段。打包版的启动失败弹框与登记值的替换，代码与开发构建相同，由那一份测，这里不另测。所以这一份等 error-logs implemented 才开工。探针不必等它：P1–P6 先看 stderr 里已有的沙箱一行和静态检查。
- helper 必须在 asar 外、按资源目录拼路径：Electron 对 asar 路径的「文件在」回答证明不了沙箱可用，apply-seccomp 在 bwrap 里执行（E1、E2）；macOS 上 helper 路径错了姿态照样「生效」，要另查（E3、P2）。
- 钥匙串：macOS 按签名身份放行，ad-hoc 的身份随重新打包变化（E4、E5、P4）；Linux 没有 Secret Service 时静默退到 keyutils，CI 上的钥匙串往返测试是假绿（E4）。
- runner：`ubuntu-latest` 已是 26.04，04 实测那里沙箱自检失败，Linux job 钉 24.04（E6、P3）；26.04 上 04 的「写一份 bwrap 的 AppArmor 配置」不够，要先卸掉系统自带的那份（E17）。
- electron-builder 26.18：不再自动 ad-hoc，`identity: "-"` 是 ad-hoc（E7）；deb 自带 AppArmor 配置、要维护者邮箱（E8）；依赖与原生模块（E9）；发布要单独一个 job（E10）。
- 冒烟：Playwright 在 Linux 默认加 `--no-sandbox`（E11），打包版拒绝所有测试接缝（E12），所以照用户的方式起、读日志判断。
- 仓库里与打包相关的现状（E13）；Gatekeeper（E14、P7）；应用名从哪来（E15、P6）；默认的产物文件名带包名里的斜杠，deb 打不出来（E16）。
- 探针四轮（2026-11-28）全部跑完：包能用系统方式启动、两个原生模块能加载、沙箱姿态生效、沙箱里的三条命令符合预期（P1、P5），helper 在 asar 外可行（P2），每次内容或版本变化 CDHash 都变（P4），ad-hoc 加 hardened runtime 可用（P5），productName 要经 `extraMetadata` 注入（P6）；deb 一次装成、Chromium 沙箱开着，24.04 的 GitHub 镜像上不改设置沙箱就生效，26.04 上不可用（P1、P3）；只剩 owner 在真机上看的 P7。
- 调研原文与核实在仓库外的私有笔记（另记）。

## 接口

只写新增与改动的部分。日志行的格式归 error-logs §接口，这里不改。

```ts
// apps/desktop/src/main/host/sandbox-config.ts —— helperPaths 只增一个参数（§对 04 的增补）
export function helperPaths(arch: string = process.arch, resourcesPath: string | null = null): HelperPaths
// resourcesPath 非 null（打包版传 process.resourcesPath）时：
//   packageDir   = resourcesPath
//   applySeccomp = <resourcesPath>/sandbox/seccomp/<arch>/apply-seccomp
//   javaAgentJar = <resourcesPath>/sandbox/java-proxy-agent/srt-proxy-agent.jar

// packages/kernel/src/mcp/pool.ts —— 只增一个可选成员（§对 03 的增补）
export interface McpPoolOptions { /* 已有成员不动 */ readonly clientVersion?: string }
```

新增的配置与文件：`apps/desktop/electron-builder.yml`、`apps/desktop/packaging/release-notes.md`、`apps/desktop/resources/licenses/OFL-1.1.txt`、`.github/workflows/release.yml`、冒烟用例 `apps/desktop/test/package-smoke/`；要点见 §安装包怎么打。

**迁移和回退**：安装版的数据目录是新的（系统应用数据目录下的 `Tenon`），不迁移开发版的数据（D7）；开发版的数据目录不动。钥匙串里的条目两边共用，不搬（D9）。回退就是删掉安装版；开发版不受影响。没有回不去的点。

## 一直要成立的规矩

- `apps/desktop/package.json` 的 `name` 是 `@tenon-app/desktop`、没有 `productName`；productName 只写在打包配置里（由测试守）。
- 打包版交给沙箱的两个 helper 路径与沙箱组件目录都在 `process.resourcesPath` 下、不含 `.asar`；开发构建照 04 §依赖 不变（由测试守）。
- 安装包的冒烟不设任何 `TENON_` 开头的环境变量，不用 Playwright，不传 `--no-sandbox`（由冒烟用例里的断言守）。
- 打包与冒烟的 job 钉 `macos-15` 与 `ubuntu-24.04`，不用 `*-latest`（由测试守：读 release 工作流断言）。
- 只有建 Release 的那个 job 有 `contents: write`，构建 job 只有 `contents: read`（由测试守：读 release 工作流断言）。
- 改 `.github/workflows/**` 或测试运行配置的 PR 不开自动合并，等 owner 点名合并（AGENTS.md「Git」；没自动化，靠评审）。

## 安装包怎么打

- 工具：electron-builder 26.18.0，devDependency，精确钉版（E7、E9）。配置在 `apps/desktop/electron-builder.yml`：`appId: com.yiongspace.tenon`，`productName: Tenon`，`extraMetadata.productName: Tenon`；`directories.output: dist`；`files` 只收 `out/**` 与 package.json，排除 sandbox-runtime 的 `vendor/**`；`asar: true`；`npmRebuild: false`；`publish: null`；不配 `electronFuses`。
- 依赖：kernel、contracts 与只进打包产物的依赖挪到 devDependencies，`dependencies` 只留主进程运行时不打进 bundle 的包。两个原生模块用自带预编译件，每个平台在自己的 runner 上装依赖后打（E9）。新依赖带构建脚本时只往 `pnpm-workspace.yaml` 的 `ignoredBuiltDependencies` 追加，`strictDepBuilds` 与 `onlyBuiltDependencies` 不动（01 §SQLite 实现约束）；P1 实测只有 `electron-winstaller` 一个（Windows 安装器，用不上）。
- helper：`extraResources` 把 sandbox-runtime 的 `vendor/seccomp/<arch>/apply-seccomp` 与 `vendor/java-proxy-agent/srt-proxy-agent.jar` 拷到资源目录的 `sandbox/` 下，保留执行位；路径取法见 §对 04 的增补。
- 许可证：LICENSE、NOTICE 和 `licenses/OFL-1.1.txt` 随 `extraResources` 进资源目录；OFL 文件先列 NOTICE 里三套字体的版权行，后接 SIL 官方的 OFL 1.1 全文（E13）。
- 名字与数据（D7）：安装版的应用名是 Tenon，数据在系统应用数据目录下的 `Tenon`；开发模式照旧是 `@tenon-app/desktop`，因为 productName 不写进 `apps/desktop/package.json`（E15、P6）。
- 版本：`apps/desktop/package.json` 改成 0.1.0；日志每行的 `ver` 与 MCP 握手的版本都取 `app.getVersion()`。
- macOS：只打 arm64 的 zip；`mac.identity: "-"`；`hardenedRuntime: true`，entitlements 用 electron-builder 26 的默认三项（P5：两个 `.node` 能加载、沙箱姿态生效）；不公证。
- Linux：只打 x64 的 deb；`executableName: tenon`；`linux.artifactName: tenon_${version}_${arch}.${ext}`（E16）；deb 的依赖在默认列表上加 bubblewrap、socat、ripgrep；维护者 `yiongq <11135932+yiongq@users.noreply.github.com>`（D12）；package.json 写 `repository`（GitHub 仓库地址）、版权沿用 NOTICE 第二行（E8）。装到 `/opt/Tenon/`，桌面入口不带 `--no-sandbox`。
- 工作流：新建 `.github/workflows/release.yml`（门禁文件）。触发：推 `v*` tag、手动、改了打包相关文件的 PR。job：`version` 在 tag 时比对 tag 与版本号；`build-mac`（`macos-15`）与 `build-linux`（`ubuntu-24.04`）各自 `--publish never` 打包、装上、跑冒烟、上传产物，只给 `contents: read`；`release` 只在 tag 时跑，`needs` 两个构建，只有它有 `contents: write`，执行 `gh release create "$tag" --draft --verify-tag --title "$tag" --notes-file <说明模板> <两个包>`（E10）。不进 `ci-ok`。
- 冒烟：`apps/desktop/test/package-smoke/` 下的 vitest 用例，没设 `PACKAGE_SMOKE_DIR` 时整组跳过，构建 job 装好包后带上路径跑。macOS 用 `open -n -a` 起，Linux 按桌面入口的 Exec 在 `xvfb-run` 下起，都用默认数据目录。60 秒内等日志里出现 `app.start`、`window.shown`、state 为 active 的 `sandbox.posture`；等到这一行之后才发 SIGTERM（沙箱登记过信号，SIGTERM 才走正常退出），再等 `app.quit` 且运行标记被删；最后查日志里没有未替换的主目录与应用目录。Linux 上什么系统设置都不改（P3 的 (a)）：装 deb 时由依赖装上 bubblewrap、socat、ripgrep，就这样冒烟。
- 发布说明：模板 `apps/desktop/packaging/release-notes.md`，写这是没签名的预览版；macOS 怎么经「系统设置 → 隐私与安全性 → 仍要打开」打开（E14）；Linux 怎么装（`sudo apt install ./<文件>`），Ubuntu 24.04 上装好后沙箱在 GitHub 的镜像上直接生效（别的机器上不保证，看设置里的沙箱状态），Ubuntu 26.04 上沙箱不可用、命令每条都问（P3、E17）；日志在哪、里面没有什么；已知限制（§已知限制与代价）。

## 对 04 的增补

04 §依赖 的 helper 一条只管开发构建。打包版（`app.isPackaged` 为真）另按下面取，开发构建不变：
- 两个 helper 随包放在资源目录下：`<resourcesPath>/sandbox/seccomp/<arch>/apply-seccomp` 与 `<resourcesPath>/sandbox/java-proxy-agent/srt-proxy-agent.jar`，都是 asar 外的真实文件，apply-seccomp 有执行位。macOS 包同样带这两个文件，04 §启动、自检与姿态 第 2 步的检查不改（E3）。
- 交给 srt 的 `seccomp.applyPath`、`javaAgentJarPath` 就是这两个绝对路径；04 §档位到 srt 配置 写进 denyWrite 的「srt 包目录」，在打包版里取资源目录本身（D11）。
- 打包版从不把 app.asar 里的路径交给 srt：那里「文件在」的回答不可信，bwrap 里也看不到它（E1、E2）。
- 随包的 helper 取自 node_modules 里精确钉版的 sandbox-runtime；升级 srt 时随包文件一起换，照 04 §依赖 重跑验收 10–16（E2）。

## 对 03 的增补

03 §接口 的 `McpPoolOptions` 只增一个可选成员 `clientVersion: string`。连接池建 MCP 客户端时，客户端信息的 version 取它，缺省仍是 `0.0.0`，name 仍是 `tenon-kernel`；desktop 传 `app.getVersion()`。别的不变（D10）。

## 已知限制与代价

- Mac 包没签名：第一次要在系统设置里放行；每装一个新版本，钥匙串都会对每把 key 再问一次（P4 实测，P7 待真机确认弹框次数）；做不了自动更新。
- Ubuntu 26.04 上沙箱不可用，命令每条都问：三种系统设置下都是 `userns-restricted`；只有先卸掉系统自带的 `bwrap-userns-restrict` 再装 bwrap 的配置才生效，这一步不归本 spec，登记进「以后再说」（E6、E17、P3）。Ubuntu 24.04 上「装好即生效」只在 GitHub 的镜像上见过，很可能是 deb 自带的 AppArmor 配置也放行了沙箱起的 bwrap，用户机器上不保证（P3）；Linux 没有 Secret Service 时 key 存进内核钥匙环，重启即失、不提示（E4）；Debian / Ubuntu 系以外没有包。
- 包里没有第三方依赖的许可证汇总，草稿发给别人之前要补。
- CI 冒烟只在 `macos-15` 与 `ubuntu-24.04` 上跑，更新的 macOS 靠 P7 与走查；测不到 Gatekeeper（E14）与有桌面的 Linux 上的钥匙串（E4）。
- 冒烟不在 `ci-ok` 里：改打包的 PR 冒烟红了不会挡合并，靠评审看。

## 文档同步

- `docs/architecture/overview.md` 的技术栈表加 electron-builder 一行：26.18.0、为什么选（含「不能低于 26.18.0」）、在本 spec 定。
- `SECURITY.md` 的已知限制加 26.04、keyutils 与未签名。
- 总参考：阶段表加一行；「以后再说」登记「不做」的各条；§13「签名与分发」那一格的「首次打开需右键」改成「系统设置 → 隐私与安全性 → 仍要打开」（E14）。
- 03、04 页头的 `Changed by` 起草时已加；入口页 `docs/README.md` 随页头改动重新生成。

## 验收标准

1. tag 与 `apps/desktop/package.json` 的版本号不一致时，release 工作流在打包之前失败、不建 Release；一致时往下走。
2. macOS 包：CI 在 `macos-15` 上打出文件名带版本号的 arm64 zip，解开是 ad-hoc 签名、能过 `codesign --verify` 的 Tenon.app；用 `open -a` 起，日志里启动（安装版、版本号对）是第一行，窗口出来了、沙箱生效都出现；收到 SIGTERM 后正常退出是最后一行、运行标记被删；期间日志里没有错误级的行（Chromium 自己打到 stderr 的 runner 环境报错，如 macOS 的 XPC、Linux 的 DBus，不进日志，不算）（平台：macOS）。
3. macOS 包里两个沙箱 helper 是 asar 外、有执行位的真实文件，app.asar 里没有 sandbox-runtime 的 vendor 目录；日志里交给沙箱的三条路径是包的资源目录本身或它下面的文件、都不含 `.asar`（平台：macOS）。
4. Linux 包：CI 在 `ubuntu-24.04` 上打出 x64 的 deb，`apt-get install` 一次装成（连同 bubblewrap、socat、ripgrep）；桌面入口的启动命令不带 `--no-sandbox`，照它启动、什么系统设置都不改，Chromium 沙箱开着，日志里有启动、窗口出来了、沙箱生效和正常退出，期间日志里没有错误级的行（Chromium 自己打到 stderr 的 runner 环境报错，如 macOS 的 XPC、Linux 的 DBus，不进日志，不算）（平台：Linux）。
5. 安装版的数据在名为 Tenon 的目录（macOS `~/Library/Application Support/Tenon`，Linux `~/.config/Tenon`）；开发模式的应用名与数据目录照旧是 `@tenon-app/desktop`（平台：macOS、Linux）。
6. 两个包的资源目录里都有 LICENSE、NOTICE 和 OFL 1.1 全文，NOTICE 列的三行字体版权在全文前面（平台：macOS、Linux）。
7. 版本号处处一致：日志每行的版本、MCP 握手时报的版本都等于 `apps/desktop/package.json` 的版本。
8. 推 tag 后，Release 页面多一个草稿（不公开）：标题是 tag，附两个包，说明里写明未签名、macOS 怎么「仍要打开」、Linux 怎么装、日志在哪、已知限制（人工）。
9. owner 在自己的 Mac 上用浏览器从草稿下载 zip，经「系统设置 → 隐私与安全性 → 仍要打开」能打开，关于窗口写 0.1.0；安装版里「帮助 → 打开日志文件夹」在访达里打开日志文件夹（人工）。
10. owner 在开发版里存过 key 后打开安装版：会话和设置是空的，开发版的不受影响；钥匙串的授权框写的是 Tenon，允许之后那把 key 能用（人工）。
11. 安装版的日志里没有未替换的主目录与资源目录：冒烟跑完后，`main.jsonl` 里找不到 runner 主目录的绝对路径，也找不到包的资源目录（`process.resourcesPath`，含 app.asar 里的路径）的绝对路径，它们都写成了 `~` 与 `<app>`（平台：macOS、Linux）。

## 开放问题

1. 重新打包后钥匙串弹框的实际样子：P4 已定每装一个新版本都会对每把 key 再问；弹几次、框上写谁、点「始终允许」后还弹不弹，由 owner 在真机上做 P7，批 ready 之前做完，结果写进发布说明。
2. 打包冒烟进不进 `ci-ok`：owner 定（要改分支保护与 `ci.yml`），合并后至少跑过两次 tag 再定；改 implemented 时没定就进「以后再说」。

## 修订记录

从 ready 起每次改动记一行：日期 · 哪一节 · 为什么 · 相关的提交号或 PR 号。
