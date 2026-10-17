# macOS 版平台耦合清单与适配层（Platform Matrix）

> 归属：macOS 版（交接文档 `handoff-2026-10-17.md` §7）
> 版本：v1 · 2026-10-17 · 对应提交：本轮 macOS 适配改造
> 适用对象：后续接手 macOS / Windows 任一端的人或模型
> 一句话：**Electron 让 90% 代码天然跨平台，剩下的 10% 差异被强制收口到两个适配层文件里**，
> 不许再散落 `if (process.platform)` 或 `if (e.ctrlKey)`。

---

## 1. 适配层落点（先看这张表，再读代码）

| 层 | 文件 | 职责 | 平台判定来源 |
|---|---|---|---|
| 主进程平台判定 | `apps/desktop/src/main/platform/index.ts` | `isMac` / `isWindows` / `isLinux` / `platformDisplayName()` / `platformDetail()` | **唯一**出现 `process.platform` 的地方 |
| Office→PDF 门面 | `apps/desktop/src/main/platform/officeConvert.ts` | 按平台分发 + `isOfficePdfAvailable()` | 引用 `platform/index.ts` |
| Office→PDF（Win） | `apps/desktop/src/main/platform/officeConvertWin.ts` | PowerShell + WPS/Office **COM** | 由门面调用，自身不判平台 |
| Office→PDF（mac） | `apps/desktop/src/main/platform/officeConvertMac.ts` | **LibreOffice headless**（`soffice --convert-to pdf`） | 同上 |
| 路径推导（共用） | `apps/desktop/src/main/platform/common.ts` | `withPdfExtension` / `resolveOutputPath` | 无平台分支（两端必须一致） |
| macOS 应用菜单 | `apps/desktop/src/main/platform/appMenu.ts` | 标准 role 菜单（⌘C/⌘V/⌘Q 的载体） | 只在 `isMac` 时被调用 |
| 渲染层快捷键 | `apps/desktop/src/renderer/src/lib/platform.ts` | `hasPrimaryModifier` / `accelLabel`（⌘ vs Ctrl） | preload 透出 `window.jareking.platform` |
| 外部文件打开消费 | `apps/desktop/src/renderer/src/lib/pendingFiles.ts` | `doc:pending:take` → `setPendingOpen` + `openTab` | 无平台分支（两端共用） |

**铁律**：新增平台差异能力时，**先在这张表里加一行**，再写实现。禁止在业务组件里直接判平台。

---

## 2. 耦合点全量清单

图例：✅ 已处理 ｜ 🟡 已处理但有已知限制 ｜ ⏳ 留待后续（有明确触发条件）

| # | 耦合点 | Windows 现状 | macOS 现实 | 处置 | 状态 |
|---|---|---|---|---|---|
| 1 | **Office→PDF 引擎** | PowerShell + WPS/Office COM | **无 COM**；Office for Mac 只支持 AppleScript | 抽象为门面；mac 用 LibreOffice headless（检测 `/Applications/LibreOffice.app`、`/opt/homebrew/bin`、`/usr/local/bin`、`$PATH`）；未安装 → 明确中文错误并建议走「导出 PDF」 | ✅ |
| 2 | **打包 target** | `win: nsis x64` | 需 `dmg` + `zip`，且 arm64 单独出包 | `electron-builder.yml` 加 `mac`（dmg+zip × x64/arm64）；zip 是 electron-updater 必需（Squirrel.Mac 只吃 zip） | ✅ |
| 3 | **代码签名** | NSIS 无强制签名 | **不签名 = Gatekeeper 拦截**；公证需 Apple Developer($99/年) | 配置不写死 `identity`（有证书自动发现，无证书自动跳过）；entitlements 已备；正式分发步骤见 `docs/macos-release.md` | 🟡 |
| 4 | **应用菜单** | `autoHideMenuBar` + 默认菜单，功能全在 Ribbon | **全局菜单栏模型**：⌘C/⌘V/⌘Z/⌘A/⌘Q 的 accelerator 由菜单 role 承载，缺菜单即全应用复制粘贴失效 | `appMenu.ts` 仅 mac 安装标准 role 菜单（App/编辑/视图/窗口）；业务入口仍在 Ribbon，避免与 ⌘F/⌘H/⌘1/⌘F1/⌘⇧P 冲突 | ✅ |
| 5 | **双击关联文件** | 新进程启动 → `second-instance` 从 **argv** 取 | LaunchServices 派发 **`open-file`** 给已有进程，**不新起进程**，且可能早于 `ready` | 模块顶层注册 `open-file`（`preventDefault()` + 入队）；两平台入队后统一由 IPC `doc:pending:take`（取走即清空）交给渲染层 | ✅ |
| 6 | **argv 噪声** | 开关参数 | 额外有 `-psn_0_12345`（进程序列号） | `filterOpenableFiles`：挡 `-` 开头、execPath 自身、非受支持扩展名、磁盘不存在 | ✅ |
| 7 | **快捷键主修饰键** | `Ctrl` | `Command (⌘)` | 5 处 `e.ctrlKey` 硬编码 → `hasPrimaryModifier`；UI 文案 `Ctrl+F` → `accelLabel('F')` | ✅ |
| 8 | **userData 路径** | `%APPDATA%/jareking` | `~/Library/Application Support/jareking` | Electron `app.getPath('userData')` 天然跨平台；`app.setName('jareking')` 已保证目录名一致 | ✅ |
| 9 | **大小写敏感文件系统** | NTFS 默认不敏感 | APFS 默认**不敏感**，但**可格式化为敏感** | 现有文件名比较/去重逻辑按「不敏感」假设安全（两端默认一致）；若用户把卷格式化为 APFS Case-sensitive，行为不变 | ✅（无需改动） |
| 10 | **在 Finder 中定位** | `shell.showItemInFolder` | 同 API 可用（Finder 高亮） | 无需改动 | ✅ |
| 11 | **打印管线（导出 PDF）** | `webContents.printToPDF` + `preferCSSPageSize` | 同 API 可用 | 无需改动；**但字体集不同** → 需视觉验收（见 §4） | 🟡 |
| 12 | **自动更新** | NSIS + electron-updater | Squirrel.Mac **要求已签名**，否则报 code signature 错误 | 不加「mac 一律跳过」硬开关（签名后还得改代码）；错误由 `autoUpdater.on('error')` 兜住不弹框；正式生效需签名+公证 | 🟡 |
| 13 | **SQLite（sql.js WASM）** | 纯 WASM，跨平台 | 同 | 无需改动；entitlements 里留了 `allow-unsigned-executable-memory`（WASM 依赖） | ✅ |
| 14 | **宏 Worker 沙箱** | Web Worker | 同 | 无需改动 | ✅ |
| 15 | **原生弹窗** | 已全量禁 `window.prompt/alert` | 同（且 mac 的 sheet 式对话框更易阻塞） | 沿用项目 `Modal`；本轮无新增原生弹窗 | ✅ |
| 16 | **窗口关闭语义** | 关窗即退出 | 关窗不退出（Dock 留存），点 Dock 重建窗口 | `window-all-closed` + `activate` 已按 `isMac` 分支 | ✅ |
| 17 | **macOS「文件」菜单** | Ribbon「文件」标签 | 用户预期菜单栏有「文件 → 打开/保存/导出」 | 需要主进程→渲染层**命令通道**（现架构只有 invoke 单向），故**不做空壳菜单项**（避免点了没反应） | ⏳ Phase 8 |
| 18 | **托盘 / Dock 菜单** | 未实现 | 未实现 | v1 未纳入 | ⏳ |
| 19 | **Office for Mac AppleScript 兜底** | — | 可为未装 LibreOffice 的用户兜底 | 需真机验证 AppleScript 语法与授权流程，**不写未验证的脚本** | ⏳ 需求触发时 |
| 20 | **图标资源** | `resources/` 仅有 README | 需 `.icns`（1024×1024） | 当前用 Electron 默认图标（可构建，观感不佳）；素材须自有并登记 `docs/assets-provenance.md`（铁律 1.10） | ⏳ |

---

## 3. 为什么 Office→PDF 选 LibreOffice 而不是 AppleScript

| 方案 | 可行性 | 可自动化验收 | 依赖 | 结论 |
|---|---|---|---|---|
| **LibreOffice headless** | doc/docx/xls/xlsx/ppt/pptx 全覆盖 | ✅ CLI 退出码 + 产物存在即可断言 | 用户需装 LibreOffice（免费） | **采用** |
| AppleScript 驱动 Office for Mac | 需用户已装 Microsoft Office（付费）且有授权 | ❌ 受首次启动向导/授权弹窗阻断，无头环境无法跑 | 付费 Office + 辅助功能授权 | ⏳ 兜底候选 |
| macOS 原生 `qlmanage`/Print to PDF | 只有缩略级保真，丢版式 | ✅ | 无 | ❌ 保真不足 |
| 隐藏该入口只留「导出 PDF」 | 0 成本 | ✅ | 无 | 作为**降级路径**提示用户 |

关键实现细节（`officeConvertMac.ts` 内已注释，此处摘要）：
- 必须 `-env:UserInstallation=file://<临时目录>`，否则用户开着 LibreOffice GUI 时 headless 实例会连同一 profile **静默不产出**；
- `--convert-to pdf` **无法指定任意目标文件名**（固定为「输入主名.pdf」）→ 先转临时目录再 `rename` 到目标（跨卷 EXDEV 走 copy+unlink）；
- `--headless --norestore --invisible --nolockcheck` 四件套缺一不可；
- 120s 超时 + 临时目录整包清理（失败不覆盖原始错误）。

---

## 4. 必须真机验收的项（Windows 上无法替代）

| # | 验收项 | 判定标准 | 工具 |
|---|---|---|---|
| 1 | 启动与首屏 | App 能起来、Ribbon 正常、无白屏 | 人工 + `jk-debug` 钩子 |
| 2 | 打开 / 编辑 / 保存 docx·xlsx·pptx | 往返后 WPS for Mac 或 Pages/Numbers/Keynote 能打开 | 人工 + `scripts/verify-*-roundtrip.mjs`（本机跑） |
| 3 | 导出 PDF（三模块 + 打印设置） | `%PDF-` 头正常，A4 纵向 MediaBox `594.96×841.92` | `scripts/pdf-export-smoke.mjs` |
| 4 | **字体视觉差异** | mac 无「宋体/黑体」等同名字体 → 导出 PDF 与 Windows 比对字形/换行是否可接受 | 人工对照 |
| 5 | PDF 阅读器 | pdfjs 渲染 + 文本层可选中 | `scripts/pdf-reader-smoke.mjs` |
| 6 | 双击 .docx/.xlsx/.pptx/.pdf | 冷启动（App 未运行）+ 热启动（App 已运行）**都要**打开到对应模块 | 人工 |
| 7 | ⌘C/⌘V/⌘Z/⌘A/⌘Q | 文本框内与编辑器内均生效 | 人工 |
| 8 | ⌘⇧P / ⌘F / ⌘H / ⌘1 / ⌘F1 / ⌘Enter | 与 Windows 的 Ctrl 版本行为一致 | 人工 |
| 9 | Office→PDF（装了 LibreOffice） | Word/Excel/PPT 三类型各转一次成功 | 人工 |
| 10 | Office→PDF（未装 LibreOffice） | 弹出可读中文提示，**不崩、不假装成功** | 人工 |
| 11 | 关窗不退出 + 点 Dock 重建窗口 | 符合 mac 习惯 | 人工 |
| 12 | 深色模式 / 动态字体 / 中文输入法（软键盘候选条） | 无错位、无丢字 | 人工 |

---

## 5. 本轮改动文件清单

**新增**
- `apps/desktop/src/main/platform/index.ts`
- `apps/desktop/src/main/platform/common.ts`（+ `common.test.ts`）
- `apps/desktop/src/main/platform/officeConvert.ts`（门面）
- `apps/desktop/src/main/platform/officeConvertWin.ts`（由旧 `services/officeConvert.ts` 迁入并改为 Win 专用实现）
- `apps/desktop/src/main/platform/officeConvertMac.ts`
- `apps/desktop/src/main/platform/appMenu.ts`
- `apps/desktop/src/renderer/src/lib/platform.ts`（+ `platform.test.ts`）
- `apps/desktop/src/renderer/src/lib/pendingFiles.ts`（+ `pendingFiles.test.ts`）
- `apps/desktop/resources/entitlements.mac.plist`
- `.github/workflows/macos-build.yml`
- `scripts/package-mac.sh`
- `docs/macos-platform-matrix.md`（本文）、`docs/macos-release.md`

**删除**
- `apps/desktop/src/main/services/officeConvert.ts`（内容迁入 `platform/officeConvertWin.ts`，避免双份实现）

**修改**
- `apps/desktop/src/main/index.ts`：门面导入、`open-file`、`filterOpenableFiles`、`doc:pending:take`、mac 菜单安装、`window-all-closed` 平台分支、`system:storageInfo` 追加 `platformDetail` + `officePdfAvailable`
- `apps/desktop/src/main/updater.ts`：补 macOS 签名前提说明（不改行为）
- `apps/desktop/src/ipc/channels.ts`：新增 `DOC_PENDING_TAKE: 'doc:pending:take'`
- `apps/desktop/src/preload/index.ts` / `index.d.ts`：`JarekingApi.platform`
- `apps/desktop/electron-builder.yml`：新增 `mac` / `dmg` 段
- `apps/desktop/package.json` / `package.json`：`package:mac[:x64|:arm64]`
- `apps/desktop/vitest.config.ts`：include 增加 `src/main/**/*.test.ts`
- 渲染层快捷键：`CommandPalette.tsx` / `WriterEditor.tsx` / `SheetEditor.tsx` / `Ribbon.tsx` / `EditorArea.tsx` / `FindReplaceBar.tsx` / `App.tsx`
- `docs/spec.md`：平台章节 v1.2（Windows + macOS）

---

## 6. 遗留风险（如实列出，不美化）

1. **Windows 机器产出不了 macOS 包**：本轮在 Windows 上完成了「代码级适配 + 配置 + 测试（277 绿）+ Windows 构建」，但 dmg 必须在 macOS 或 GitHub Actions `macos-14` 上产出。当前仓库已提交工作流，**需要推到 GitHub 并触发一次**才能拿到第一个 dmg。
2. **未签名包打开有摩擦**：Gatekeeper 会拦，需右键→打开或 `xattr -dr com.apple.quarantine`。要彻底解决只有 Apple Developer($99/年) 一条路。
3. **LibreOffice 依赖是产品决策点**：这是「Office→PDF」卖点在 mac 上的最大体验落差。若用户不接受「另装一个软件」，备选是先隐藏该入口（`isOfficePdfAvailable()` 已备好），只留三模块「导出 PDF」。
4. **字体差异无法用代码消除**：mac 没有宋体/黑体同名文件，导出 PDF 的字形与换行必然与 Windows 有差异，只能靠视觉验收定标准（建议：Writer 用「思源宋体/思源黑体」等 OFL 字体做跨端一致方案，见 `docs/fonts.md`）。
5. **`apps/mobile` 交叉污染**：Android 端以 `@renderer/*` 直接引用 desktop 渲染层源码，desktop 的任何渲染层改动都可能打挂移动端 typecheck。本轮已把 `lib/platform.ts` 的 `window.jareking.platform` 访问写成防御式（不硬依赖接口字段）。**这是架构债**，建议 Android 端改为「共享包 + 平台桥接口」而非跨 app 相对引用。
6. **自动更新在 mac 上暂不可用**：未签名前 Squirrel.Mac 会拒绝；不阻塞开发，阻塞正式分发。
