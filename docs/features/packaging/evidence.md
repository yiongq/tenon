# 安装包 · 先核实

这里放这份 spec 依赖的第三方事实和仓库现状（E），以及批 ready 之前要跑的探针（P）。调研分四路，每路一份调研、一份对抗核实，原文在仓库外的私有笔记 `../tenon-notes/2026-11-28-packaging-and-logs/research/`（另记；这一份主要用第 01、02、04 路）；核实文件的更正优先于调研原文。这里只留结论和一手来源；被推翻或「未核实」的说法不写成事实，要依赖的写成探针。日志、转储与进程事件的事实在错误日志那份 spec 的 evidence.md。

## 事实

### E1 · Electron 44.4.1 对 asar 路径的补丁
- 结论：对 app.asar 里的路径，`existsSync`、`statSync` 只看 asar 头，回答「在」；`realpathSync` 返回 app.asar 里的路径，不是 `.unpacked`；`accessSync(X_OK)` 对没解出的条目不查执行位。只有 `execFile`、`execFileSync` 被补丁（先把文件拷出再执行），`spawn` 原样透传，asar 路径会 ENOTDIR。所以「文件在不在」的检查证明不了沙箱可用；helper 必须在 asar 外，路径用 `process.resourcesPath` 拼。
- 一手来源：https://github.com/electron/electron/blob/v44.4.1/lib/node/asar-fs-wrapper.ts （`overrideChildProcess`、`wrapRealpathSync`、`asarStatsToFsStats`）；https://www.electronjs.org/docs/latest/tutorial/asar-archives
- 核查：确认（核实文件 02 的 C7、C8，读 v44.4.1 标签，2026-11-28）。
- 什么时候重核：升 Electron 大版本时。

### E2 · sandbox-runtime 0.0.79 的 helper 与可配置项
- 结论：apply-seccomp 在 bwrap 里面执行（`--` 之后的 `shell -c` 里），asar 虚拟路径在里面不存在。可配置项：`seccomp.applyPath`（`seccomp.argv0` 只给 multicall 二进制）、`javaAgentJarPath`、`bwrapPath`、`socatPath`（这三个 schema 强制绝对路径）、`ripgrep.command`。包里只有 `dist`、`vendor/seccomp`、`vendor/srt-win`、`vendor/java-proxy-agent`，不带 bwrap、socat、rg。显式的 `applyPath` 不存在时，srt 回落到包内、再到全局 npm。npm 最新是 0.0.83，vendor 布局不变、文件字节每版都变；0.0.80 起 Linux 沙箱里的命令不能再建命名空间。
- 一手来源：https://registry.npmjs.org/@anthropic-ai/sandbox-runtime/-/sandbox-runtime-0.0.79.tgz （`dist/sandbox/sandbox-config.js`、`dist/sandbox/linux-sandbox-utils.js` 的 `wrapCommandWithSandboxLinux`、`dist/sandbox/generate-seccomp-filter.js`、`package.json` 的 `files`）；https://github.com/anthropics/sandbox-runtime/releases/tag/v0.0.80
- 核查：确认（核实文件 02 的 C3、C4、C10、C11）。
- 什么时候重核：升 sandbox-runtime 时。

### E3 · Tenon 的启动检查在 macOS 上也要两个 helper
- 结论：`apps/desktop/src/main/host/sandbox-posture.ts` 的 `startup` 第 2 步只看架构、不看平台：jar 一律查，x64、arm64 上再查 apply-seccomp，缺了姿态记 `unavailable`、原因 `other`。macOS 上 srt 用系统的 `/usr/bin/sandbox-exec`，不执行这两个文件，jar 只在沙箱里跑 Java 时才被读；所以 macOS 上 helper 路径错了，姿态照样是「生效」，看启动输出测不出来，要另查（P2）。
- 一手来源：仓库 `apps/desktop/src/main/host/sandbox-posture.ts`（`startup`）、`apps/desktop/src/main/host/sandbox-config.ts`（`helperPaths`）；srt 0.0.79 `dist/sandbox/macos-sandbox-utils.js`（`wrapCommandWithSandboxMacOS`）。
- 核查：确认（核实文件 02 的 C1、C2 与第 4 节；核实文件 04 重点项 7）。
- 什么时候重核：改 `sandbox-posture.ts` 的启动检查时。

### E4 · @napi-rs/keyring 2.1.0 在两个平台上落在哪
- 结论：macOS 用旧式的文件钥匙串（`SecKeychain*` 系列），不是 data protection keychain；后者要 provisioning profile，ad-hoc 的包拿不到。Linux 先试 Secret Service，连不上 D-Bus 会话或服务时静默退到内核 keyutils（只在内存里，重启即失）；每次构造 Entry 都重选一次后端，同一进程里前后可能落到不同的后端。无桌面的 CI 上钥匙串往返测试会走 keyutils 并通过，证明不了 Secret Service 那条路，是假绿。
- 一手来源：https://registry.npmjs.org/@napi-rs/keyring/-/keyring-2.1.0.tgz （`README.md`、`index.d.ts` 的 `LinuxEntryOptions`）；keyring-node 源码 v2.1.0 标签（`src/entry_builder.rs`、`linux_credential_builder.rs`）；https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains
- 核查：确认（核实文件 02 的 C15、C17、C18）；「GitHub 的 Ubuntu 镜像没装 gnome-keyring」只算推断。
- 什么时候重核：升 @napi-rs/keyring 时（2.1.2 起 macOS 预编译件带别人的 Team ID）。

### E5 · macOS 钥匙串按签名身份放行
- 结论：文件钥匙串的每个条目有 ACL，按调用方签名的 designated requirement 认人，不认路径和版本；认不出就弹框，可选拒绝、允许、始终允许。ad-hoc 签名的 designated requirement 绑在那一份代码的 cdhash 上。按整包 ad-hoc 签名时 Info.plist 与资源（含 app.asar）都进了签名，内容或版本一变 cdhash 就变（P4 实测成立）。开发用的 Electron 是另一个身份，所以开发版存的条目，安装版第一次读会弹框。
- 一手来源：https://developer.apple.com/documentation/security/access-control-lists ；https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements ；https://developer.apple.com/forums/thread/115425
- 核查：ACL 与 ad-hoc 身份确认，「版本或内容一变 cdhash 就变」由 P4 实测确认（同源码同配置打两次不变）；弹框的样子等 P7。
- 什么时候重核：P7 跑完时；改签名方式时。

### E6 · GitHub runner 与 Ubuntu 上的沙箱
- 结论：`ubuntu-latest` 从 2026-10-19 起分批迁到 Ubuntu 26.04（计划 11-19 迁完）；`macos-15` 是 arm64，`ubuntu-24.04` 是 x64。04 的实测：24.04 上把 `kernel.apparmor_restrict_unprivileged_userns` 设成 0 沙箱就生效；26.04 上设 0 自检仍失败（apply-seccomp 的嵌套命名空间被限）；装 04 修法里的 bwrap AppArmor 配置后两版都生效。实测在 Lima 的 arm64 镜像上，不是 GitHub 的 x64 镜像（P3 复测）。所以打包与冒烟的 Linux job 钉 `ubuntu-24.04`，「26.04 上沙箱不可用」进已知限制。
- 一手来源：https://github.com/actions/runner-images/issues/14748 ；https://github.com/actions/runner-images （README 的标签表）；04 plan.md 实施记录「第零段」；04 §启动、自检与姿态 第 6 步。
- 核查：确认（核实文件 01 第 4 节第 1 条；核实文件 02 的 C21 与第 3 节）。
- 什么时候重核：GitHub 改 runner 标签、或 Ubuntu 出新 LTS 时。

### E7 · electron-builder 26.18 的 macOS 签名与产物
- 结论：npm 上 `latest` 是 26.18.0（2026-10-20），`v26` 是 26.18.1，`next` 是 27 alpha，MIT。26.15.0 起没有证书就整个跳过签名，不再自动 ad-hoc；`mac.identity` 写 `"-"` 是 ad-hoc。ad-hoc 加 hardened runtime 时，entitlements 缺 `disable-library-validation` 会启动失败（社区复现），26 的默认 entitlements 已含这一项。mac 默认产物是 dmg + zip，zip 由 7za 打；dmg 的 hdiutil 在 runner 上有偶发失败的第三方报告。「完全不签的 arm64 包下载后报已损坏」证据不一致。
- 一手来源：https://registry.npmjs.org/electron-builder ；https://www.electron.build/v26/docs/features/code-signing/code-signing-mac ；https://github.com/electron-userland/electron-builder/pull/9822 ；app-builder-lib 26.18.0 包里的 `scheme.json`、`templates/entitlements.mac.plist`、`out/mac/MacTargetHelper.js`
- 核查：确认；「已损坏」一句未核实（核实文件 01 的 (2)(3)）。
- 什么时候重核：升 electron-builder 时。

### E8 · electron-builder 的 Linux 目标
- 结论：deb 的安装后脚本在 AppArmor 启用、且支持 `abi/4.0` 时，给 `/opt/<产品名>/<可执行文件>` 装一份带 `userns` 的 profile（`flags=(unconfined)`）；只在内核不支持用户命名空间时才给 `chrome-sandbox` 设 SUID。P3 实测：24.04 与 26.04 上装了 deb 之后 Chromium 沙箱都开着。deb 必须有作者邮箱或 `linux.maintainer`，还要 homepage 或 repository 之一（读不到 .git 时）；构建时下载 fpm。AppImage（26 默认的 legacy 运行时）生成的桌面入口无条件带 `--no-sandbox`，还要 FUSE。
- 一手来源：https://registry.npmjs.org/app-builder-lib/-/app-builder-lib-26.18.0.tgz （`templates/linux/after-install.tpl`、`templates/linux/apparmor-profile.tpl`、`out/targets/FpmTarget.js`、`out/appInfo.js`、`out/targets/AppImageTarget.js`）
- 核查：确认；「必须有 homepage」更正为 homepage 或 repository 之一（核实文件 01 的 (9) 与 C48）。
- 什么时候重核：升 electron-builder 时。

### E9 · 依赖与原生模块
- 结论：better-sqlite3 13.0.3 带 8 个平台的 Node-API 预编译件、没有安装脚本；@napi-rs/keyring 2.1.0 是 NAPI-RS，平台件是可选依赖，pnpm 只装本机平台那个，所以每个平台的包要在那个平台的机器上装依赖后打。Node-API 10 要 Node ≥ 22.14，Electron 44.4.1 带 Node 24.21.0。`npmRebuild: false` 跳过整个 @electron/rebuild，开着也只是白跑一遍 node-gyp、不报错。electron-builder 26.18.0 修了 pnpm ≥ 10.29.3 下「重复子树只打印一次」导致的漏包（#10323），本仓库 pnpm 10.30.2，所以不能低于 26.18.0；它怎么收集 `workspace:`、`catalog:` 声明的依赖没核实。缺另外 11 个平台的 keyring 可选件只警告，不让构建失败。
- 一手来源：https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-13.0.3.tgz ；https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0 ；https://nodejs.org/docs/latest-v24.x/api/n-api.html ；https://releases.electronjs.org/release/v44.4.1 ；app-builder-lib 26.18.0 的 `out/packager.js`（`installAppDependencies`）、`out/node-module-collector/pnpmNodeModulesCollector.js`、`out/util/appFileCopier.js`（`enforceAllowMissingDependencies`）
- 核查：确认（核实文件 01 的 (5)(6) 与第 4 节第 2–4 条）。
- 什么时候重核：升 electron-builder、pnpm、Electron 或这两个原生模块时。

### E10 · 草稿 Release 的建法
- 结论：electron-builder 的 GitHub 发布是「先查有没有同 tag 的草稿、没有再建」，不是原子的，两个矩阵 job 各自发布会建出两个草稿（两个第三方项目实发过）。`gh release create` 有 `--draft`、`--verify-tag`（tag 不在远端就中止），可以直接带文件。建 Release 要 `contents: write`；写了 `permissions` 后没列出的都是 none。electron-builder 取应用 package.json 的 version，tag 是 `v` 加版本。
- 一手来源：https://cli.github.com/manual/gh_release_create ；https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax ；electron-publish 26.18.0 的 `out/gitHubPublisher.js`（`getOrCreateRelease`）；https://github.com/sorenwacker/ordo/pull/75 ；https://www.electron.build/v26/docs/publish
- 核查：确认（核实文件 01 的 (11)、C53–C58）。
- 什么时候重核：改 release 工作流时。

### E11 · Playwright 启动 Electron 的两个默认
- 结论：`_electron.launch` 在 Linux 上默认给应用加 `--no-sandbox`，除非传 `chromiumSandbox: true`；传 `executablePath` 时不注入自己的 loader，改靠 `--inspect` 的输出连上，要求 `nodeCliInspect` 这个 fuse 开着（默认开，electron-builder 不配 `electronFuses` 就不动）。Playwright 对 Electron 的支持是实验性的。
- 一手来源：https://playwright.dev/docs/api/class-electron ；playwright-core 1.63.0 的 `lib/coreBundle.js`（`Electron.launch`）；https://www.electronjs.org/docs/latest/tutorial/fuses
- 核查：确认（核实文件 01 的 (10)）。
- 什么时候重核：升 Playwright 时。

### E12 · 打包版拒绝所有测试接缝
- 结论：`apps/desktop/src/main` 下读 `TENON_*` 的每一处都以 `app.isPackaged` 为开关，打包后全部关闭：内存钥匙串（`host/index.ts` 的 `useMemorySecrets`）、e2e 路由（`e2e-routes.ts` 的 `e2eRouteSeam`）、假沙箱（`host/sandbox-posture.ts` 的 `sandboxTestMode`）、`dev-env.ts` 的 `loadDevEnv` 等。所以安装包的冒烟只能走不依赖接缝的办法；现有 e2e 一次也没在打包状态下跑过。
- 一手来源：仓库上述文件；`apps/desktop/e2e/helpers/launch.ts`（`launchTenon`）。
- 核查：确认（核实文件 01 的 (12)；核实文件 04 的 C26、C27）。
- 什么时候重核：加新的测试接缝时。

### E13 · 仓库里与打包相关的现状
- 结论：四个 package.json 都是 0.0.0，都没有 productName、author、homepage、repository；`git tag -l` 为空。kernel `mcp/connection.ts` 的 `CLIENT_INFO` 版本写死 0.0.0；kernel 读不了 `process`，要由 desktop 经选项传入。NOTICE 要求打包版随每套字体附 OFL 1.1 全文，仓库里没有这份文件。`BrowserWindow` 没设图标，仓库里也没有应用图标；钥匙串服务名 `com.yiongspace.tenon`（`apps/desktop/src/main/host/secrets.ts` 的 `KEYCHAIN_SERVICE`）是仓库里唯一现成的应用标识。
- 一手来源：仓库上述文件，及 `NOTICE`、`apps/desktop/src/main/index.ts`（`createWindow`）。
- 核查：确认（核实文件 04 的 C5、C17、C18、C28、C31、C32）。
- 什么时候重核：开工前。

### E14 · macOS 的 Gatekeeper
- 结论：macOS 15 起不能再按住 Control 点「打开」绕过 Gatekeeper；现在是先试着打开一次被拦，再去「系统设置 → 隐私与安全性」点「仍要打开」并输入登录密码，这个按钮约一小时内有效。浏览器下载的文件带隔离属性，打开必经 Gatekeeper；curl 和脚本取的不带，所以 CI 冒烟测不到这一步。总参考 §13「签名与分发」那一格写的「首次打开需右键」已过时。
- 一手来源：https://developer.apple.com/news/?id=saqachfa ；https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unidentified-developer-mh40616/mac ；https://developer.apple.com/forums/thread/706442
- 核查：确认；实际对话框文字没在 macOS 15 / 26 上看过（核实文件 01 的 (4)）。
- 什么时候重核：P7 跑完时；macOS 大版本更新时。

### E15 · Electron 的应用名从哪来
- 结论：Electron 44.4.1 的类型说明写：应用名取应用 package.json 的 `name`，同时写了 `productName` 时优先用 `productName`。开发模式（electron-vite 起 `apps/desktop`）读的就是 `apps/desktop/package.json`，所以 productName 一写进去，开发模式的应用名、数据目录和单实例锁都会跟着变。打包版读包内的 package.json；只在 electron-builder 配置里写 productName 时，包内的 `app.name` 不变；要经 `extraMetadata.productName` 注入（P6 实测）。
- 一手来源：npm 包 electron@44.4.1 的 `electron.d.ts`（`App.getName` 的说明）；https://github.com/electron/electron/blob/v44.4.1/docs/api/app.md
- 核查：起草者 2026-11-28 读本机安装的 electron@44.4.1 类型说明，未经对抗核实；打包版那一半由 P6 实测确认。
- 什么时候重核：升 Electron 大版本时。

### E16 · electron-builder 默认的产物文件名带包名
- 结论：electron-builder 26.18.0 的 Linux 产物默认文件名以 `${name}` 开头，`apps/desktop` 的包名是 `@tenon-app/desktop`，带一个斜杠；fpm 于是要写进一个不存在的子目录，报 `Parent directory does not exist: …/@tenon-app`，deb 打不出来。修法是在配置里写 `linux.artifactName`，不带包名。
- 一手来源：探针第一、二轮的构建日志（run 46082661569、46084382965 的 Linux 构建步骤，另记）。
- 核查：两轮 CI 实测，两个 Ubuntu runner 都一样；改了 `artifactName` 之后第三、四轮都打出了 deb（P1）。
- 什么时候重核：升 electron-builder 或改包名时。

### E17 · Ubuntu 26.04 上，04 的 bwrap 修法不够
- 结论：Ubuntu 26.04 自带 `bwrap-userns-restrict`（定义了给 bwrap 的子 profile `unpriv_bwrap`）。只照 04 §启动、自检与姿态 第 6 步的修法再写一份给 bwrap 的 AppArmor 配置，内核里仍有 `unpriv_bwrap (enforce)`，内核日志记 `apparmor="DENIED" operation="capable" profile="unpriv_bwrap" comm="apply-seccomp" capname="sys_admin"`，沙箱仍是 `userns-restricted`。先用 `apparmor_parser -R` 卸掉系统自带的那份、再装那份配置，内核里只剩 `bwrap (unconfined)`，沙箱才生效。sysctl 设 0 也不行。
- 一手来源：探针第三、四轮（run 46087221328、46089532804）的 Ubuntu 26.04 job，P3 的 (a)–(d) 四种设置与内核日志（另记）。
- 核查：GitHub 的 26.04 镜像（内核 7.0.0-1020-azure）上两轮实测；用户机器上没测。
- 什么时候重核：改 04 的修法说明时；Ubuntu 更新 `bwrap-userns-restrict` 时。

## 探针

都在 CI 的草稿 PR 里跑，不在 owner 的 Mac 上起 Electron（owner 已同意开草稿 PR，D14）。草稿 PR 只放探针用的 workflow 与脚本，不合并。P7 是 owner 在自己的 Mac 上手动做。探针已全部跑完（四轮 CI：run 46082661569、46084382965、46087221328、46089532804；记录在 `../tenon-notes/2026-11-28-packaging-and-logs/research/05-probe-results.md`，另记）；那时错误日志那份还没做，探针看的是 stderr 与应用内自检，日志那份做完后冒烟改读日志文件。

### P1 · 两个平台在 CI 上打出包，用系统方式启动
- 做什么：装上 electron-builder 26.18.0 后 `pnpm install --frozen-lockfile`（`strictDepBuilds` 不动）；在 `macos-15` 打 zip、在 `ubuntu-24.04` 打 deb。macOS：`ditto` 解压后 `open -n -a <Tenon.app> --stdout <文件> --stderr <文件>`；Linux：`apt-get install ./<deb>` 后按桌面入口里的 Exec 在 `xvfb-run` 下启动（不带 `--no-sandbox`），输出重定向到文件。都用默认的数据目录（runner 用完即弃）。60 秒内看输出，再发 SIGTERM，看退出。顺带看：两个原生模块能不能加载（Tape 打开成功）、首次启动读钥匙串会不会卡住、输出里有没有报错；对渲染进程发一次 `SIGSEGV` 后数据目录里有没有 `.dmp`（安装版也照错误日志那份「不留转储」）。
- 结果是 X 就改什么：包起不来或缺模块，先查依赖收集（`workspace:`、`catalog:`），改打包配置，spec 不动；要改依赖分类以外的东西，回来改 §安装包怎么打。`strictDepBuilds` 报错，只往 `pnpm-workspace.yaml` 的 `ignoredBuiltDependencies` 追加。有报错，逐条看：属于 runner 环境的（比如钥匙串）写进已知限制，验收 2、4 的「没有错误级的行」改成一张排除清单。macOS 上读钥匙串卡住，冒烟前给 runner 建一个临时钥匙串并设为默认（不碰真实条目），写进 §安装包怎么打。安装版里见到 `.dmp`，报给错误日志那份，按它的 P1 处理。
- 实际结果：包能起来，打包配置只多两处（`linux.artifactName`、`extraMetadata.productName`）。2026-11-28 四轮 CI：三个 runner 上 `pnpm install --frozen-lockfile` 都过，`strictDepBuilds` 只报 `electron-winstaller@5.4.0`（Windows 安装器，用不上），已追加进 `ignoredBuiltDependencies`。macOS（第二至四轮）：zip（161 MB）`ditto` 解开后 `codesign --verify` 过，`open -n -a` 启动正常，30 秒后进程还在，SIGTERM 后 1 秒退出，两个原生模块能用，沙箱姿态 `active`；dmg（169 MB）也打得出、挂得上、能启动。
- 实际结果（续）：Linux（第三、四轮，改了 `artifactName` 之后）：24.04 上打出 127 MB 的 deb，`apt-get install` 退出 0，默认的依赖都满足、没有缺的共享库；装到 `/opt/Tenon`，`chrome-sandbox` 是 755（不是 SUID），`/etc/apparmor.d/tenon` 装上并加载；桌面入口 `Exec=/opt/Tenon/tenon %U`，不带 `--no-sandbox`；不带它启动，30 秒后还在，SIGTERM 后 1 秒退出，渲染进程 `Seccomp: 2`、`NoNewPrivs: 1`、有自己的 user namespace，即 Chromium 沙箱开着；数据目录是 `~/.config/Tenon`。26.04 同样。安装版的转储：三个平台的数据目录里都没有 `.dmp`、没有 `Crashpad` 目录；系统另写了 macOS 的 `.ips`、Ubuntu 的 systemd-coredump 与 apport 的 `/var/crash/*.crash`。
- 实际结果（续）：stderr 里的报错逐条看了，都属 runner 环境：macOS 第三轮的 `XPC error for connection com.apple.backupd.sandbox.xpc`（开发构建里也有，第二轮没出现），Linux 的 DBus 报错（runner 的会话总线地址解析不了）。它们是 Chromium 自己打到 stderr 的，不进 Tenon 的日志，所以验收 2、4 的「日志里没有错误级的行」照写，只注明这两类不算。Linux 上那一步还没装 bwrap 等依赖时，沙箱是 `unavailable (missing-*)`；我们的 deb 把它们写进依赖。
- 效力说明：keyring 只测了加载与构造，没有读写，「首次启动读钥匙串会不会卡住」没测，也不该在 CI 上测；只在 GitHub 的镜像上跑过。

### P2 · macOS 包里 helper 的真实位置
- 做什么：对 P1 的 Tenon.app：`test -x` 与 `file` 查 `Contents/Resources/sandbox/seccomp/arm64/apply-seccomp`，查 jar 在；列 app.asar 的内容，看有没有 `sandbox-runtime/vendor`；`codesign --verify --deep --strict` 看夹带的 Linux ELF 会不会让签名报错。运行时交给沙箱的路径，在错误日志那份做完后由验收 3 的冒烟读日志再查。
- 结果是 X 就改什么：路径落进 asar 或丢了执行位，改 `extraResources` 的配置。签名因为夹带的 ELF 报错，停下出一张卡给 owner：要不要改 04 的启动检查，让 macOS 上不再要求 apply-seccomp（那是改 implemented 的机制）。
- 实际结果：2026-11-28 第二轮起：`Contents/Resources/sandbox/seccomp/arm64/apply-seccomp` 是 `-rwxr-xr-x` 的 aarch64 ELF，jar 在 `…/java-proxy-agent/`；`codesign --verify --deep --strict` 通过，夹带的 ELF 不让签名报错；应用内自检拿到的两条路径都不含 `.asar`。Linux 包里 `/opt/Tenon/resources/sandbox/seccomp/x64/apply-seccomp` 也是 755。对照：没打补丁的 asar 内路径，`existsSync` 与可执行检查都说「在、可执行」，`spawn` 报 `ENOTDIR`，印证 E1（启动检查不能只看文件在不在）。asar 里和 `app.asar.unpacked` 里还各有一份 sandbox-runtime 的 vendor（冗余），实现时照 §安装包怎么打 排除。走「不用改 `extraResources`、不出卡」那一支。

### P3 · deb 在 Ubuntu 24.04 上装、Chromium 沙箱与 Tenon 沙箱
- 做什么：在 `ubuntu-24.04` 上 `apt-get install ./<deb>`，看退出码与装上的 AppArmor profile；不带 `--no-sandbox` 启动，看 Chromium 沙箱能不能起来；在三种设置下看沙箱状态：(a) 什么都不改；(b) 照 04 的修法装 bwrap 的 AppArmor 配置；(c) sysctl 设 0。另在 `ubuntu-26.04` 上跑 (a)、(b)。
- 结果是 X 就改什么：(a) 就是「生效」，冒烟用 (a)，发布说明写「24.04 装好即生效」；(a) 是 `userns-restricted`、(b) 生效，冒烟用 (b)，发布说明照 04 的修法写；Chromium 沙箱起不来，停下出卡给 owner，不靠 `--no-sandbox` 绕过。26.04 的结果原样写进发布说明的已知限制。
- 实际结果：24.04 走「(a) 就是生效」那一支；26.04 写进已知限制。2026-11-28 第三、四轮。24.04：(a) 不改、(b) 装 bwrap 的 AppArmor 配置、(c) sysctl 设 0，三种完全一样：Tenon 沙箱 `active`，`echo ok` 通过，工作区内写通过，工作区外写被拒（`Read-only file system`，记了违规，文件没建出来）；Chromium 沙箱开着。runner 的 sysctl 默认是 1，镜像本来没有 bwrap、socat、rg，装上之后直接生效。
- 实际结果（续）：26.04：(a)(b)(c) 都是 `unavailable`、原因 `userns-restricted`（apply-seccomp 的嵌套命名空间被限），Chromium 沙箱开着；第四轮的 (d) 先卸掉系统自带的 `bwrap-userns-restrict` 再装我们的配置，沙箱才 `active`（E17）。
- 效力说明：24.04「装好即生效」很可能是 deb 自带的 `/etc/apparmor.d/tenon`（给 `/opt/Tenon/tenon` 开 `userns`）连带放行了沙箱起的 bwrap，是推测；只在 GitHub 的 24.04 镜像（内核 7.0）上见过，04 在 Lima（内核 6.8、开发构建、没有这份配置）上 sysctl 为 1 时是 `userns-restricted`。所以发布说明写「在 GitHub 的镜像上直接生效，别处看设置里的沙箱状态」，不写「24.04 上一定行」。

### P4 · 两次打包之间 ad-hoc 身份稳不稳
- 做什么：同一份源码打三次：原样、只改版本号、只改 app.asar 里一个字节；各取 `codesign -dvvv` 的 CDHash，再和开发用 Electron 的 cdhash 比。
- 结果是 X 就改什么：每次都变，发布说明写「每装一个新版本，钥匙串会对每把 key 再问一次」，D9 的代价照此写实；不变，只写「开发版存过的 key，安装版第一次读会问一次」。
- 实际结果：走「每次都变」那一支。2026-11-28 第二轮起：同一份源码、同一份配置打两次，CDHash 相同；改版本号、加 productName、开 hardened runtime，CDHash 都变；app.asar 改一个字节后签名校验报「sealed resource」被改，重签后 CDHash 也变；第四轮因为配置多了 `extraMetadata`，CDHash 又和第二轮不同。designated requirement 抓到了：ad-hoc 签名的是 `cdhash H"<该包的 cdhash>"`，开发用 Electron 的是另一个 cdhash。所以每装一个新版本，钥匙串都会对每把 key 再问一次，已写进发布说明与已知限制。
- 效力说明：一个「只重签外层」的对照与 electron-builder 的签名参数不同，不算「未改」的对照；能用的比较是同样重签、只差一个字节的那两份。

### P5 · ad-hoc 加 hardened runtime 能不能用
- 做什么：P1 的 macOS 包另打一份 `hardenedRuntime: true`，启动看：两个 `.node` 能不能加载、`sandbox-exec` 能不能起、沙箱状态是不是「生效」。
- 结果是 X 就改什么：三样都过，开 hardened runtime；任一不过，关掉，§安装包怎么打 照写「关」。
- 实际结果：走「三样都过，开 hardened runtime」那一支。2026-11-28 第二、三轮：`flags=0x10002(adhoc,runtime)`，entitlements 是默认的三项（`allow-jit`、`allow-unsigned-executable-memory`、`disable-library-validation`）；两种启动方式都起来了，两个 `.node` 都能加载，沙箱姿态 `active`；第三轮补上了沙箱里的三条命令：zip、dmg、hardened 与开发构建下，`echo ok` 通过、工作区内写通过、工作区外写被拒（`Operation not permitted`，记了违规，文件没建出来）。

### P6 · productName 写在打包配置里，开发模式的应用名变不变
- 做什么：开发模式：`electron-vite build` 后在 `apps/desktop` 起一次 Electron，读 `app.getName()` 与 userData 路径；打包版：读 Info.plist 的 CFBundleName，并看启动后建出来的是不是系统应用数据目录下的 `Tenon`。
- 结果是 X 就改什么：开发模式仍是 `@tenon-app/desktop`、安装版是 `Tenon`，照现稿；安装版不是 `Tenon`，查 `extraMetadata` 的注入有没有生效；开发模式变了，说明 productName 漏进了源码的 package.json，修掉。
- 实际结果：走「经 `extraMetadata` 注入」那一支，现稿已这样写。2026-11-28 第二至四轮：开发模式的 `app.name` 仍是 `@tenon-app/desktop`（数据目录 `~/Library/Application Support/@tenon-app/desktop`，Linux `~/.config/@tenon-app/desktop`）。打包版只在配置里写 productName 时，`app.name` 还是 `@tenon-app/desktop`；加上 `extraMetadata.productName` 后是 `Tenon`，数据目录 macOS `~/Library/Application Support/Tenon`、Linux `~/.config/Tenon`。

### P7 · （人工）owner 的 Mac：Gatekeeper 与钥匙串弹框
- 做什么：P1 出包后，owner 用浏览器下载 zip（探针 PR 的 CI 产物，或之后的草稿 Release），记下 Gatekeeper 的框写了什么、经「仍要打开」能不能打开；在开发版里存过 key 的前提下打开安装版，看弹几次框、框上写谁；再装一个新打的包，看还弹不弹。
- 结果是 X 就改什么：出现「已损坏」，发布说明加去掉隔离属性的步骤，并出卡问 owner 要不要提前做签名；弹框次数与 P4 对不上，以真机为准改发布说明与 D9 的代价。
- 实际结果：未跑。要 owner 在自己的 Mac 上做，批 ready 之前做完（见 plan「当前 / 需要你」）。
