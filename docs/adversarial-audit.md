# jareking 对抗性审计报告（adversarial-audit）

> 生成者：QA 严过关 · 并行任务 3/3 · 由 `scripts/adversarial-audit.mjs` 自动生成
> 生成时间：2026-10-15T18:25:51.332Z
> 运行环境：win32 / Node v22.22.2

## 1. 概述

- 立场：**对抗（adversarial）**。目标：保证不丢格式、文件不损坏、不同软件均能正常读取。
- 范围：Writer(docx) / Sheet(xlsx) / Presentation(pptx) / PDF 四大模块的边界与恶意输入、round-trip 保真、包完整性、跨软件可读性。
- 方法：
  - **A 边界/恶意输入**：程序化构造极端样本（空文档 / 超长（10 万字符）/ 特殊字符 emoji+组合+RTL+零宽+XML 敏感 / 深嵌套 3 层表格 / 5MB 大图 / 公式+批注+修订+页眉页脚+脚注+分栏 混排 / 200 列 / 非法公式 / 全角 …）；
  - **B round-trip 保真**：`parse → export → parse`，比对关键结构计数是否逐一相等；
  - **C 文件完整性**：JSZip 解压 + CRC32 校验 + 必需部件 + XML 合法性 + **悬空关系（dangling rel）**检测；
  - **D 跨软件可读**：把 jareking 导出的 docx/xlsx/pptx 样本交本机 WPS 的 COM 组件打开并读回结构。
- 真实 WPS 实测：**已实测（见 §4）**
- 生成样本目录：`C:\Users\Administrator\AppData\Local\Temp\jareking-adversarial-audit`

## 2. 测试矩阵

| ID | 模块 | 用例 | 期望 | 实际 | 结果 |
|---|---|---|---|---|---|
| T01 | Writer | 空文档（body 为空） | 不崩溃；段落/表格计数 round-trip 一致 | 计数一致 | ✅ |
| T02 | Writer | 超长单段（100,000 字符） | 文本长度 100000 保真，不崩溃 | 两次解析长度均=100000 | ✅ |
| T03 | Writer | 特殊字符（emoji/组合/RTL/CJK/零宽/XML敏感/连续空格/制表符） | 文本逐字保真（含 emoji/组合/零宽/敏感字符），tab/br 计数一致 | 文本逐字一致；tab/br 计数一致 | ✅ |
| T04 | Writer | 深嵌套表格（3 层） | 表格计数=3 且嵌套结构保真 | 表格计数 a=3 b=3 | ✅ |
| T05 | Writer | 超大图片（单张 5MB PNG） | 图片字节数 ≥5MB 保真，image 关系保留 | 媒体字节 a=5242880 b=5242880（期望≥5242880） | ✅ |
| T06 | Writer | 混排（公式+批注+修订+页眉页脚+脚注+分栏并存） | 公式/批注/修订/脚注/页眉/页脚/分栏 计数 round-trip 全一致 | formula 1→1, comments 1→1, revisions 2→2, footnoteRefs 1→1, footnotes 1→1, headerBlocks 1→1, footerBlocks 1→1, columns 1→1 | ✅ |
| T07 | Writer | 修订与批注锚点（w:ins/w:del + commentRangeStart/End/Reference） | 修订 run 数=2，批注数=1，commentRange 锚点保留 | 修订 2→2，批注 1→1，锚点区间 a=1 b=1 | ✅ |
| T08 | Sheet | 空表（0 行 0 列） | 不崩溃；sheet 计数一致 | 结构一致 | ✅ |
| T09 | Sheet | 超宽表（200 列） | 200 列单元格全部保真 | 结构一致 | ✅ |
| T10 | Sheet | 非法公式（=1/0、=SUM(A:A)） | 公式字符串原样保留、不崩溃 | 结构一致 | ✅ |
| T11 | Sheet | 超长字符串单元格（50,000 字符） | 不崩溃（如实记录截断） | 结构一致 | ✅ |
| T12 | Sheet | 100% 全角字符 | 全角文本保真 | 结构一致 | ✅ |
| T13 | Sheet | 多 sheet + 隐藏 sheet | sheet 数=3、隐藏标记保真 | 结构一致 | ✅ |
| T14 | Sheet | 合并区域边界（单格合并 A1:A1） | 不崩溃或如实降级 | 设计内降级：单格合并被规范化丢弃（Excel 不支持 A1:A1）｜[MergeBoundary] 合并 1→0 | 🟡 设计内降级 |
| T15 | Presentation | 空 0 形状页 | 不崩溃；页数/形状数一致 | 结构一致 | ✅ |
| T16 | Presentation | 超长文本（20,000 字符） | 不崩溃 | 结构一致 | ✅ |
| T17 | Presentation | 0 尺寸形状（w=0,h=0） | 不崩溃；形状保留 | 结构一致 | ✅ |
| T18 | Presentation | 旋转 359° | rotation=359 保真 | 结构一致 | ✅ |
| T19 | Presentation | 表格 1×1 与 10×10 | 两页表格形状保留 | 结构一致 | ✅ |
| T20 | Presentation | 带超链接形状 | 超链接保留 | 结构一致 | ✅ |
| T21 | Presentation | 母版/版式缺失 | 不崩溃；导出自动补默认母版/版式 | 结构一致 | ✅ |
| T22 | PDF | 图片转 PDF（2 图 → 2 页） | 页数=2，%PDF- 头 | 单图=1 页，双图=2 页，head=%PDF- | ✅ |
| T23 | PDF | 合并（2 份 1 页 → 2 页） | 页数=2 | 合并后页数=2 | ✅ |
| T24 | PDF | 链式：图片→合并→水印（ASCII 文本） | 页数守恒且输出合法 PDF | 页数=2 head=%PDF- size 2345→3377 | ✅ |
| T25 | PDF | 水印：非 Latin（中文）文本 | 不崩溃或给出可读的输入校验错误 | 抛出异常：水印文字含非拉丁字符（如「机密」），当前环境无法嵌入该字体：pdf-lib 嵌入 TTF/OTF/TTC 自定义字体需依赖 @pdf-lib/fontkit（本项目未引入该运行时依赖）。请改用拉丁字符，或在已注册 fontkit 的环境中通过 opts.fontPath（如 "C:\\Windows\\Fonts\\simhei.ttf"）/ opts.fontBytes 指定中文字体。 | ❌ P1 |
| T26 | PDF | 页面工具：提取/旋转/删除 | 页数按预期变化 | 提取=2 旋转=3 删除=2 | ✅ |
| T27 | Integrity | docx 混排产物 zip 完整性（含关系可达） | 无损坏条目/部件齐/无悬空关系 | 通过（11 个部件） | ✅ |
| T28 | Integrity | 含 5MB 图片 docx 产物完整性（媒体可达） | word/media 存在且被关系指向 | 完整性=true media 部件=true | ✅ |
| T29 | Presentation | 导出包结构：默认演示（无母版）应自带母版/版式/主题 | 含 ppt/slideMasters/*、ppt/slideLayouts/*、ppt/theme/*，且 presentation.xml 含 <p:sldMasterIdLst> | slideMaster=true slideLayout=true theme=true sldMasterIdLst=true | ✅ |
| T30 | Presentation | 导出包结构：母版应含 <p:sldLayoutIdLst> 并关联版式 | slideMaster 含 <p:sldLayoutIdLst>；母版 rels 含 slideLayout 关系 | sldLayoutIdLst=true 母版→版式关系=true | ✅ |
| T31 | CrossSoft | WPS 打开 jareking-doc-1.docx | 能被本机 WPS 正常打开并读回结构 | 段落=4 表格=0 | ✅ |
| T32 | CrossSoft | WPS 打开 jareking-doc-2.docx | 能被本机 WPS 正常打开并读回结构 | 段落=2 表格=0 | ✅ |
| T33 | CrossSoft | WPS 打开 jareking-doc-3.docx | 能被本机 WPS 正常打开并读回结构 | 段落=7 表格=1 | ✅ |
| T34 | CrossSoft | WPS 打开 jareking-sheet-1.xlsx | 能被本机 WPS 正常打开并读回结构 | sheets=1 首表UsedRange=2x2 | ✅ |
| T35 | CrossSoft | WPS 打开 jareking-sheet-2.xlsx | 能被本机 WPS 正常打开并读回结构 | sheets=2 首表UsedRange=1x2 | ✅ |
| T36 | CrossSoft | WPS 打开 jareking-slide-1.pptx | 能被本机 WPS 正常打开并读回结构 | slides=1 | ✅ |
| T37 | CrossSoft | WPS 打开 jareking-slide-2.pptx | 能被本机 WPS 正常打开并读回结构 | slides=2 | ✅ |

**小计**：共 37 项 —— 通过 35 / 设计内降级 1 / 失败 1。

## 3. Bug 清单（分级）

### [P1] T25 PDF · 水印：非 Latin（中文）文本
- **源码定位**：packages/pdf/src/index.ts:310（watermark 字体） + PdfToolbox.tsx:136-148（无输入校验）
- **复现**：`node scripts/adversarial-audit.mjs` 即可；该用例编号 T25
- **期望**：不崩溃或给出可读的输入校验错误
- **实际**：抛出异常：水印文字含非拉丁字符（如「机密」），当前环境无法嵌入该字体：pdf-lib 嵌入 TTF/OTF/TTC 自定义字体需依赖 @pdf-lib/fontkit（本项目未引入该运行时依赖）。请改用拉丁字符，或在已注册 fontkit 的环境中通过 opts.fontPath（如 "C:\\Windows\\Fonts\\simhei.ttf"）/ opts.fontBytes 指定中文字体。
- **证据**：`packages/pdf/src/index.ts:310 doc.embedFont(StandardFonts.Helvetica) → font.widthOfTextAtSize 对非 Latin 输入抛 WinAnsi；apps/desktop/src/renderer/src/components/PdfToolbox.tsx:136-148 直接透传用户输入（无 CJK 校验）。原始错误：水印文字含非拉丁字符（如「机密」），当前环境无法嵌入该字体：pdf-lib 嵌入 TTF/OTF/TTC 自定义字体需依赖 @pdf-lib/fontkit（本项目未引入该运行时依赖）。请改用拉丁字符，或在已注册 fontkit 的环境中通过 opts.fontPath（如 "C:\\Windows\\Fonts\\simhei.ttf"）/ opts.fontBytes 指定中文字体。`
- **影响**：严重级：支持范围内的内容丢失或结构走样，round-trip 不可逆。

## 4. 跨软件可读性结论

**结论：已用本机 WPS 的 COM 自动化组件真实打开 jareking 导出样本并读回结构。**

引擎探测（COM ProgID → 组件自报名称/版本）：

| 大类 | ProgID | 组件自报名 | 版本 |
|---|---|---|---|
| word | Word.Application | Microsoft Word | 12.0 |
| excel | Excel.Application | Microsoft Excel | 12.0 |
| ppt | KWPP.Application | Microsoft PowerPoint | 12.0 |

打开结果：

| 文件 | 大类 | 打开 | 读回结构 |
|---|---|---|---|
| jareking-doc-1.docx | word | ✅ | 段落=4 表格=0 |
| jareking-doc-2.docx | word | ✅ | 段落=2 表格=0 |
| jareking-doc-3.docx | word | ✅ | 段落=7 表格=1 |
| jareking-sheet-1.xlsx | excel | ✅ | sheets=1 首表UsedRange=2x2 |
| jareking-sheet-2.xlsx | excel | ✅ | sheets=2 首表UsedRange=1x2 |
| jareking-slide-1.pptx | ppt | ✅ | slides=1 |
| jareking-slide-2.pptx | ppt | ✅ | slides=2 |

## 5. 源码定位与路由判定（交工程师 / 主理人转派）

以下失败项均为**可复现的源码缺陷**：断言期望正确（符合 ECMA-376 / 用户验收目标），实现不符 → 归因 **源码 bug**（非测试问题）。

| 源码文件（定位） | 关联用例 | 级别 |
|---|---|---|
| `packages/pdf/src/index.ts:310（watermark 字体） + PdfToolbox.tsx:136-148（无输入校验）` | T25(P1) | P1 |


## 6. 证据链：pptx 跨软件失败根因隔离（对抗实验）

为区分「环境/COM 问题」与「jareking 导出物问题」，做了三组对照（均用本机 WPS COM）：

| 实验 | 样本 | 结果 |
|---|---|---|
| ① 控制组 | WPS 自身 `Presentations.Add()` 新建并另存的 pptx（含完整母版/主题） | ✅ 正常打开（slides=1） |
| ② 交换组 | WPS 骨架 + **仅替换**为 jareking 的 `slide1.xml` | ✅ 正常打开 → 证明 jareking 的**页 XML 正确** |
| ③ 被测组 | jareking 导出的 pptx（默认无母版 / 手工注入母版两版） | ❌ 均挂起（>45s 未返回） |

→ 结论：**故障在 jareking 的 pptx 包骨架**（缺母版/主题；母版缺 `p:sldLayoutIdLst` 与母版→版式关系），
  而非页内容、也非 WPS COM 环境。docx/xlsx 同环境可正常打开，进一步排除环境因素。

## 7. 未覆盖项与局限（如实声明）

- **视觉保真**：跨软件仅比对**结构计数**（段落/表格/sheets/slides），未逐像素比对分页、字体回退、精确版式；Word「结构能读」≠「排版逐像素一致」。
- **本机仅有 WPS**：无真实 Microsoft Office，MS Office 真机未实测（COM 组件自报 "Microsoft Office 12.0" 为 WPS 兼容层）。
- **旧格式/其它格式**：`.doc`/`.xls`/`.ppt`（二进制旧格式）、RTF、ODF、CSV 未覆盖。
- **高级特性**：SmartArt / OLE / 图表渲染 / 宏(VBA) / 数字签名 / 加密与受保护文档 / 修订接受-拒绝语义 未覆盖（部分为已知降级项，见 `fidelity`）。
- **性能/规模**：超大文件（≥100MB）往返由 `gen-bigfile.mjs` / `bigfile-bench.mjs` 单独覆盖，本脚本未重复。
- **Excel 值级等价**：跨软件仅读 `Sheets.Count` / `UsedRange` 尺寸，未逐单元格比对值（结构级）。
- **PDF 打印管线像素保真**：由 `pdf-export-smoke.mjs` 单独覆盖，本脚本仅覆盖 PDF 数据层算子（合并/水印/提取等）。

## 8. 总体结论与建议

- 汇总：P0=0，P1=1，P2=0，设计内降级=1，通过=35。
- **总体结论**：存在阻断/严重缺陷，需工程师修复后复测（见 §3）。
- 建议：将本脚本纳入交付前门禁（`node scripts/adversarial-audit.mjs`）；把「悬空关系检测」并入导出门禁。
- **修复建议（水印）**：`addWatermark` 对非 Latin 输入改用可嵌入的 CJK 字体（或按字符集校验并给出明确错误）；UI 侧同步做输入校验。
