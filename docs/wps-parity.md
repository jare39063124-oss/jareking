# jareking ↔ WPS 功能对齐矩阵（Parity Roadmap）

> 背景（2026-10-14 用户反馈）：「功能没有 WPS 多，需要 WPS 全量功能」。
> 结论先行：**WPS 十余年功能全量一次追平不现实也不必要**；本文件把差距显性化为矩阵，
> 按「办公高频 → 进阶 → 专业」三档分批追平，每批保持「落地即验收」节奏。
> 维护规则：每落地一批就更新本表状态；新发现的差距随时补行。

## 总览

| 模块 | 已覆盖 | 差距 P0（高频刚需） | 差距 P1（进阶） | 差距 P2（专业/低频） |
|---|---|---|---|---|
| 文字 | 基础排版全（字体字号颜色对齐缩进行距）、表格+底纹、图片、超链接、分页/分节、编号项目符号、撤销重做、域（页码/目录字段）、排版工具箱、**导出 PDF ✅ 2026-10-16**、AI 助手 | **查找替换 ✅本批**、**字数统计 ✅本批**、**字体库 ✅本批**（docs/fonts.md）、页眉页脚 ✅ 2026-10-15、页码插入 UI ✅、**导出 PDF ✅ 2026-10-16**、目录自动生成 ✅、**批注 ✅ 2026-10-15**、**修订 track changes ✅ 2026-10-15** | 脚注尾注 ✅ 2026-10-15、分栏 ✅ 2026-10-15、**样式管理器 UI ✅ 2026-10-16**、中文版式细节（字符单位缩进对话框）、水印、封面页、比较文档 | 邮件合并、艺术字、公式编辑器（OMML）、题注/交叉引用 UI、稿纸/竖排、邮件群发 |
| 表格 | 值/公式（400+函数）、合并、冻结、样式双向、条件格式、数据验证、排序筛选、多 sheet、CSV 导出、**导出 PDF ✅ 2026-10-16**、AI 写入、**插入图表（柱/折/饼，选区→PNG）**、**数据透视表 ✅ 2026-10-15** | **单元格格式对话框 ✅ 2026-10-15**（数字格式 UI）、**导出 PDF ✅ 2026-10-16**、**打印设置（纸张/区域/重复标题行）✅ 2026-10-16**、查找替换 ✅ | **分列 ✅ 2026-10-16、删除重复项 ✅ 2026-10-16**、图表散点/数据联动、名称管理器、函数向导、工作表保护 UI | 宏（JS 宏对标 VBA）、外部数据连接、模拟运算 |
| 演示 | 文本框/形状/图片、放映（基础）、AI 大纲成稿、**母版/版式 ✅ 2026-10-15**、**表格 ✅**、**图表 ✅ 2026-10-15**、**备注 ✅**、**动画切换 ✅** | **对象超链接 ✅ 2026-10-16**、排练计时 | SmartArt、音视频嵌入、协同放映 | — |
| PDF | 页面工具箱（提取/删除/合并/旋转/页码） | 阅读器（T5.1）、编辑器门控（T5.2）、Office→PDF 导出（T5.3） | 压缩（栅格化）、OCR | 表单填写、数字签名 |
| 全局 | 多标签页、命令面板、文件关联、自动更新、本地账户/积分、AI 面板 | **最近文件 UI 强化**、崩溃恢复入口显性化 | 云同步（预留）、协作 | 插件市场 |

## 分批路线（no human in the loop 原则：每批可自动验证）

### 批 1（本批，2026-10-14）✅
- Writer 查找替换（Ctrl+F/H，自研 ProseMirror，全部替换单事务可撤销）
- Writer 字数统计状态栏（WPS 口径：字数/字符两档）
- 字体库合规落地（字体下拉三分组，docs/fonts.md）

### 批 2（✅ 2026-10-16 全部落地）
- ✅ Writer 插入页码（PAGE 域，域已建模 T48，Word/WPS 打开重算）
- ✅ Writer 插入目录（扫描 heading 层级 → 目录标题 + 缩进大纲 + TOC 域）
- ✅ Writer 页眉页脚（模型 header/footer 内容字段 + 解析读 headerN/footerN + 导出生成部件/rels/content-types + 编辑 Modal，2026-10-15）
- ✅ **全模块「导出 PDF」统一入口（2026-10-16）**：Electron 原生打印管线（隐藏窗口 `webContents.printToPDF`），Writer/Sheet/Presentation 三模块「文件 → 导出 PDF」真实可用；纯函数打印 HTML 生成（`docToPrint` 复用 `jkToHtml` / `sheetToHtml` / `presentationToHtml`）+ 纸张规格单一事实源 `shared/pdfPrint.ts`；零新依赖。实测坑：`printToPDF.pageSize` 单位为**英寸**（非微米），且 `landscape` 对本路径无效 → 用 `preferCSSPageSize` + `@page size` 决定纸张朝向。自动化验收 `scripts/pdf-export-smoke.mjs`
- ✅ Sheet 单元格格式对话框（数字格式/边框/对齐集合 UI，2026-10-15）
- ✅ **Sheet 打印设置对话框（2026-10-16）**：纸张（A4/A3/B5/Letter/Legal，取自 `PAGE_SIZE_MM` 单一事实源）/ 方向 / 页边距 / **打印区域**（A1 记法，可「用当前选区」）/ **重复标题行**（渲染为 `<thead>`，跨页重复）/ 仅打印活动表；localStorage `jk-sheet-print-v1` 持久化，「导出 PDF」按设置出纸。打印区域与重复行**仅作用于活动工作表**；不传设置时打印输出零回归。
- ⬜ 待排期：WPS 级精确分页（当前为 CSS 流式分页）、打印缩放比例/每页页数/「分页预览」

### 批 3（Phase 3 收尾）
- Presentation 动画与切换（T3.3）+ 表格 + 备注
- Sheet 查找替换 + 图表（T2.5，柱/折/饼，选区→PNG）

### 批 4（v1 收尾）✅ 2026-10-15
- ✅ 批注（Writer）、✅ 修订 track changes（Writer）、✅ 数据透视表（Sheet）、✅ 母版/版式（演示）
- ⬜ 宏实现（JS 宏沙箱，方案见 docs/macros.md，v2 候选）

## 原则

1. **Univer/TipTap 自带能力优先**（工具栏/右键已覆盖大量 WPS 功能，补的是入口显性化与 UI 缺口）
2. **每批必须可自动化验收**（GUI 冒烟/单测），不引入「人工才算完成」的项
3. **不做 WPS 的云服务耦合功能**（云文档/协作）——与 spec 的单机优先一致

### 公式 / 填充 / 宏（2026-10-15 用户点名 → 专项）

- ✅ **Writer 公式（已落地）**：`packages/writer/src/omml.ts` 线性公式 → OMML（支持 ±×÷、^ 上标、a/b 分数、sqrt 根号、括号、隐式乘法、多字符函数名）；模型加 `formula` 行内元素，导出为 `m:oMath` 原生公式（Word/WPS 打开后可编辑），解析保真回读；编辑器「插入公式」对话框（实时语法校验，**不用 window.prompt** —— 原生弹窗阻断自动化）；OMML 生成器 + docx 往返单测（writer 32/32）+ gui-smoke 端到端断言。矩阵/方程组/积分上下限排 W-P2
- ✅ **Sheet 填充**：Univer core preset 自带填充柄（拖拽右下角填充序列/复制），无需自研——**已覆盖**，待真实 Excel/WPS 大表人工验收
- 🟡 **宏**：方案定稿 `docs/macros.md`——JS 宏 + Worker 沙箱（VBA 运行时否决：Electron 生态不成熟）；jk API 白名单（getText/setText/findReplace/applyOps/sheet.*/log）、宏文件存 userData/macros、显式点击运行。实现排入批4

### PDF 卖点显性化 + 布局瘦身（2026-10-15，用户反馈直达）

- ✅ **PDF 工具升级为功能区一级标签页**（原藏在「文件」标签下）：新增 `PDF 工具` 标签，五个组对标 WPS PDF / Acrobat——转换（PDF转Word/Excel/PPT/图片/TXT）、Office 转 PDF（Word/Excel/PPT/图片转PDF）、页面编辑（合并/拆分/提取/删除/旋转/插入/替换）、安全与美化（加密/移除密码/水印/页眉页脚/压缩）、阅读与批注（打开/全文搜索/批注/OCR），并保留「PDF 工具箱」总入口。
  - **已实现 6 个页面操作 + 图片转 PDF**：合并、拆分、提取、删除、旋转、插入、替换（`@jareking/pdf` 的 mergePdfs/extractPages/deletePages/rotatePages/insertPages/replacePages/imagesToPdf）；点击直达工具箱对应模式（`uiStore.pdfToolboxMode`）。
  - **待排期**：PDF↔Office 转换（PDF转Word/Excel/PPT、Word/Excel/PPT转PDF，需本机 Office/WPS COM 或自研转换管线）、加密、移除密码、水印、页眉页脚、压缩（需 pdf.js 渲染层）、阅读器与 OCR（T5.1）——点击给出「功能建设中」提示。
- ✅ **布局瘦身（文档区最大化）**：
  - 移除 WriterEditor 自带的 `h-10` 重复工具栏与 EditorArea 的 `h-10` 文档头（共 ~80px），全部能力上收功能区（新增命令总线 `stores/editorCommands.ts`：编辑器挂载时注册 `font-family/font-size/font-color/bold/.../save` 等 30 条命令，Ribbon 经 `runEditorCommand` 驱动、经 `useEditorRevision` 订阅实时激活态与控件取值）。
  - AI 面板默认收起（`uiStore.aiPanelOpen` 默认 false，横向空间还给文档；可从 TabBar 的 Sparkles 按钮随时展开）。
  - 新增缩放：Ribbon「视图」放大/缩小/100% + 状态栏右侧 `− / 百分比(点击重置 100%) / +`（`uiStore.writerZoom`，钳制 50%~200%）；纸张区用 `transform: scale()` + 包裹层尺寸同步实现（不用 CSS zoom，避免 ProseMirror 坐标错乱）。
  - 纸张区内边距收紧（外层 `p-8 → p-5`、纸张 `px-16 py-16 → px-12 py-10`）；功能区标签行支持双击折叠（Ctrl+F1 保留）。
- **禁止 `window.prompt`**：超链接输入改为 Modal + Input（原生弹窗会阻断 Electron CDP 自动化，见公式对话框同款写法）；确认按钮文案用「应用」避免与公式对话框的「插入」冲突。
