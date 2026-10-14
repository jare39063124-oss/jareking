# jareking 工程说明书（面向 Agent / AI 协作）

> 用途：修复 bug、优化迭代、新增功能时，让 Agent 无需通读全仓即可快速定位模块、复现环境、理解约定。
> 维护规则：任何人（人或 Agent）改动架构 / 新增模块 / 修正重大风险后，同步更新本文件第 5、6、7 节。
> 配套文档：`spec.md`（产品规格 v1.1）、`todo.md`（Phase 0–8 任务与验收，含当前勾选状态）。

---

## 1. 项目速览

- **目标**：Windows 10/11 单平台的 WPS 平替办公套件（Writer/Sheet/Presentation/PDF + 内置可自配 AI）。
- **形态**：Electron + React 19 + TypeScript（严格模式）+ Tailwind + Zustand；pnpm workspace monorepo。
- **核心约束**（决定很多设计）：个人独立开发者、无商业资质、无云服务器 → v1 纯本地、零服务端；AI 主推"用户自带 Key"；商业化走第三方平台 + 离线许可证。
- **关键历史决策**：品牌名 `jareking`（GitHub 用户名被占，仓库用 `jare39063124-oss/jareking`）；放弃 macOS；Presentation 升入 v1 全量；云同步/平台托管 AI/广告 全部预留。

---

## 2. 仓库结构（模块地图）

```
jareking/
├── apps/desktop/                # Electron 应用（主进程 + 渲染进程）
│   ├── src/main/                # 主进程：窗口/菜单/文件关联/自动更新/服务层(IPC)
│   │   ├── services/            # 本地持久层服务封装（调用 packages/core）
│   │   ├── preload.ts           # 暴露 window.jareking.invoke(...) IPC 桥
│   │   └── updater.ts           # electron-updater（仅 packaged 模式生效）
│   ├── src/renderer/src/
│   │   ├── App.tsx              # 顶层布局：TabBar + Ribbon + EditorArea + AIPanel + StatusBar
│   │   ├── components/          # 通用组件 + 业务组件（Ribbon/AIPanel/SettingsPanel/Modal…）
│   │   ├── stores/              # zustand：uiStore / aiStore / tabStore / toastStore
│   │   ├── writer/              # WriterEditor + jkToHtml / htmlToJk 转换 + opsExecutor
│   │   ├── sheet/               # SheetEditor + univerAdapter（Univer ↔ JkWorkbook）
│   │   └── slide/               # SlideEditor（Konva）+ chartRenderer + addChart
│   └── out/                     # electron-vite build 产物（不是 dist）
├── packages/
│   ├── core/                    # 本地账户/积分/文档库/SQLite + 接口契约
│   │   └── src/{db,account,library,contracts}/
│   ├── writer/                  # 文档模型 + docx 解析/导出（自研，非库依赖）
│   │   └── src/{model,parser,exporter}/
│   ├── sheet/                   # xlsx 解析/导出（ExcelJS）+ CSV；公式/渲染靠 Univer
│   ├── presentation/            # pptx 解析/导出（自研序列化）
│   ├── ai/                      # 适配器 + Planner/Executor 的 ops 协议 + 提示词
│   └── pdf/                     # pdf-lib 页面工具（提取/删除/合并/旋转…）
├── scripts/                     # gui-smoke.mjs（CDP 冒烟）、verify-*-roundtrip.mjs
└── docs/                        # spec.md / todo.md / manual.md / 本文件
```

### 2.1 各包职责与关键文件

| 包 | 职责 | 必读文件 |
|---|---|---|
| `packages/core` | SQLite（SQL.js WASM）、本地账户、积分账本、文档库、自动保存；**接口契约单一事实源** | `src/contracts/*.ts`（ai/account/document/license）、`src/db/`、`src/library/autosaveManager.ts`、`src/account/pointsLedger.ts` |
| `packages/writer` | **自研** docx 模型/解析/导出；保真分级 L1/L2/L3 | `src/model/document.ts`（模型）、`src/parser/docxParser.ts`、`src/exporter/document.ts`、`src/exporter/units.ts`（单位换算，解析/导出必须互逆）、`src/model/fidelity.ts` |
| `packages/sheet` | xlsx 读写为 ExcelJS；公式与单元格渲染由 Univer 承担 | `src/parser/xlsxParser.ts`、`src/exporter/index.ts`、`src/exporter/csv.ts` |
| `packages/presentation` | pptx 解析（JSZip+fast-xml）+ **自研**序列化导出 | `src/parser/pptxParser.ts`、`src/exporter/index.ts`、`src/model/index.ts` |
| `packages/ai` | AIAdapter（OpenAI兼容/Claude/Gemini/Ollama）、流式/重试、Planner→Executor 的 ops 协议 | `src/adapter.ts`、`src/planner/{writerOps,sheetOps,presentationOps}.ts`、`src/planner/index.ts` |
| `packages/pdf` | pdf-lib 页面级操作 | `src/index.ts` |

### 2.2 渲染进程关键文件

| 文件 | 职责 |
|---|---|
| `writer/WriterEditor.tsx` | TipTap 编辑器；加载= `parseDocx→jkToHtml→setContent`；保存= `htmlToJk→exportDocx`；持有 `__jkWriterDebug` |
| `writer/jkToHtml.ts` / `htmlToJk.ts` | 文档模型 ↔ HTML（编辑器 ↔ 模型 ↔ 文件 的枢纽，**任何格式漂移先查这里**） |
| `writer/opsExecutor.ts` | AI ops 的本地确定性执行；新增 Writer AI 能力在此接 |
| `sheet/univerAdapter.ts` | Univer ↔ JkWorkbook 双向映射（`JK→Univer` 打开、`Univer→JK` 保存）；**样式回写目前是空实现，见第 7 节** |
| `sheet/SheetEditor.tsx` | 挂载 Univer、打开/保存/重置、持有 `__jkDebug` |
| `slide/SlideEditor.tsx` | Konva 舞台；所有幻灯片/形状一次性渲染（无懒加载）；`addChart` 复用 `chartRenderer`；持有 `__jkSlideDebug` |
| `slide/chartRenderer.ts` | 零依赖 canvas→PNG 图表（bar/line/pie），供 PPT 插图 |
| `components/Ribbon.tsx` | 功能区（已支持折叠：`ribbonCollapsed` + Ctrl+F1） |
| `components/AIPanel.tsx` | 右侧 AI 面板（可折叠 + 拖拽调宽 `aiPanelWidth`） |
| `components/SettingsPanel.tsx` | 设置弹窗（分区可折叠 Accordion） |

---

## 3. 环境、构建与验证（Agent 必看）

### 3.1 启动 / 构建 / 测试

```bash
# 开发（需先解除沙箱对 ELECTRON_RUN_AS_NODE 的注入，否则起的是 Node）
cd apps/desktop && env -u ELECTRON_RUN_AS_NODE pnpm dev

# 构建（产物在 apps/desktop/out/，主入口 out/main/index.js）
cd apps/desktop && pnpm exec electron-vite build

# 类型检查
cd apps/desktop && pnpm exec tsc --noEmit -p tsconfig.json
cd packages/writer && pnpm exec tsc -p tsconfig.json   # writer 改完必须重建 dist 供桌面端引用

# 单测（jsdom 环境，需先构建依赖包的 dist）
cd packages/writer && pnpm exec vitest run          # 解析/导出/图片 round-trip
cd apps/desktop    && pnpm exec vitest run          # 渲染层 HTML round-trip
```

### 3.2 GUI 冒烟（真实 Electron + CDP）

```bash
# 1) 起 Electron（带 debug 与 CDP 端口）
cd apps/desktop && env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . --remote-debugging-port=9222 --jk-debug
# 2) 另开终端跑冒烟（会轮询等待页面就绪）
cd jareking && node scripts/gui-smoke.mjs --port 9222
```

- 冒烟覆盖：Writer 打开 sample.docx（0 控制台错误）、AI 全链路（mock LLM）、Sheet 挂载、PPT 图表插入（`pptChartAfterModal:1` 验证弹窗按钮真实点击生效）。
- 改动 `Modal`/`AIPanel`/`Ribbon` 等 UI 接线后，**必须重跑冒烟**（历史教训：曾因 portal 事件委托 + 冒烟脚本误命中功能区同名按钮，误报"插入按钮失效"）。

### 3.3 格式 round-trip 验证脚本

```bash
node scripts/verify-docx-roundtrip.mjs   # parse→export→reparse，按段落/表格计数比对
node scripts/verify-xlsx-roundtrip.mjs   # 同上（表/合并/公式/样式）
```

### 3.4 提交与推送（重要约束）

> ⚠️ **本环境 `git push` 被代理拦截**（仅放行 `api.github.com`，`github.com` 的 git 协议 CONNECT 502）。标准 `git push` 不可用。
> 推送走 GitHub REST API（Git Database：blobs/trees/commits/refs），脚本思路见 `E:/workbuddyworkplace/.workbuddy/memory/2026-10-14.md`。
> 落点仓库：`jare39063124-oss/jareking`，分支 `master`，采用"以远端实时 head 为父做快进 + 仅上传变化文件 + 5xx/502 重试"。
> Token 见用户长期记忆（`github_pat_…`）。**不要**用 `git push` 直连。

---

## 4. 调试钩子（需 URL 带 `?jk-debug`）

| 钩子 | 方法 | 用途 |
|---|---|---|
| `window.__jkWriterDebug` | `.html()` `.text()` | 取 Writer 当前 HTML / 纯文本 |
| `window.__jkDebug` | `.snapshot()` `.runSheetAi(s)` `.activeSheet()` `.readCell(a1)` `.setValueAt(r,c,v)` `.getValueAt(r,c)` `.directSet()` | Sheet 当前工作簿快照 / 触发 AI / 读单元格 |
| `window.__jkSlideDebug` | `.slideCount()` `.imageCount()` `.mediaCount()` `.insertChart()` `.renderChartTest()` `.runPresentationAi(s)` | PPT 幻灯片/媒体计数 / 插入图表 / 触发 AI |

调试流程：带 `--jk-debug` 启动 → 打开对应模块 → 在 CDP `Runtime.evaluate` 里调用钩子（冒烟脚本即此模式）。

---

## 5. 接口契约（改动前必读，勿擅自偏离）

- 位置：`packages/core/src/contracts/*.ts`（ai / account / document / license）。
- 规则：**任何 Agent 不得直接改 contracts**，变更须回到编排层评审；先定契约再并行实现（见 `todo.md` 子 Agent 调度策略）。
- 各包导出的模型/解析/导出函数签名以 `packages/*/src/index.ts` 为边界，桌面端只消费这些导出。

---

## 6. 已知风险与对抗性复检结论（维护：每次复检后更新）

> 结论时间线：**2026-10-14** 首轮复检（🔴/🟠/🟡 分级）；**2026-10-15** 复检问题逐步修复（#46/#47/#48 已落地，仅大文件深层架构债暂缓，见下）。

### ✅ #46 大文件（100MB+）稳定性 —— 已落地「安全降级」缓解（非根治）
- **已做（不丢交互、不崩溃）**：
  - `lib/largeFile.ts` 新增 `LARGE_FILE_WARN_BYTES=30MB` / `LARGE_FILE_HARD_BYTES=200MB`、`fileSizeLevel()`、`formatBytes()`、`largeFileHint(bytes,'word'|'ppt')` —— 统一告警阈值与文案。
  - `WriterEditor.tsx`：开大文档时先 `setTimeout(0)` 让出主线程再 `setContent`，期间挂 `LoadingOverlay` 遮罩，**解析不冻结 UI**；超阈值弹可关闭的"大文件"横幅提示（非阻塞）。
  - `SlideEditor.tsx`：**缩略图条虚拟化**（按 `scrollTop` 窗口化渲染 + 5 项缓冲，绝对定位 + 占位 spacer），无论多少页 DOM 节点数恒定；`onFileChange` 包裹 loading + 滚动复位 + 尺寸告警。
- **⏸ 暂缓（深层架构债，明确不丢项，排入后续）**：① Writer 文档级虚拟化/分页（当前整篇合成一个 HTML 给 ProseMirror，无分页）；③ Sheet/PPT 超大数据的分块解析。这些记录在 `lib/largeFile.ts` 注释与 `todo.md` 的「对抗性复检后续」清单，作为 M3 优化项。
- **✅ ② 图片 Blob URL 化（#46-B，已落地 2026-10-15）**：新增 `writer/mediaRegistry.ts`（relId → 字节 + Blob URL，生命周期 revoke）；`jkImage.ts` 扩展 TipTap Image 保留 `data-jk-media`；`jkToHtml`/`htmlToJk` 支持可选 `mediaMap`/`mediaBytes`，显示侧用 Blob URL（DOM 不再持 base64，内存大幅下降），保存凭 `data-jk-media` 从注册表取回字节（blob: 不可还原问题消除）；`WriterEditor` 接入加载建 Blob URL / 保存回写 / 卸载 revoke。新增 `mediaRegistry.test.ts`（6 测），`roundtrip.test.ts` 回归通过。**验证**：桌面 14/14 单测通过；typecheck 通过；GUI 冒烟待构建后跑 `scripts/gui-smoke.mjs`。

### ✅ #47 Sheet 样式回写断裂（跨设备保真回归）—— 已根治
- 旧 `sheet/univerAdapter.ts` 注释"样式暂不映射"，`styles:{}`，保存只回读公式/合并 → Univer 里改的填充/字体/边框/对齐**存盘即丢**。
- **修复**：`univerAdapter.ts` 新增 `jkStyleToUniver()` / `univerStyleToJk()` 双向映射（`IStyleData` ↔ `JkCellStyle`，覆盖 bold/italic/underline/strike/color/bgColor/fontSize/fontFamily/对齐/换行/数字格式/四向边框）；`StyleRegistry` 内容去重避免大表样式表膨胀；`sheetToUniver` 写 `s=sid`，`cellDataToJk` 读 `u.s`（sid 或内联对象）回写。保真结论升级为"样式已双向映射"。
- **验证**：`univerAdapter.test.ts` 7/7 通过（写入/去重/常规对齐跳过/回读全字段/内联对象/ rgb() 归一化 / JK→Univer→JK 往返）；桌面端 typecheck 通过。

### ✅ #48 Writer 域（页码/目录/交叉引用/公式域）—— 已建模（简单+复杂域）
- 旧 `docxParser.ts` 将 `fldsimple/fldchar/instrtxt` 记为 `field` 类 UnsupportedFeature，未建模 → round-trip 降级为静态文本，Word/WPS 打开后页码/目录/公式不重算。
- **修复**：
  - 模型：`model/document.ts` `Inline` 联合新增 `Field`（`type:'field'`、`instr`、`result?`）。
  - 解析：`docxParser.ts` 支持①`fldSimple`（`@_instr` + 内部文本作 result）②复杂域状态机（`fldChar` begin/separate/end + `instrText` 累积指令 + separate 后 run 文本作 result）。**真实 OOXML 中 `fldChar`/`instrText` 包裹在 `w:r` 内**，已处理嵌套（run 内优先识别域标记驱动状态机）。`fast-xml-parser` 把 `<w:t>1</w:t>` 解析成数字，已用 `deepText`/`childText` 数字安全化。
  - 导出：`exporter/document.ts` 对 `field` 发射 `<w:fldSimple w:instr="...">{result run}</w:fldSimple>`（复杂域在导出时归并为简单域保留指令与结果，Word/WPS 打开按指令重算）。
  - 编辑器/HTML 链路：`writer/jkField.ts` 新增 TipTap atom inline 节点 `JkField`（保编辑态不丢）；`jkToHtml.ts`/`htmlToJk.ts` 双向识别 `span[data-jk-field]`。
- **验证**：`packages/writer/test/field.test.ts` 3/3 通过（简单域 / 复杂域 / 解析→导出→再解析往返）；writer 全量 19/19 测试通过、typecheck 通过。
- **已知局限（不丢项，留痕）**：仅保留指令+结果（fldSimple 形态），未保留 `separate/end` 之间的完整 run 格式细节；嵌套域、IF/INDEX 等带参数域的指令原文保留但 jareking 不重算值（交给 Word/WPS 打开时计算），符合 v1 L2 保真预期。

### 🟠 命名样式未保留为 Word 样式（复查已确认：实际已完整，非缺口）
- 复查确认 `model/document.ts` 的 `styleId`/`StyleDef`/`serializeStyles` 与 parser/exporter 已**完整贯通** Word 命名样式（Heading 1 等）的读写 —— 该项**不是真实缺口**，已从风险清单移除（留痕以免重复排查）。

### 🟡 字体未嵌入
- 未嵌入字体子集，目标设备缺字体会回退。与 WPS 默认行为一致（非缺陷），但中文文档跨设备需留意字体可用性。

### 已验证"不会坏"的项（避免重复排查）
- **公式写回 xlsx：正常**。`xlsxParser` 读 `f`（去 `=`）、`exporter/index.ts:78` 写 `cell.value={formula}`、`univerAdapter` 双向映射，公式可存活（含本次 #47 样式映射）。
- **表格底纹（shd）保真：已补全**（cell/row/table 三级，`packages/writer` + 桌面端 HTML 链路），有单测。
- **Sheet 单元格样式保真：已补全**（#47，双向映射 + 去重），有单测。
- **Writer 域保真：已建模**（#48，简单/复杂域 + 编辑器 `JkField`），有单测。
- **Modal 弹窗按钮失效：已修复**（portal 挂到 `#root` 内部）。

---

## 7. 症状 → 定位索引（bug 排查起点）

| 现象 | 先看 |
|---|---|
| 打开 .docx 后格式丢/乱 | `writer/jkToHtml.ts`、`writer/htmlToJk.ts`、`packages/writer/src/exporter/document.ts`、`packages/writer/src/model/document.ts` |
| 保存后再打开结构变了 | `packages/writer` 的 `exporter` 与 `parser` 单位换算（`exporter/units.ts` 必须互逆） |
| 表格显示/保存异常 | `packages/writer/src/model/document.ts` 的 `Table*` 类型 + `exporter/document.ts` 的 `serializeTable*` + `jkToHtml/htmlToJk` 的 `renderTable/parseTable` |
| Sheet 公式算错/丢 | `packages/sheet/src/parser/xlsxParser.ts`、`exporter/index.ts`、`sheet/univerAdapter.ts`、`packages/ai/src/planner/sheetOps.ts` |
| Sheet 改了样式存盘没变 | **优先查 `sheet/univerAdapter.ts` 的 `univerToJk`（样式回写空实现）** |
| PPT 打不开/图形错位 | `packages/presentation/src/parser/pptxParser.ts`、`exporter/index.ts`（EMU↔px 换算） |
| AI 指令不生效 | `packages/ai/src/planner/*`、`apps/desktop/.../writer/opsExecutor.ts`、`sheet/SheetEditor.tsx` 的 `aiRunRef`、`slide/SlideEditor.tsx` 的执行器 |
| 弹窗按钮点了没反应 | `components/Modal.tsx`（必须 portal 到 `#root` 内，不能到 `document.body`） |
| 大文件卡死/OOM | `docxParser.ts` 的 `loadAsync` + `WriterEditor` 的 `setContent`；`SlideEditor` 的全量渲染 |
| 控制台报错 | 跑 `scripts/gui-smoke.mjs`，关注 `consoleErrors` 字段 |

---

## 8. 当前进度（速记，详见 `todo.md`）

- ✅ 完成：Phase 0（基础设施）、Phase 1 Writer（L2）、Phase 2 Sheet（xlsx+公式+数据功能）、Phase 3 PPT 核心（开/编/存，无动画/放映）、Phase 4 AI 全链路（mock 验证）。
- ⏸ 暂缓/未做：**Phase 5 PDF（阅读/编辑/导出全未做）**、Phase 6 商业化（未做）、Phase 7 账户（未做）、Phase 8 体验发布（未做）；Writer 高级特性（目录/批注/查找替换）、PPT 动画放映、Sheet 图表。
- 🔧 本次（2026-10-15）已落地：#46 大文件安全降级缓解（LoadingOverlay 不冻结/尺寸告警/缩略图虚拟化）+ #46-B 图片 Blob URL 化（mediaRegistry 省内存）、#47 Sheet 样式双向映射根治（7/7 单测）、#48 Writer 域建模（简单+复杂，3/3 单测）；另含 Ribbon 折叠/AI 面板调宽/设置折叠/布局优化（2026-10-14）。
- ⏸ 大文件深层架构债（#46 暂缓项，不丢项）：Writer 文档级虚拟化/分页、Sheet/PPT 分块解析 —— 见 `lib/largeFile.ts` 注释 + `todo.md`「对抗性复检后续」。
