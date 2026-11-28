# packaging · plan

## 当前 / 需要你

当前：spec 是 draft，12 张卡都已定。CI 上能跑的探针（P1–P6，四轮）都跑完了，结果已写进 evidence 并照各自的分支改了 spec；只剩标了人工的 P7。代码没动。
需要你：现在不用批。P7 要你在自己的 Mac 上做，按「探针在批 ready 之前跑完」的规矩排在批 ready 之前：趁探针的 CI 产物还在（保留 14 天，约到 2026-12-12），用浏览器下载第二轮与第四轮的 zip（两份 CDHash 不同），先装一份存过 key 再装另一份，记下弹框的样子；产物过期了，就等 release 工作流在草稿 PR 上出包再做。冒烟要读错误日志那份写出的日志，所以等 error-logs implemented 后再请 owner 批 ready；到时请回一句「packaging 改 ready」。

## 分段

| 段 | 状态 | 这一段做完你能看到什么 | 守哪些验收 | 等 owner 做什么 |
|---|---|---|---|---|
| 一 · 安装包与草稿发布 | 未开工，等 error-logs implemented | 推 tag 后发布页面有一个草稿，附 Mac、Linux 两个包；装上能开，沙箱生效，数据和开发版分开 | 1–11 | P7 在自己的 Mac 上试开；批 ready；点名合并改 workflow 的 PR；推 `v0.1.0`；段末走查 |

## 步骤

- [ ] 1. 改 ready 之前
  - [ ] 1.1 lead 把四个文件放进仓库的那个 PR 里：总参考阶段表加一行（目录 `docs/features/packaging`，一句话「安装包与草稿发布，从阶段 7 提前的部分」，状态 draft，关键决策「草稿 Release、ad-hoc 签名、只发 zip 与 deb（D2、D6）」）；跑 `python3 .sdd/spec-check.py` 与 `python3 .sdd/spec-check.py --index`。总参考有行数上限 1200，现在 1161 行。
  - [ ] 1.2 挑刺评审（heavy）：新上下文，至少「规则与证据」「机制与安全」「测试」三个视角，只给代码与文档、不给起草者的结论；带证据的发现修进 spec，结论与处置记进 log.md。
  - [x] 1.3 探针 P1–P6（四轮 CI 跑完，2026-11-28；结论在 evidence.md）：在 CI 草稿 PR 里跑（owner 已同意，D14；草稿 PR 只放探针用的 workflow 与脚本，不合并、不开自动合并；不在 owner 的 Mac 上起 Electron）。不必等 error-logs：先看 stderr 与静态检查。原始输出进私有笔记，结论写进 evidence.md 的「实际结果」，按「结果是 X 就改什么」改 spec 与开放问题。
  - [ ] 1.4 P7（人工）：owner 在自己的 Mac 上做（做法见「需要你」），批 ready 之前做完，结果写进 evidence.md 与发布说明。
  - [ ] 1.5 等 error-logs implemented；对照它最后的 §接口「日志行」与验收 17，核一遍本 spec 冒烟要读的那几种事件还在不在、名字对不对，SIGTERM 的时机对不对。
  - [ ] 1.6 再跑 spec-check；请 owner 批 ready。
- [ ] 2. 段一 · 安装包与草稿发布（守验收 1–11）
  - [ ] 2.1 打包配置：electron-builder 26.18.0 精确钉版；`apps/desktop/electron-builder.yml`；依赖分类调整；`apps/desktop/package.json` 改 0.1.0，加 `repository` 与作者（D12）；`licenses/OFL-1.1.txt`。`pnpm-workspace.yaml` 只在需要时往 `ignoredBuiltDependencies` 追加（它在 architecture_paths 里，按架构改动评审）。验收 5、6、7 的单元部分。
  - [ ] 2.2 §对 04 的增补：`helperPaths` 加 `resourcesPath` 分支，打包版传 `process.resourcesPath`。§对 03 的增补：`McpPoolOptions.clientVersion`，desktop 传 `app.getVersion()`。验收 3、7。
  - [ ] 2.3 冒烟用例 `apps/desktop/test/package-smoke/`（没设 `PACKAGE_SMOKE_DIR` 时整组跳过）与版本比对脚本的测试；用例里断言不设 `TENON_` 变量、不传 `--no-sandbox`。验收 1–6、11。要改 vitest 配置的话，那也是门禁文件，同 2.4。
  - [ ] 2.4 `.github/workflows/release.yml` 与发布说明模板 `apps/desktop/packaging/release-notes.md`；Linux job 的沙箱设置照 P3 的结果写死。这一步的 PR 改门禁文件：评审通过也不开自动合并，等 owner 点名合并；推送成批，免得互相取消 e2e。
  - [ ] 2.5 文档同步：overview 技术栈表加 electron-builder 一行；`SECURITY.md` 的已知限制加 26.04、keyutils 与未签名；总参考 §13「签名与分发」那一格的「首次打开需右键」改成「系统设置 → 隐私与安全性 → 仍要打开」。
  - [ ] 2.6 「以后再说」登记下面这些，每条一行：
    - macOS 签名与公证（要 Apple 开发者账号） · owner · 决定给别人用时，阶段 7 · packaging §给你看的一页「不做」
    - 自动更新 · lead · 签名之后（macOS 上依赖签名） · packaging §给你看的一页「不做」
    - Windows 安装包 · lead · 上游沙箱在 Windows 上稳定之后，与阶段 7 的 Windows 签名一起 · packaging D3
    - AppImage 等其他 Linux 格式、macOS Intel 包 · lead · 有人要时；AppImage 先解决桌面入口带 `--no-sandbox` · packaging D3、D6
    - 升级 sandbox-runtime 0.0.79 到 0.0.83（0.0.80 起 Linux 沙箱里不能再建命名空间，随包的 helper 每版都变） · lead · 另走依赖升级，照 04 重跑验收 10–16 · packaging §给你看的一页「不做」
    - 包里补第三方依赖的许可证汇总 · lead · 挡上线：草稿发给别人之前 · packaging §已知限制与代价
    - Linux 没有 Secret Service 时 key 存进内核钥匙环、重启即失、不提示 · lead · 给别人发 Linux 包之前 · packaging E4
    - CHANGELOG 由提交生成（总参考「版本」那一格的 release-please 或 changesets） · lead · 有外部用户之后 · packaging 决策卡「agent 自定」
    - Electron fuses 加固（关 runAsNode、开 asar 完整性校验） · lead · 和签名公证一起 · packaging §安装包怎么打
    - Ubuntu 26.04 上 04 的「写一份 bwrap 的 AppArmor 配置」不够，要先卸掉系统自带的 `bwrap-userns-restrict`（另写 spec 改 04 的修法说明，或在应用里提示） · lead · 有人在 26.04 上用 Tenon 之前 · packaging E17
  - [ ] 2.7 段一收尾：`pnpm format:check && pnpm lint && pnpm typecheck`、`pnpm vitest run --maxWorkers=2`、`python3 .sdd/spec-check.py`；新上下文独立评审，带证据的问题按细则分类处置，记进 log.md。
  - [ ] 2.8 owner 推 `v0.1.0` tag；CI 出草稿 Release，冒烟在两个平台上都过。
  - [ ] 2.9 带 owner 按场景逐条走查（草稿 Release 页面、在自己的 Mac 上下载打开、安装版与开发版的数据和钥匙串），每条明确回答对或不对，记进 log.md。
- [ ] 3. 对照验收逐条核对；spec 的开放问题与本 plan 的 Open 要么写明已定，要么挪进「以后再说」；数验收条数与改动行数（本项目补充第 6 条「预算检查点」）。
- [ ] 4. 清理：探针用的草稿 PR 关掉，探针 workflow 不留在仓库里。
- [ ] 5. owner 验收 → 改 Status

## 交接

2026-11-28：探针四轮全部跑完（只剩人工的 P7），结果写进 evidence.md，照分支改了 spec：Linux 冒烟不改系统设置、发布说明写 24.04 与 26.04 的实情、验收 2、4 去掉「依次」并注明 Chromium 自己的 stderr 不算；26.04 的新事实记成 E17，plan 2.6 加了登记「以后再说」的一行。没写代码，没提交。下一步：owner 做 P7；error-logs implemented 后请 owner 批 ready。

## Open

- P7 待 owner（spec 开放问题 1）。
- 冒烟进不进 `ci-ok`（spec 开放问题 2）：owner 定，合并后至少跑过两次 tag 再定。
- 总参考行数余量：上限 1200，现在 1161；1.1 与 2.6 要加约 11 行，够用，之后的 spec 余量更小。

## 验收矩阵

每行一条验收，说明这条验收最低要在哪一层测、由哪个门禁拦、被哪个突变盯着。门禁是必须通过的检查，用 `.sdd/config.json` 的 gates 里的通用名写，比如 test、test:e2e。突变是故意改坏一处生产代码、看测试会不会变红；这一列写 log.md 里评审登记的突变编号，评审还没出时先空着，写 `—`。层从下到上是：单元、集成、e2e、live。「平台」一列照本项目补充第 4 条；冒烟用例平时的 CI 里跳过，在 release 工作流里带包路径跑。

| 验收号 | 层 | 测试用例名 | 门禁命令 | 突变 | 平台 |
|---|---|---|---|---|---|
| 1 | 单元 | packaging 验收 1: a tag that differs from the desktop version fails before packaging | test | — | 任意 |
| 2 | e2e | packaging 验收 2: the macOS zip opens with open -a, logs start, window and an active sandbox, then quits cleanly | test | — | macOS |
| 3 | e2e | packaging 验收 3: the macOS helpers are real executables under Resources and never inside the asar | test | — | macOS |
| 4 | e2e | packaging 验收 4: the deb installs in one go and starts with the Chromium sandbox on and an active sandbox | test | — | Linux |
| 5 | 单元 | packaging 验收 5: the desktop package.json keeps its name without productName; the packaged userData ends in Tenon | test | — | macOS、Linux |
| 6 | e2e | packaging 验收 6: both packages carry LICENSE, NOTICE and the OFL 1.1 text | test | — | macOS、Linux |
| 7 | 单元 | packaging 验收 7: log lines and the MCP client info carry the app version | test | — | 任意 |
| 8 | 你用 | （人工） | — | — | — |
| 9 | 你用 | （人工） | — | — | macOS |
| 10 | 你用 | （人工） | — | — | macOS |
| 11 | e2e | packaging 验收 11: the packaged log has no unreplaced home or app path after the smoke run | test | — | macOS、Linux |
