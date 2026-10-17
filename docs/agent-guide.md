# jareking 工程说明书（面向 Agent / AI 协作）

> 用途：修复 bug、优化迭代、新增功能时，让 Agent 无需通读全仓即可快速定位模块、复现环境、理解约定。>   
> 维护规则：任何人（人或 Agent）改动架构 / 新增模块 / 修正重大风险后，同步更新本文件第 5、6、7 节。>   
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
│   │   ├── components/          # 通用组件 + 业务组件（Ribbon/AIPanel/SettingsPanel/RecoveryCenter/PdfToolbox/MacroSection/Modal…）
│   │   ├── stores/              # zustand：uiStore / aiStore / aiChatStore / aiMeteringStore / tabStore / toastStore / pendingOpenStore / recoveryStore / macroStore
│   │   ├── lib/                 # 渲染层公共能力：largeFile / parseClient / parse.worker / pdfRender / pdfExport / printHtml / chartRenderer / fonts / download / autosave / macro{Protocol,Api,Worker,Runner,Host}
│   │   ├── writer/              # WriterEditor + jkToHtml / htmlToJk + opsExecutor + jkComment/jkRevision/jkParagraphStyle/jkFormula/jkField/jkImage
│   │   ├── sheet/               # SheetEditor + univerAdapter + chartData + sheetToHtml（打印）+ 打印设置
│   │   ├── slide/               # SlideEditor（Konva）+ rehearse（排练计时）+ presentationToHtml（打印）
│   │   └── pdf/                 # PdfReader（pdfjs 阅读器）+ pdfjs 单例 + pdfView 纯函数
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

| 包                       | 职责                                                                       | 必读文件                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`         | SQLite（SQL.js WASM）、本地账户、积分账本、文档库、自动保存；**接口契约单一事实源**                     | `src/contracts/*.ts`（ai/account/document/license）、`src/db/`、`src/library/autosaveManager.ts`、`src/account/pointsLedger.ts`、`src/account/aiMeteringLedger.ts`（AI 算力计量账本，`ai_usage` 表）                        |
| `packages/writer`       | **自研** docx 模型/解析/导出；保真分级 L1/L2/L3                                       | `src/model/document.ts`（模型）、`src/parser/docxParser.ts`、`src/exporter/document.ts`、`src/exporter/units.ts`（单位换算，解析/导出必须互逆）、`src/model/fidelity.ts` |
| `packages/sheet`        | xlsx 读写为 ExcelJS；公式与单元格渲染由 Univer 承担                                     | `src/parser/xlsxParser.ts`、`src/exporter/index.ts`、`src/exporter/csv.ts`                                                                          |
| `packages/presentation` | pptx 解析（JSZip+fast-xml）+ **自研**序列化导出                                     | `src/parser/pptxParser.ts`、`src/exporter/index.ts`、`src/model/index.ts`                                                                           |
| `packages/ai`           | AIAdapter（OpenAI兼容/Claude/Gemini/Ollama）、流式/重试、**算力计量（`src/metering.ts`）**、Planner→Executor 的 ops 协议 | `src/adapter.ts`、`src/planner/{writerOps,sheetOps,presentationOps}.ts`、`src/planner/index.ts`                                                     |
| `packages/pdf`          | pdf-lib 页面操作 + pdfjs（渲染/文本提取）；含水印 `addWatermark`/`addImageWatermark`（位图，中文可用）、`pdfToText`                                                            | `src/index.ts`                                                                                                                                    |

### 2.2 渲染进程关键文件

| 文件                                   | 职责                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `writer/WriterEditor.tsx`            | TipTap 编辑器；加载= `parseDocx→jkToHtml→setContent`；保存= `htmlToJk→exportDocx`；持有 `__jkWriterDebug` |
| `writer/jkToHtml.ts` / `htmlToJk.ts` | 文档模型 ↔ HTML（编辑器 ↔ 模型 ↔ 文件 的枢纽，**任何格式漂移先查这里**）                                                 |
| `writer/opsExecutor.ts`              | AI ops 的本地确定性执行；新增 Writer AI 能力在此接                                                            |
| `sheet/univerAdapter.ts`             | Univer ↔ JkWorkbook 双向映射（`JK→Univer` 打开、`Univer→JK` 保存）；**样式回写目前是空实现，见第 7 节**                 |
| `sheet/SheetEditor.tsx`              | 挂载 Univer、打开/保存/重置、单元格格式（Ctrl+1）、**插入图表（T2.5，选区→PNG 生成/预览/下载）**、持有 `__jkDebug`                |
| `sheet/chartData.ts`                 | 单元格矩阵 → 图表数据（`buildChartData`，纯函数；Sheet 图表复用 `lib/chartRenderer`）                             |
| `slide/SlideEditor.tsx`              | Konva 舞台；所有幻灯片/形状一次性渲染（无懒加载）；`addChart` 复用 `lib/chartRenderer`；持有 `__jkSlideDebug`            |
| `lib/chartRenderer.ts`               | 零依赖 canvas→PNG 图表（bar/line/pie），**PPT 与 Sheet 共用**（原 `slide/chartRenderer.ts` 下沉，公共能力）        |
| `lib/fonts.ts`                       | 字体清单（系统/OFL/厂商三分组）+ 字号 + 字数统计；Ribbon/设置/编辑器共用（原 `writer/fonts.ts` 下沉）                         |
| `lib/download.ts`                    | 统一下载助手 `downloadBlob`/`downloadDataUrl`（收敛各处重复的 createObjectURL + `<a download>`）             |
| `components/Ribbon.tsx`              | 功能区（已支持折叠：`ribbonCollapsed` + Ctrl+F1）                                                        |
| `components/AIPanel.tsx`             | 右侧 AI 面板（可折叠 + 拖拽调宽 `aiPanelWidth`）                                                           |
| `components/SettingsPanel.tsx`       | 设置弹窗（分区可折叠 Accordion）                                                                         |
| `pdf/PdfReader.tsx` | PDF 阅读器（pdfjs 渲染/翻页/缩放/文本层选择复制/目录/搜索） |
| `lib/autosave.ts` + `stores/recoveryStore.ts` + `components/RecoveryCenter.tsx` | 自动保存 + 崩溃恢复中心（文档备份，启动自检，恢复→pendingOpen 直达） |
| `lib/macro*.ts` + `components/MacroSection.tsx` | JS 宏：主进程 CRUD + Worker 沙箱执行 + 设置面板管理 |
| `lib/printHtml.ts` + `lib/pdfExport.ts` + `sheet/sheetToHtml.ts` + `slide/presentationToHtml.ts` | 全模块导出 PDF（Electron 原生打印管线） |
| `stores/aiMeteringStore.ts` | AI 算力用量（设置面板「算力用量」分区数据源） |
| `writer/jkComment.ts` / `jkRevision.ts` / `jkParagraphStyle.ts` | 批注 / 修订 / 段落样式（TipTap mark，模型↔HTML 往返） |
| `slide/rehearse.ts` | 排练计时纯函数（advTm 自动换片） |
| `sheet/printSettings.ts` + `sheet/dataTools.ts` + `sheet/pivot.ts` | Sheet 打印设置 / 分列·去重 / 数据透视表（纯函数） |

---

## 3. 环境、构建与验证（Agent 必看）

### 3.1 启动 / 构建 / 测试

```bash
# 开发（需先解除沙箱对 ELECTRON_RUN_AS_NODE 的注入，否则起的是 Node）
cd apps/desktop && env -u ELECTRON_RUN_AS_NODE pnpm dev

# 构建（仓库根；必须带 env，否则安全删除策略拦截 electron-builder；产物 apps/desktop/out/）
cd <repo> && CODEBUDDY_SAFE_DELETE_ENABLED=0 pnpm build

# 类型检查（仓库根；逐包 + desktop；desktop 现已真检查 renderer）
cd <repo> && pnpm typecheck
# 注：desktop 的 typecheck 此前指向 solution 型 tsconfig（files:[]），renderer 从未被检查——
#     已修复为 `tsc -p tsconfig.node.json && tsc -p tsconfig.web.json`（见第 6 节）。

# 单测（仓库根）
cd <repo> && pnpm test
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

### 3.4 提交与推送

- **提交**：`git -c user.name="jareking-dev" -c user.email="dev@jareking.local" commit -m "..."`
- **推送**：用 **Token 注入 `insteadOf` 后走标准 `git push`**（**不再**需要 REST API 脚本）：
  ```bash
  T=<GitHub PAT，见用户长期记忆>
  git -c url."https://${T}@github.com/jare39063124-oss/jareking.git".insteadOf="https://github.com/jare39063124-oss/jareking.git" push origin HEAD
  ```
- 出网走本地代理（env `http_proxy`/`https_proxy` = `http://127.0.0.1:52335`）；**代理到 github.com 的隧道时通时断（`CONNECT tunnel failed 502`）**：失败就**重试（间隔 12–15s，最多 6 次）**，命中窗口即成功；**直连 github 不可用**。
- 落点仓库 `jare39063124-oss/jareking`，分支 `master`。

---

## 4. 调试钩子（需 URL 带 `?jk-debug`）

| 钩子                       | 方法                                                                                                                     | 用途                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `window.__jkWriterDebug` | `.html()` `.text()`                                                                                                    | 取 Writer 当前 HTML / 纯文本       |
| `window.__jkDebug`       | `.snapshot()` `.runSheetAi(s)` `.activeSheet()` `.readCell(a1)` `.setValueAt(r,c,v)` `.getValueAt(r,c)` `.directSet()` | Sheet 当前工作簿快照 / 触发 AI / 读单元格 |
| `window.__jkSlideDebug`  | `.slideCount()` `.imageCount()` `.mediaCount()` `.insertChart()` `.renderChartTest()` `.runPresentationAi(s)`          | PPT 幻灯片/媒体计数 / 插入图表 / 触发 AI  |

调试流程：带 `--jk-debug` 启动 → 打开对应模块 → 在 CDP `Runtime.evaluate` 里调用钩子（冒烟脚本即此模式）。

---

## 5. 接口契约（改动前必读，勿擅自偏离）

- 位置：`packages/core/src/contracts/*.ts`（ai / account / document / license）。
- 规则：**任何 Agent 不得直接改 contracts**，变更须回到编排层评审；先定契约再并行实现（见 `todo.md` 子 Agent 调度策略）。
- 各包导出的模型/解析/导出函数签名以 `packages/*/src/index.ts` 为边界，桌面端只消费这些导出。
- **单一来源铁律（多模型协作必守，详见根目录 `AGENTS.md` 第 1.1 节）**：
  - 跨包共享的**类型/常量只定义一次**，别处 `import`；契约类型只在 `core/contracts`；模型只在各包 `src/model/`；IPC 通道名只在 `ipc/channels.ts`。
  - **演示模块标识统一 `'slide'`，永不使用 `'presentation'`**。
  - 已修复的真实漂移案例（2026-10-15）：`DocModule` 曾在 core 与 desktop/tabStore 重复定义；`PendingOpen.module` 与 `PlannerModule` 误用 `'presentation'` → 导致「最近使用」PPT 无法直达。已统一到 core `DocModule`。

---

## 6. 已知风险与对抗性复检结论（维护：每次复检后更新）

> 结论时间线：**2026-10-14** 首轮复检（🔴/🟠/🟡 分级）；**2026-10-15** 复检问题逐步修复（#46/#47/#48 已落地，仅大文件深层架构债暂缓，见下）。

### ✅ #46 大文件（100MB+）稳定性 —— 已落地「安全降级」缓解（非根治）

- **已做（不丢交互、不崩溃）**：
  - `lib/largeFile.ts` 新增 `LARGE_FILE_WARN_BYTES=30MB` / `LARGE_FILE_HARD_BYTES=200MB`、`fileSizeLevel()`、`formatBytes()`、`largeFileHint(bytes,'word'|'ppt')` —— 统一告警阈值与文案。
  - `WriterEditor.tsx`：开大文档时先 `setTimeout(0)` 让出主线程再 `setContent`，期间挂 `LoadingOverlay` 遮罩，**解析不冻结 UI**；超阈值弹可关闭的"大文件"横幅提示（非阻塞）。
  - `SlideEditor.tsx`：**缩略图条虚拟化**（按 `scrollTop` 窗口化渲染 + 5 项缓冲，绝对定位 + 占位 spacer），无论多少页 DOM 节点数恒定；`onFileChange` 包裹 loading + 滚动复位 + 尺寸告警。
- **✅ ① 分块/分页编辑（#46-A，已落地 2026-10-15）**：真·ProseMirror DOM 节点虚拟化风险高（易破坏刚稳定的编辑器），故采用**分块编辑**——完整 `JkDocument` 留内存作唯一真源，编辑器每次只渲染 `body` 的一个切片（DOM 节点数被锁在 `WRITER_CHUNK_SIZE=300`），切换/保存前 `htmlToJk` 解析当前切片并 `applyChunkEdits` 写回整文对应区间（关系按 id 去重、媒体按 rId 写入）；仅当 `body` 块数 > `WRITER_CHUNK_BLOCK_THRESHOLD=800` 才启用，普通小文档走原单文档路径**零回归**；新增分页条 UI（‹ 第 i/N 段 › + 跳转）。配套 `htmlToJk` 增加 `relSeqStart`/`mediaSeqStart` 续号参数避免分块保存时 rId 冲突。新增 `writer/chunking.ts`（纯函数）+ `chunking.test.ts`（11 测，含切片往返保留图片）。**验证**：桌面 25/25 单测通过；typecheck 通过；GUI 冒烟（consoleErrors:[]）。
- **⏸ 暂缓（深层架构债，明确不丢项，排入后续）**：③ Sheet/PPT 超大数据的分块解析（当前 `docxParser`/`xlsxParser`/`pptxParser` 全量入内存）。记录在 `lib/largeFile.ts` 注释与 `todo.md` 的「对抗性复检后续」清单，作为 M3 优化项。
- **✅ ② 图片 Blob URL 化（#46-B，已落地 2026-10-15）**：新增 `writer/mediaRegistry.ts`（relId → 字节 + Blob URL，生命周期 revoke）；`jkImage.ts` 扩展 TipTap Image 保留 `data-jk-media`；`jkToHtml`/`htmlToJk` 支持可选 `mediaMap`/`mediaBytes`，显示侧用 Blob URL（DOM 不再持 base64，内存大幅下降），保存凭 `data-jk-media` 从注册表取回字节（blob: 不可还原问题消除）；`WriterEditor` 接入加载建 Blob URL / 保存回写 / 卸载 revoke。新增 `mediaRegistry.test.ts`（6 测），`roundtrip.test.ts` 回归通过。**验证**：桌面 14/14 单测通过；typecheck 通过；GUI 冒烟（consoleErrors:[]）。
- **✅ ③ Sheet/PPT 解析迁 Worker + PPT 流式解压（#46-C，已落地 2026-10-15）**：① 解析迁移 Web Worker——`lib/parseDispatch.ts`（纯分发，worker/单测共用）+ `lib/parse.worker.ts`（独立 chunk 1.8MB，含 exceljs+fflate）+ `lib/parseClient.ts`（transferable 零拷贝 buffer 转移 + 10 分钟超时自动重建），`SheetEditor`/`SlideEditor` 打开文件改走 `parseInWorker`：主线程不再冻结、worker 崩溃被隔离。② PPT 解析改 **fflate 流式解压**（原评估的 yauzl 为 Node-only 不可用于渲染进程，换浏览器同构的 fflate）——逐条目按需解压，幻灯片 XML 解析完即丢弃、theme/embeddings/docProps 等不驻留，峰值下降；解析逻辑零改动。**顺带修复存量 bug**：`createWb` 固定 unit id `jareking-sheet` 重复创建抛 "cannot create a unit with the same unit id"（打开 xlsx 必炸，该链路此前从未端到端验证过），现先 `disposeUnit` 卸载旧 unit；两个 Editor 静默 catch 补 `console.error`。新增 `packages/presentation/test/pptxParser.test.ts`（2 测）与 `scripts/worker-smoke.mjs`（CDP 注入真实 xlsx/pptx 端到端）。**验证**：presentation 2/2 + 桌面 32/32 单测；全仓 typecheck；build；worker-smoke / gui-smoke / chunk-smoke 全绿 0 控制台错误。
- **⏸ 暂缓（真正流式 xlsx 读取器，明确不丢项，排入 M3）**：exceljs 不支持流式读，Worker 隔离已解决「冻结 + 崩溃隔离」但 Sheet 内存峰值仍随体积线性增长。真流式 xlsx 解析（自行解析 sharedStrings/sheet XML/styles）工作量大，排 M3（T8.3）按实测数据决定是否立项。


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

| 现象              | 先看                                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 打开 .docx 后格式丢/乱 | `writer/jkToHtml.ts`、`writer/htmlToJk.ts`、`packages/writer/src/exporter/document.ts`、`packages/writer/src/model/document.ts`                        |
| 保存后再打开结构变了      | `packages/writer` 的 `exporter` 与 `parser` 单位换算（`exporter/units.ts` 必须互逆）                                                                            |
| 表格显示/保存异常       | `packages/writer/src/model/document.ts` 的 `Table*` 类型 + `exporter/document.ts` 的 `serializeTable*` + `jkToHtml/htmlToJk` 的 `renderTable/parseTable` |
| Sheet 公式算错/丢    | `packages/sheet/src/parser/xlsxParser.ts`、`exporter/index.ts`、`sheet/univerAdapter.ts`、`packages/ai/src/planner/sheetOps.ts`                        |
| Sheet 改了样式存盘没变  | **优先查 `sheet/univerAdapter.ts` 的 `univerToJk`（样式回写空实现）**                                                                                            |
| PPT 打不开/图形错位    | `packages/presentation/src/parser/pptxParser.ts`、`exporter/index.ts`（EMU↔px 换算）                                                                     |
| AI 指令不生效        | `packages/ai/src/planner/*`、`apps/desktop/.../writer/opsExecutor.ts`、`sheet/SheetEditor.tsx` 的 `aiRunRef`、`slide/SlideEditor.tsx` 的执行器              |
| 弹窗按钮点了没反应       | `components/Modal.tsx`（必须 portal 到 `#root` 内，不能到 `document.body`）                                                                                   |
| 大文件卡死/OOM       | `docxParser.ts` 的 `loadAsync` + `WriterEditor` 的 `setContent`；`SlideEditor` 的全量渲染                                                                   |
| 控制台报错           | 跑 `scripts/gui-smoke.mjs`，关注 `consoleErrors` 字段                                                                                                     |

---

## 8. 当前进度（速记，详见 `todo.md` 与 `wps-parity.md`；更新于 2026-10-17）

- ✅ **WPS 对齐专项 P0 全部清零**：批 1–批 7 + 长尾（查找替换/字数统计/字体库/页眉页脚/页码/目录/导出 PDF/批注/修订/脚注尾注/分栏/样式管理器/公式 OMML/表格/图表/透视表/母版·版式/对象超链接/JS 宏/水印/分列·去重/打印设置/排练计时/崩溃恢复）。
- ✅ **Phase 0–4** 完成；**Phase 5**：T5.1 PDF 阅读器 ✅、T5.3 三模块导出 PDF ✅、**T5.2 编辑门控待产品决策**、T5.4 未做。
- ✅ **工程质量与基础设施**：desktop typecheck 真检查 renderer（45 类型错误清零）；**AI 算力计量接口**（core 契约 `AiMetering` + `packages/ai/metering` + `ai_usage` 表 + IPC + 设置面板）；**对抗性审计**（`scripts/adversarial-audit.mjs`：边界/保真/包完整性/**WPS COM 跨软件**，P0/P1 已清零）；**崩溃恢复中心**（`lib/autosave` + `RecoveryCenter` + DB v3）。
- ⏸ 未做：**Phase 6 商业化**（T6.1–T6.7，最缺失块）、**Phase 7 账户/云同步**、**Phase 8 体验发布**；T5.2/T5.4；T0.6 CI；T1.7 拼写检查。
- 📊 测试基线（2026-10-17）：writer 58 · desktop 250 · presentation 52 · core 87 · sheet 55 · pdf 15 · ai 16（全绿）。
- ⏸ 大文件深层架构债（不丢项）：仅剩「真正流式 xlsx 读取器」——见 `lib/largeFile.ts` 注释 + `todo.md`。
