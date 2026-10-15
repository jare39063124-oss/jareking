# jareking 体积战略（2026-10-15）

> 起因：需求方指出「jareking 体积太大，背离了最初的轻量平替理念」，并以 **Compositor（12MB）对标 Photoshop（6455MB）** 为参照——希望 jareking 能像 Compositor 对 PS 那样，用极小体积提供同等能力。

---

## 一、事实先行：Compositor 到底怎么做到 12MB

| 维度 | Compositor | 说明 |
|------|-----------|------|
| 技术栈 | **纯原生 Swift/AppKit + Metal**（约 96.5% Swift + 少量 C） | 不打包任何运行时 |
| 依赖 | 仅 Sparkle（更新器），其余全是 **macOS 系统框架** | CoreImage / Accelerate / Vision 全部用系统 |
| 平台 | **仅 macOS**（需 macOS 26，Apple Silicon） | 作者明确「不做 Windows/Linux」 |
| 功能取舍 | 主动砍掉 CMYK 印刷、插件生态、云同步、多平台、全格式 RAW | 「6455MB 里绝大部分是它主动放弃的」 |

**结论**：Compositor 的 12MB 来自「**单平台原生 + 系统框架 + 精准砍需求**」三重选择，**不是把 Electron 优化到 12MB**。12MB vs 6GB 是**产品定位对比**，不是能力等比。Electron/CEF 类应用「动辄几百 MB」是架构使然。

---

## 二、诊断：jareking 的 655MB 从哪来

瘦身前实测（`apps/desktop/release/win-unpacked`）：

| 项目 | 体积 | 性质 |
|------|------|------|
| **jareking.exe（Electron 主二进制）** | 235MB | Electron 固有，无法优化 |
| **app.asar** | **287MB** | 其中业务代码 out/ 仅 28MB，**~259MB 是重复打包的 node_modules** |
| locales（55 种语言） | 49MB | 只做中文市场，绝大多数用不到 |
| dxcompiler/icudtl/resources.pak/DLL 等 | ~84MB | Electron 运行时组件 |
| **合计** | **655MB**（安装包 146MB） | |

**根因**：`apps/desktop/package.json` 把**渲染层依赖**（`@univerjs/*`、`@tiptap/*`、`konva`、`react`、`pdfjs-dist`、`lucide-react` 等）写进了 `dependencies`。这些包**已被 Vite 打包进 out/renderer**，但 electron-builder 见其在 `dependencies`，又把**原始 node_modules 整份塞进 asar** → 259MB 纯浪费。

而 main 主进程运行期**只真正依赖** `@jareking/core`（→ sql.js + zod）与 `electron-updater`。

---

## 三、第一轮瘦身（Electron 路线，已落地）

### 改动
1. **依赖归属修正**（`apps/desktop/package.json`）：渲染层依赖全部移入 `devDependencies`，`dependencies` 只保留 main 运行期所需的 `@jareking/core` + `electron-updater`。→ electron-builder 不再把 renderer-only 依赖打进 asar。
2. **语言包精简**（`electron-builder.yml` → `electronLanguages: [zh-CN, en-US]`）：55 种 → 2 种。
3. **压缩比最高**（`compression: maximum`）。
4. **依赖文件精简**（`files` 排除 `*.d.ts`/`*.map`/`test`/`docs`/`*.md`/`LICENSE*`）。

### 成果
| 指标 | 瘦身前 | 瘦身后 | 变化 |
|------|--------|--------|------|
| **安装包** | 146MB | **111MB** | **-35MB（-24%）** |
| **解包总量** | 655MB | **376MB** | **-279MB（-42%）** |
| app.asar | 287MB | 56MB | -231MB |
| locales | 49MB（55 种） | 1.2MB（2 种） | -48MB |

### Electron 路线的天花板
剩余 376MB 解包中，**~340MB 是 Electron 运行时本身**（jareking.exe 235MB + dll/pak/icu），这是「套壳 Chromium」的固有成本。**Electron 应用安装包下限约 60–90MB，无法接近 12MB。**

---

## 四、路线 B：WebView2 / Tauri 迁移评估（战略，待 Windows 版稳定后启动）

### 为什么对 jareking 可行
- **只做 Windows**（2026-10-12 已决定放弃 macOS）—— Windows 10/11 自带 **WebView2（Chromium 内核）**，无需打包浏览器。
- **main 进程只依赖 `@jareking/core`（无原生模块如 better-sqlite3）** —— 迁移动机端口径小。
- **渲染层 React/TipTap/Univer/Konva/pdfjs 可原样复用**（WebView2 即 Chromium，跑同样的 Web 代码）。

### 预期体积
| 方案 | 安装包（估） | 说明 |
|------|-------------|------|
| 当前 Electron（已瘦身） | ~111MB | 含 Chromium 壳 |
| **WebView2 / Tauri 壳** | **~15–30MB** | 用系统 WebView2，不打包浏览器 |
| 纯原生（Compositor 路线） | ~12MB | 需抛弃整套 Web 技术栈，**不现实** |

### 迁移工作项（预估）
1. 用 Tauri（Rust）或轻量 WebView2 壳替换 Electron 主进程；重建 IPC（`ipcMain.handle` → Tauri command）。
2. `@jareking/core` 的 SQLite（sql.js）→ Rust 侧（rusqlite）；密钥加密（`safeStorage`）→ Windows DPAPI / Rust keyring。
3. 自动更新（electron-updater）→ Tauri updater。
4. 打包链路重建（NSIS → WiX/Tauri bundler）。
5. **渲染层几乎零改动**（React 前端整体复用）。

### 主要风险
- 主进程逻辑移植（COM 调用 Office 转 PDF、文件 IO、账户/积分）。
- WebView2 依赖用户系统已装 Runtime（Win11 自带；Win10 需引导安装约 1.5MB 引导器）。
- 工程量大（数周），需在 Windows 版功能稳定后进行。

---

## 五、决策与后续

- **立即可做（已完成）**：Electron 路线瘦身，安装包 146→111MB，**零风险、不改业务代码**。
- **后续（待 Windows 版稳定）**：启动 WebView2/Tauri 迁移评估，目标向 15–30MB 靠拢。
- **不采纳**：纯原生重写（抛弃 Univer/TipTap 等技术栈，等于重做）。
- **平台策略**：**先 Windows**，macOS 端 / 移动端等 Windows 版搞定后再议。

> 参照对象说明：Compositor 是 macOS-only 原生应用，其 12MB 与 jareking 的 Electron 架构不可直接类比；jareking 的合理目标不是 12MB，而是在「保留 Web 技术栈与跨平台可能」的前提下，向 **WebView2 的 ~15–30MB** 量级靠拢。
