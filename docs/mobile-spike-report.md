# Android 版可行性 spike 报告（2026-10-17）

> 结论先行：**Capacitor + 系统 WebView 路线成立**，渲染层零改动复用，
> debug APK 已产出 **12.9 MB**；Univer（表格）/ TipTap（文字）/ Konva（演示）/ pdfjs（PDF）
> 四个内核在 Chromium 内核下均可加载。
> 尚未在真机上做「软键盘 / IME / 手势」实测——这是本报告唯一未闭环的验证项。

---

## 1. 交付物

| 产物 | 路径 | 说明 |
|---|---|---|
| 移动端应用 | `apps/mobile/` | Capacitor 7 + Vite 6 + React 19，复用桌面渲染层 |
| Android 工程 | `apps/mobile/android/` | Capacitor 生成（compileSdk 35 / minSdk 23 / targetSdk 35） |
| debug APK | `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk` | **12.9 MB**（解包 28MB） |
| 平台适配层 | `apps/mobile/src/platform/` | `window.jareking` 桥、30 通道实现、保存拦截 |
| 移动端持久层 | `apps/mobile/src/storage/webStore.ts` | IndexedDB 替代 sql.js + node:fs |
| Web 冒烟 | `apps/mobile/scripts/smoke.mjs` | 10 条断言，无头 Chromium + CDP，零第三方依赖 |
| 单测 | `apps/mobile/src/platform/filePath.test.ts` | 8 条（伪路径/分类边界） |
| 打包脚本 | `apps/mobile/scripts/build-apk.mjs` | 自动注入 JAVA_HOME / SDK / local.properties |

## 2. 架构决策

**Electron 跑不了 Android**（只支持 Win/macOS/Linux），所以不是"打包一下"，而是换外壳。
选 Capacitor 的理由：不打包 Chromium（体积小）、渲染层是纯 Web 技术可直接复用、
插件生态覆盖 Filesystem/Share/Browser。

关键设计：**渲染层源码一行不改**。

```
apps/desktop/src/renderer/src   ←── 唯一一份 UI/编辑器代码（105 个文件）
            ↑ vite alias @renderer
apps/mobile/src/main.tsx        ←── 只做两件事：安装 window.jareking + 引入移动端 CSS
apps/mobile/src/platform/       ←── 平台差异全部收敛在这里
```

因为渲染层只通过 `window.jareking.invoke(channel, payload)` 与宿主通信（实测 14 个文件、
30 个通道），所以移动端只要**保持调用形状不变、换掉底层实现**，桌面 UI 就原样跑起来了。
通道名从 `apps/desktop/src/ipc/channels.ts` 直接 import，不复制（铁律 1.1）。

## 3. 实测结论（spike 数据）

| 验证项 | 结果 | 证据 |
|---|---|---|
| 渲染层挂载 | ✅ | `#root` 渲染出完整 Ribbon + 新建引导 |
| 通道覆盖 | ✅ **30/30** | 自检接口 `__jkMobileDiagnostics()` 逐条核对 |
| 文件打开链路 | ✅ 5646/5646 bytes | `File → 伪路径 → doc:read-file → 二次读缓存` |
| 崩溃恢复闭环 | ✅ | 存 → 列 → 恢复 → 丢弃 全通 |
| **Univer（表格）** | ✅ 挂载成功 | canvas 渲染出表格主体 |
| **TipTap（文字）** | ✅ 挂载成功 | `.ProseMirror` 出现 |
| Konva / pdfjs | ✅ 打包并加载 | 分包 `konva-*.js` / `pdfjs-*.js` 正常 |
| 能力差异显式拒绝 | ✅ | Office→PDF、导出 PDF 抛"移动端不支持"，不静默 |
| 运行期错误 | ✅ 0 条 | 无 console error / 未捕获异常 |
| APK 体积 | ✅ **12.9 MB** | 目标 20–30MB，实际优于目标（解包 28MB：assets 17MB + dex 8.2MB） |

### 体积构成（dist，未压缩）
| 分包 | 体积 | 占比 |
|---|---|---|
| univer | 11.2 MB | 65% |
| vendor（react/tiptap/zod 等） | 1.6 MB | 9% |
| pdfjs | 319 KB | 2% |
| exceljs | 940 KB | 5% |
| tiptap | 352 KB | 2% |
| konva | 204 KB | 1% |
| 其余（parse.worker / pdf.worker / css） | ~2.5 MB | 15% |

**Univer 是体积与性能的双重瓶颈**。若后续要压到 5MB 以内，需按需加载表格模块（只保留
core + 公式，砍掉条件格式/数据验证/筛选/排序四个 preset，预估省 30–40%）。

## 4. 平台差异处置（已实现）

| 桌面能力 | Android 实现 | 状态 |
|---|---|---|
| `doc:read-file`（真实磁盘路径） | SAF 选文件 → File 对象 → `jkfile://<id>/<name>` 伪路径 + IndexedDB 缓存 | ✅ 重启后仍可打开 |
| `db:query`（白名单 SQL） | IndexedDB KV（`setting:*`） | ✅ |
| 账户 / 积分（sql.js） | IndexedDB（新用户 1000 分，与桌面一致） | ✅ |
| 自动保存 / 崩溃恢复（fs） | IndexedDB 存字节快照 | ✅ |
| AI 配置 / 计量 / 宏（fs） | IndexedDB KV | ✅ |
| `system:openExternal` | @capacitor/browser | ✅ |
| `system:storageInfo` | `navigator.storage.estimate()` | ✅ |
| **保存 / 导出（`<a download>`）** | 拦截点击 → Filesystem 写缓存 → 系统分享面板 | ⚠️ 代码就绪，**待真机验证** |
| **Office→PDF（PowerShell COM）** | 不可用 → 显式报错 | ❌ 能力缺失 |
| **导出 PDF（`printToPDF`）** | 不可用 → 显式报错 | ❌ 待换方案 |
| `doc:reveal` / `openDataDir` | Android 无此概念 → 返回 false | — |
| 自动更新（electron-updater） | 应用商店 / 无自更新 | — |

## 5. 已知风险（按优先级）

1. **软键盘与 IME（未验证）** — TipTap/ProseMirror 在 Android WebView 的软键盘遮挡、
   选区跳变是历史老大难。需要在真机上用 `visualViewport` 适配，可能需要给 `.ProseMirror`
   容器加 `scroll-padding-bottom`。**这是下一个必须闭环的验证项。**
2. **导出 PDF 缺方案** — Android 无 `printToPDF`。候选：
   ① 打印框架（需原生 PrintManager + WebView.createPrintDocumentAdapter，需写 Java 插件）；
   ② canvas 逐页渲染（html2canvas + pdf-lib，新增依赖，体积 +300KB）；
   ③ 先隐藏入口并登记。建议 ①（保真度最高，不增 Web 依赖）。
3. **触屏 UI 仍是桌面布局** — 已修窄屏下的挤压问题（标签行横向滚动、隐藏 340px 侧栏），
   但 Ribbon 在手机上依然偏挤。**底部 TabBar + 抽屉式工具条**尚未实现（Phase 2）。
   截图对比：`apps/mobile/.smoke.png`。
4. **真机性能未知** — Univer 在低端机的滚动/公式重算性能未测。建议以
   `WRITER_CHUNK_SIZE` 之类阈值下调 + 限制大文件（手机建议 ≤20MB）。
5. **`a[download]` 拦截依赖 DOM 事件** — 若后续 renderer 改用 `showSaveFilePicker`
   或其它导出方式，拦截器需同步。已在 `download.ts` 注明。

## 6. 构建环境（本机已就绪）

| 组件 | 版本 | 位置 |
|---|---|---|
| JDK | **21.0.12**（Capacitor 7 的插件要求 toolchain 21） | `~/.workbuddy/binaries/jdk-21` |
| JDK（备） | 17.0.20 | `~/.workbuddy/binaries/jdk-17` |
| Android SDK | platform-tools / android-35 / build-tools 35.0.0 | `~/.workbuddy/binaries/android-sdk` |
| Gradle | 8.11.1（走腾讯云镜像，官方源本机直连超时） | wrapper 自动下载 |

```bash
cd apps/mobile
pnpm build           # vite 产物到 dist
node scripts/build-apk.mjs   # → android/app/build/outputs/apk/debug/app-debug.apk
node scripts/smoke.mjs       # Web 层 10 条断言（需先 npx vite preview --port 4173）
npx vitest run               # 8 条单测
```

⚠️ 重新执行 `cap add android` 会覆盖 `gradle-wrapper.properties` 的镜像配置，需重新改回。

## 7. 下一步（建议顺序）

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 | 真机安装 + 软键盘/IME 实测，修 `visualViewport` 遮挡 | 真机录屏 + 输入中文不丢字 |
| P2 | 保存/导出真机验证（Filesystem + Share） | 导出的 docx 能用 WPS 打开 |
| P3 | 触屏 UI：底部 TabBar + 抽屉工具条 + 手势（缩放/长按） | 单手可完成「新建→输入→保存」 |
| P4 | 导出 PDF 走 Android 打印框架（写原生插件） | 导出的 PDF 与桌面版版式一致 |
| P5 | 体积优化：Univer preset 按需加载 | APK ≤ 6MB |
| P6 | 文件关联（Intent 打开 docx/xlsx/pptx/pdf），接入 `doc:pending:take` | 从微信/文件管理器「用 jareking 打开」 |
