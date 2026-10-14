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

> 结论时间线：2026-10-14 首轮复检。分级：🔴 阻塞/回归风险，🟠 重要，🟡 建议。

### 🔴 大文件（100MB+）稳定性
- **Writer**：`docxParser.ts:860` `JSZip.loadAsync` 整包入内存；`WriterEditor.tsx:178/219` `setContent(jkToHtml(jk))` 把整篇文档（含图片 base64 data URL）合成**一个 HTML 字符串**交给 ProseMirror，**无分页/无虚拟化**。100MB 文档有 OOM/卡死风险。
  - 修复方向：解析侧流式/分块；渲染侧考虑分页或虚拟滚动；图片用 Blob URL 而非内联 base64。
- **Presentation**：`SlideEditor.tsx` 所有幻灯片、所有形状**一次性** mount 进 Konva（`slides.map` + `shapes.map`），无懒加载/离屏剔除。百页大 PPT 内存与首屏时间长。
  - 修复方向：只渲染可视页 + 缩略图；图标/形状按需实例化。

### 🔴 Sheet 样式回写断裂（跨设备保真回归）
- `sheet/univerAdapter.ts:10` 注释"样式暂不映射"，打开时 `styles:{}`（`:91`），保存侧 `univerToJk` 只回读公式/合并，**不回读 Univer 内编辑出的填充/字体/边框/对齐** → 在 Univer 里改的单元格样式**存盘即丢**。
  - 修复方向：`univerToJk` 遍历单元格 `getRange().getStyle()` 写回 `JkCellStyle`（font/fill/border/alignment/numFmt），并补齐 `JK→Univer` 的样式写入。

### 🟠 Writer 域/公式（页码、目录域、交叉引用、公式域）降级
- `docxParser.ts:193` 将 `fldsimple/fldchar/instrtxt` 记为 `field` 类 UnsupportedFeature，未建模。复杂 Word 域在 round-trip 中可能丢失或降级为静态文本，影响跨程序（Word/WPS）打开后的页码/目录/公式显示。
  - 修复方向：建模最小可用字段（至少保留 `w:fldSimple` 的指令与结果，导出时原样回写 `__raw`）。

### 🟠 命名样式未保留为 Word 样式
- Writer 用 TipTap 内联 span 表达格式，不还原 Word 的 `w:style`（Heading 1 等）。保存后 Heading 变为"手动加粗大字"，在 Word/WPS 中失去导航/目录/大纲语义。
  - 影响：跨设备、跨程序（尤其依赖样式的排版）格式观感漂移。

### 🟡 字体未嵌入
- 未嵌入字体子集，目标设备缺字体会回退。与 WPS 默认行为一致（非缺陷），但中文文档跨设备需留意字体可用性。

### 已验证"不会坏"的项（避免重复排查）
- **公式写回 xlsx：正常**。`xlsxParser` 读 `f`（去 `=`）、`exporter/index.ts:78` 写 `cell.value={formula}`、`univerAdapter` 双向映射，公式可存活。
- **表格底纹（shd）保真：已补全**（cell/row/table 三级，`packages/writer` + 桌面端 HTML 链路），有单测。
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
- 🔧 本次（2026-10-14）已落地：Ribbon 真实折叠（Ctrl+F1）、AI 面板拖拽调宽、设置分区可折叠、对抗性复检与本文档。
