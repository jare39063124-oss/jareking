# jareking - 免费 WPS 替代品（洁净室重写）

## Overview
- **Summary**: jareking 是一款免费、开源的桌面办公套件，以洁净室（clean-room）方式重写，提供类 WPS 的用户体验，覆盖电子表格、文字处理、演示文稿、PDF 四大模块，兼容 Office 开放格式。
- **Purpose**: 为用户提供一个无需会员、无广告、数据完全本地可控的办公套件替代方案。
- **Target Users**: 需要免费办公软件、重视数据隐私、习惯 WPS 操作习惯的个人与团队用户。

## Goals
- 提供类 WPS 的 Ribbon 界面与操作习惯，降低用户迁移成本
- 四大模块（表格/文字/演示/PDF）统一在一个桌面应用中
- 兼容 Office 格式（.xlsx / .docx / .pptx / .pdf）
- 完全本地运行，无云端依赖，无广告，无会员
- 模块化架构，每个模块可独立演进

## Non-Goals
- 不与 WPS 进行 100% 像素级 UI 复刻（仅操作习惯与核心布局对齐）
- MVP 阶段不追求 WPS 全功能对等（如宏、复杂图表、协作编辑）
- 不引入 WPS 或任何商业办公软件的专有代码
- 不做云端同步或账号系统
- 不做移动端

## Background & Context
- 参考项目 `robbietilton/compositor`：以洁净室方式从零重写 Photoshop 替代软件，证明"从零重写商业软件替代品"在法律与技术上可行
- 参考工具 `morluto/rea`：用于理解 WPS 的交互行为与文件格式处理逻辑（仅用于理解原理，不复制代码）
- 关键技术决策：不使用 Univer/OnlyOffice 等成品办公引擎，而是自研编辑内核 + 开源解析库（仅做文件 I/O），保持"洁净室"纯度
- 环境约束：Windows + Node.js v25 + npm 11，无 Rust 工具链，故选用 Electron 而非 Tauri

## Functional Requirements

### 应用骨架
- **FR-1**: 启动后显示 WPS 风格起始页（最近文件、新建模板、模块入口）
- **FR-2**: 顶部 Ribbon 工具栏，根据当前模块切换功能区
- **FR-3**: 多标签文档管理，支持同时打开多个文档
- **FR-4**: 统一文件操作：新建、打开、保存、另存为（通过 Electron 本地文件对话框）
- **FR-5**: 模块化注册机制，四大模块通过统一接口挂载

### 电子表格模块（Spreadsheets）— MVP 核心
- **FR-6**: Canvas 渲染的电子表格网格，支持滚动（行列均可达 1000+）
- **FR-7**: 单元格编辑（双击或 F2 进入编辑模式，Enter 确认，Esc 取消）
- **FR-8**: 单元格选择（单击、拖拽区域、整行/整列选择）
- **FR-9**: 基础公式引擎（SUM, AVERAGE, MIN, MAX, COUNT, IF 等常用函数）
- **FR-10**: 单元格格式化（字体、字号、粗体、斜体、下划线、文字颜色、背景色、对齐方式）
- **FR-11**: 行高列宽调整（拖拽边界）
- **FR-12**: .xlsx 文件导入（读取单元格值、公式、基础格式）
- **FR-13**: .xlsx 文件导出（保存单元格值、公式、基础格式）

### 文字处理模块（Writer）— v0.2
- **FR-14**: 富文本编辑（字体、段落、列表、对齐）
- **FR-15**: .docx 导入与导出

### 演示文稿模块（Presentation）— v0.3
- **FR-16**: 幻灯片编辑（文本框、形状、图片）
- **FR-17**: .pptx 导入与导出

### PDF 模块 — v0.4
- **FR-18**: PDF 阅读（翻页、缩放）
- **FR-19**: PDF 基础标注（高亮、批注）

## Non-Functional Requirements
- **NFR-1**: 应用冷启动时间 ≤ 3 秒（Electron 常规范围）
- **NFR-2**: 电子表格 1000×1000 单元格滚动帧率 ≥ 30fps
- **NFR-3**: .xlsx 导入 1000 行数据 ≤ 2 秒
- **NFR-4**: 所有数据存储在本地，不上传任何服务器
- **NFR-5**: 代码使用 TypeScript，核心模块单元测试覆盖率 ≥ 70%
- **NFR-6**: 界面遵循 Fluent Design 风格，中文界面

## Constraints
- **Technical**: Electron + React + TypeScript + Vite；解析库使用 ExcelJS（.xlsx 读写，含样式，MIT 协议；注意：SheetJS 免费版不支持样式读写，故弃用）、docx（.docx）；pptxgenjs 仅支持 .pptx 导出，导入方案留待 v0.3 决策（可评估 JSZip 手写解析）；PDF 使用 pdfjs-dist
- **Testing**: Vitest 作为单元测试框架（支撑 NFR-5 覆盖率要求）
- **Business**: 必须洁净室实现，不复制 WPS 或其他商业软件代码；开源协议 MIT
- **Dependencies**: Node.js ≥ 22, npm, Electron, 各解析库

## Assumptions
- 用户在 Windows 环境运行
- 用户已安装 WPS 或熟悉 WPS 操作，期望相似体验
- 开源解析库（SheetJS 等）的许可证允许商业/非商业使用
- MVP 阶段只需表格模块可用，其他模块以占位入口形式存在并预留扩展

## Acceptance Criteria

### AC-1: 应用可启动并显示起始页
- **Type**: `rule`
- **Given**: 已安装 jareking
- **When**: 用户双击启动应用
- **Then**: 3 秒内显示主窗口，包含起始页（最近文件列表、新建按钮、四大模块入口）
- **Pass Condition**: 应用启动无崩溃，起始页正确渲染
- **Evidence**: 启动截图 + 控制台无错误日志

### AC-2: 电子表格网格渲染与交互
- **Type**: `rule`
- **Given**: 用户新建电子表格
- **When**: 表格视图加载完成
- **Then**: 显示行列网格，可点击选中单元格，可双击编辑内容
- **Pass Condition**: 单元格选中高亮、编辑内容可保存到单元格
- **Evidence**: 交互操作录屏或截图序列

### AC-3: 公式计算正确
- **Type**: `rule`
- **Given**: 单元格 A1=10, A2=20, A3=SUM(A1:A2)
- **When**: 公式输入完成
- **Then**: A3 显示 30；修改 A1 为 5 后 A3 自动更新为 25
- **Pass Condition**: 公式结果正确且随引用单元格变化自动重算
- **Evidence**: 公式测试用例输出

### AC-4: .xlsx 导入导出往返一致
- **Type**: `rule`
- **Given**: 用户创建表格并输入数据与公式
- **When**: 保存为 .xlsx 后重新打开
- **Then**: 数据、公式结果、基础格式（字体/颜色/对齐）保持一致
- **Pass Condition**: 导入后单元格值与公式结果与保存前相同
- **Evidence**: 往返测试用例输出

### AC-5: Ribbon 工具栏功能可用
- **Type**: `rule`
- **Given**: 电子表格处于活动状态
- **When**: 用户在 Ribbon 点击粗体、字号、背景色等按钮
- **Then**: 选中单元格的格式相应改变
- **Pass Condition**: 格式按钮改变选中区域的视觉样式
- **Evidence**: 格式操作截图

### AC-6: 模块切换与多标签
- **Type**: `rule`
- **Given**: 用户已打开一个表格文档
- **When**: 新建一个文字文档
- **Then**: 出现新标签页，Ribbon 切换为文字模块功能区，可在标签间切换
- **Pass Condition**: 多标签共存且状态独立
- **Evidence**: 多标签操作截图

### AC-7: 类 WPS 操作习惯
- **Type**: `rubric`
- **Dimension**: 操作习惯与 WPS 的相似度
- **Scale**: 1-5
- **Anchors**: 1 = 完全不同；3 = 核心操作（选中、编辑、保存）一致；5 = Ribbon 布局、快捷键、菜单结构高度一致
- **Pass Threshold**: >= 3
- **Evidence**: WPS 与 jareking 界面对比截图

### AC-8: 无网络依赖
- **Type**: `rule`
- **Given**: 断开网络连接
- **When**: 用户使用所有核心功能
- **Then**: 功能正常，无网络请求失败提示
- **Pass Condition**: 断网下新建/编辑/保存均正常
- **Evidence**: 断网测试日志

## Open Questions
- [ ] 是否需要支持 WPS 特有格式（.et / .wps / .dps）？MVP 阶段仅支持 Office 开放格式
- [ ] 快捷键方案：完全对齐 WPS 还是采用通用办公软件快捷键？
- [ ] 是否需要深色模式？
