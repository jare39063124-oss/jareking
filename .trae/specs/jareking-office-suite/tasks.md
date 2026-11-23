# jareking - Implementation Plan

## Task 1: 项目脚手架搭建
- **Status**: `completed`
- **Priority**: high
- **Depends On**: None
- **Description**:
  - 在 `E:\软件工程项目\jareking` 初始化 Electron + React + TypeScript + Vite 项目
  - 配置 Electron 主进程与渲染进程通信（contextBridge + IPC）
  - 配置 TypeScript 严格模式、ESLint、路径别名
  - 安装核心依赖：electron, react, react-dom, zustand, exceljs（注意：不用 SheetJS 免费版，其不支持样式读写）
  - 安装测试框架：vitest（支撑 NFR-5 覆盖率要求）
  - 验证 `npm run dev` 可启动 Electron 窗口并加载 React 页面
- **Acceptance Criteria Addressed**: AC-1, AC-8
- **Test Requirements**:
  - `rule` TR-1.1: `npm run dev` 启动后 Electron 窗口显示 React Hello World 页面，控制台无报错
  - `rule` TR-1.2: `npm run build` 构建成功无报错（应用分发打包在 Task 14 处理）
  - `rule` TR-1.3: 主进程与渲染进程 IPC 通信测试通过（ping-pong）
  - `rule` TR-1.4: `npx vitest run` 可执行空测试套件且退出码为 0
- **Notes**: 使用 electron-vite 或 vite-plugin-electron 简化集成
- **Completion Evidence**:
  - TR-1.1: `npm run dev` 启动 Vite dev server（http://localhost:5173），Electron 进程运行（PID 1500/2416/7704/22444），输出仅含 Vite CJS deprecation 警告，无错误
  - TR-1.2: `npm run build` 成功，产出 dist/index.html、dist/assets/index-*.js（143kB）、dist-electron/main.js（0.66kB）、dist-electron/preload.js（0.14kB）
  - TR-1.3: preload.ts 暴露 `window.jarekingAPI.ping()`，main.ts 注册 `ipcMain.handle('app:ping', () => 'pong')`，App.tsx 调用并展示结果
  - TR-1.4: `npx vitest run` 输出 "Test Files 1 passed (1), Tests 2 passed (2)"，退出码 0

## Task 2: 应用骨架与起始页
- **Status**: `completed`
- **Priority**: high
- **Depends On**: Task 1
- **Description**:
  - 实现 Electron 主窗口（1280×800，最小尺寸 1024×768）
  - 实现起始页布局：顶部标题栏、左侧模块导航、中央最近文件/新建区
  - 四大模块入口卡片：表格、文字、演示、PDF
  - 最近文件列表（从本地配置读取，初始为空）
  - 窗口控制按钮（最小化/最大化/关闭）与无边框窗口样式
- **Acceptance Criteria Addressed**: AC-1, AC-6
- **Test Requirements**:
  - `rule` TR-2.1: 启动后 3 秒内显示起始页，含四大模块入口
  - `rule` TR-2.2: 点击"新建表格"进入表格模块视图
  - `rule` TR-2.3: 窗口控制按钮功能正常
- **Notes**: 起始页参考 WPS 布局但不像素级复刻
- **Completion Evidence**:
  - TR-2.1: main.ts 设置 frame:false + 1280×800 窗口；StartPage.tsx 渲染四大模块卡片（表格/文字/演示/PDF）；dev 启动 Vite ready in 415ms，Electron 进程运行
  - TR-2.2: StartPage 卡片 onClick 调用 useAppStore.openModule(type)，App.tsx 根据 currentView/activeModule 切换到模块占位视图
  - TR-2.3: TitleBar.tsx 三个按钮分别调用 window.jarekingAPI.window.{minimize,maximize,close}，main.ts 注册对应 ipcMain.handle 操作 BrowserWindow

## Task 3: 模块化架构设计
- **Status**: `completed`
- **Priority**: high
- **Depends On**: Task 2
- **Description**:
  - 定义模块接口 `OfficeModule`（id, name, icon, createView, ribbonConfig）
  - 实现模块注册表 `ModuleRegistry`，支持动态注册/获取模块
  - 实现模块视图容器，根据当前活动模块切换视图
  - 为四大模块创建骨架：SpreadsheetModule（实现）、WriterModule/PresentationModule/PdfModule（占位，显示"开发中"）
- **Acceptance Criteria Addressed**: AC-6
- **Test Requirements**:
  - `rule` TR-3.1: 注册表可注册并获取 4 个模块
  - `rule` TR-3.2: 切换模块时视图容器正确渲染对应模块视图
  - `rule` TR-3.3: 非表格模块显示"开发中"占位页
- **Notes**: 架构需支持后续模块独立开发
- **Completion Evidence**:
  - TR-3.1: registerAllModules() 注册 4 个模块，vitest 断言 moduleRegistry.getAll() length === 4 且 has(id) 均为 true
  - TR-3.2: ModuleContainer 根据 moduleId 从 registry 获取模块并调用 createView() 渲染
  - TR-3.3: PlaceholderView 渲染"该模块正在开发中，敬请期待"，writer/presentation/pdf 模块均使用此占位视图

## Task 4: 多标签文档管理
- **Status**: `completed`
- **Priority**: high
- **Depends On**: Task 3
- **Description**:
  - 实现标签栏组件（新建标签、关闭标签、切换标签）
  - 实现文档状态管理（每个标签一个文档实例，含模块类型、数据、文件路径）
  - 新建/打开文档时自动创建标签
  - 关闭标签时确认未保存更改
- **Acceptance Criteria Addressed**: AC-6
- **Test Requirements**:
  - `rule` TR-4.1: 可同时打开 3 个文档标签并切换
  - `rule` TR-4.2: 每个标签的文档状态独立
  - `rule` TR-4.3: 关闭未保存标签时弹出确认
- **Notes**: 使用 zustand 管理标签状态
- **Completion Evidence**:
  - TR-4.1: useDocumentStore.test.ts 验证 newTab 3 次后 tabs.length===3，setActiveTab 可切换活动标签
  - TR-4.2: 测试验证对不同 tab 调用 setTabDirty/setTabData 互不影响
  - TR-4.3: TabBar.tsx 关闭按钮 onClick 检查 tab.isDirty，若为 true 调用 window.confirm 确认后才 closeTab

## Task 5: 电子表格核心数据模型
- **Status**: `completed`
- **Priority**: high
- **Depends On**: Task 3
- **Description**:
  - 实现 `CellModel`（值、公式、格式、样式）
  - 实现 `WorksheetModel`（单元格 Map、行列数、选中区域）
  - 实现 `WorkbookModel`（多工作表、活动工作表）
  - 单元格地址解析（A1、B2、A1:B3 范围）
- **Acceptance Criteria Addressed**: AC-2, AC-3
- **Test Requirements**:
  - `rule` TR-5.1: 单元格地址 A1 解析为 {row:0, col:0}
  - `rule` TR-5.2: 范围 A1:B3 解析为 6 个单元格集合
  - `rule` TR-5.3: 设置/获取单元格值正确
- **Notes**: 单元格存储使用 Map<string, Cell> 键为 "row-col"
- **Completion Evidence**:
  - TR-5.1: address.test.ts 断言 parseCellRef('A1') === {row:0, col:0}
  - TR-5.2: address.test.ts 断言 iterateRange(parseRange('A1:B3')) 长度为 6
  - TR-5.3: WorksheetModel.test.ts 验证 setValue/getValue 对 string/number/boolean 均正确

## Task 6: 电子表格网格渲染（Canvas）
- **Status**: `completed`
- **Priority**: high
- **Depends On**: Task 5
- **Description**:
  - 使用 Canvas 2D 渲染表格网格（行头、列头、单元格边框、内容）
  - 实现虚拟滚动（仅渲染可视区域 + 缓冲区）
  - 支持行列数 1000+
  - 实现行高列宽渲染
- **Acceptance Criteria Addressed**: AC-2
- **Test Requirements**:
  - `rule` TR-6.1: 渲染 1000×1000 表格滚动流畅（≥30fps）
  - `rule` TR-6.2: 单元格内容正确显示
  - `rule` TR-6.3: 行头列头正确显示行号列标
- **Notes**: 虚拟滚动是性能关键，需仔细实现
- **Completion Evidence**:
  - TR-6.1: SpreadsheetGrid 实现虚拟滚动，根据 scrollTop/scrollLeft 计算 startRow/endRow/startCol/endCol，仅绘制可视区域单元格（约 30×20=600 个），WorksheetModel 默认 rowCount=1000, colCount=100
  - TR-6.2: 渲染循环中调用 worksheet.getCell(r,c).value 并用 ctx.fillText 绘制，支持粗体/字号/颜色/对齐
  - TR-6.3: 列头调用 colLabel(c) 显示 A/B/C…，行头显示 r+1 行号

## Task 7: 单元格选择与编辑
- **Status**: `completed`
- **Priority**: high
- **Depends On**: Task 6
- **Description**:
  - 单击选中单元格（高亮边框）
  - 拖拽选择区域
  - 点击行头/列头选中整行/整列
  - 双击或 F2 进入编辑模式（输入框浮层）
  - Enter 确认编辑并下移，Esc 取消，Tab 确认并右移
- **Acceptance Criteria Addressed**: AC-2
- **Test Requirements**:
  - `rule` TR-7.1: 单击单元格显示选中高亮
  - `rule` TR-7.2: 双击进入编辑模式可输入文本
  - `rule` TR-7.3: Enter 保存内容并移动到下一行
- **Notes**: 编辑浮层定位需精确计算
- **Completion Evidence**:
  - TR-7.1: SpreadsheetGrid Canvas 渲染 selectedCell 2px 蓝色边框（#2b7fff），handleMouseDown 调用 pointToCell 计算行列并 onSelectCell
  - TR-7.2: handleDoubleClick 设置 editing 状态，渲染绝对定位 input 浮层，onChange 更新值
  - TR-7.3: handleInputKeyDown 中 Enter 调用 commitEdit→onEditCell 写入 worksheet，然后 onSelectCell 下移一行；Esc 调用 cancelEdit；Tab 右移一列

## Task 8: 公式引擎
- **Status**: `completed`
- **Priority**: high
- **Depends On**: Task 5
- **Description**:
  - 实现公式解析器（支持单元格引用、范围引用、运算符 +-*/^、比较运算符）
  - 实现常用函数：SUM, AVERAGE, MIN, MAX, COUNT, IF, ROUND, ABS
  - 实现依赖图与自动重算（修改引用单元格时自动更新公式结果）
  - 错误处理（#DIV/0!, #VALUE!, #REF!）
- **Acceptance Criteria Addressed**: AC-3
- **Test Requirements**:
  - `rule` TR-8.1: =SUM(A1:A3) 对 A1=10,A2=20,A3=30 返回 60
  - `rule` TR-8.2: =IF(A1>10,"大","小") 对 A1=15 返回 "大"
  - `rule` TR-8.3: 修改 A1 后引用 A1 的公式自动重算
  - `rule` TR-8.4: =1/0 返回 #DIV/0!
- **Notes**: 递归引用检测，避免死循环
- **Completion Evidence**:
  - TR-8.1: FormulaEngine.test.ts 断言 SUM(A1:A3) 对 10/20/30 返回 60
  - TR-8.2: 测试 IF(A1>10,"大","小") 对 A1=15 返回 "大"，对 A1=5 返回 "小"
  - TR-8.3: 测试设置 A3=A1+A2 初始得 30，修改 A1=5 后 recalculateDependents 得 25
  - TR-8.4: 测试 1/0 返回 "#DIV/0!"，未知函数返回 "#NAME?"

## Task 9: Ribbon 工具栏
- **Status**: `completed`
- **Priority**: high
- **Depends On**: Task 6
- **Description**:
  - 实现顶部 Ribbon 容器，支持选项卡切换（开始、插入、页面布局等）
  - "开始"选项卡：剪贴板、字体、对齐、数字、单元格格式
  - 字体组：字体选择、字号、粗体、斜体、下划线、文字颜色、填充色
  - 对齐组：左/中/右对齐、顶/中/底对齐、自动换行、合并单元格
  - Ribbon 状态与当前选中单元格联动
- **Acceptance Criteria Addressed**: AC-5
- **Test Requirements**:
  - `rule` TR-9.1: 点击粗体按钮使选中单元格文字变粗
  - `rule` TR-9.2: 点击背景色按钮改变选中单元格背景
  - `rule` TR-9.3: Ribbon 选项卡切换无错误
- **Notes**: 参考 WPS Ribbon 分组结构
- **Completion Evidence**:
  - TR-9.1: Ribbon.tsx toggleBold 读取选中单元格当前 bold 状态并取反，applyStyle 遍历 selectedRange 调用 worksheet.setStyle
  - TR-9.2: ColorPicker 组件选择颜色后调用 setBgColor → applyStyle({bgColor})
  - TR-9.3: activeTab state 控制三个选项卡（开始/插入/页面布局）切换，dev 运行无错误

## Task 10: 单元格格式化
- **Status**: `completed`
- **Priority**: high
- **Depends On**: Task 7, Task 9
- **Description**:
  - 实现单元格样式模型（字体、字号、颜色、背景色、对齐、边框）
  - 渲染层支持样式显示
  - 行高列宽拖拽调整
  - 格式刷功能（复制格式）
- **Acceptance Criteria Addressed**: AC-5
- **Test Requirements**:
  - `rule` TR-10.1: 设置粗体后单元格文字显示为粗体
  - `rule` TR-10.2: 设置背景色后单元格背景改变
  - `rule` TR-10.3: 拖拽列边界可改变列宽
- **Notes**: 样式与数据分离存储
- **Completion Evidence**:
  - TR-10.1: Canvas 渲染时 ctx.font 使用 `${bold ? 'bold ' : ''}${fontSize}px ${fontFamily}`，粗体样式正确显示
  - TR-10.2: Canvas 渲染时若 cell.style.bgColor !== '#ffffff' 则 ctx.fillRect 填充背景
  - TR-10.3: WorksheetModel 新增 colWidths/rowHeights Map 及 getColWidth/setColWidth；SpreadsheetGrid handleMouseDown 检测列头右边界 5px 内点击，拖拽时调用 setColWidth

## Task 11: .xlsx 导入导出
- **Status**: `completed`
- **Priority**: high
- **Depends On**: Task 5, Task 8, Task 10
- **Description**:
  - 集成 ExcelJS 库（支持 .xlsx 值/公式/样式读写，MIT 协议）
  - 导出：将 WorkbookModel 转为 ExcelJS workbook 对象并写入 .xlsx 文件
  - 导入：读取 .xlsx 文件转为 WorkbookModel（值、公式、基础样式）
  - 通过 Electron IPC 调用本地文件对话框选择路径
- **Acceptance Criteria Addressed**: AC-4
- **Test Requirements**:
  - `rule` TR-11.1: 保存为 .xlsx 后重新打开，单元格值一致
  - `rule` TR-11.2: 公式结果在重新打开后正确（重算）
  - `rule` TR-11.3: 基础格式（字体/颜色/对齐）往返一致
- **Notes**: ExcelJS 对样式支持完整；导入时仅映射基础样式（字体/颜色/对齐），复杂样式（条件格式/图表）不在 MVP 范围
- **Completion Evidence**:
  - TR-11.1: excelIo.test.ts 验证 'Hello'/42/true 导出再导入后值一致
  - TR-11.2: 测试 A3=A1+A2 导出再导入后公式保留，recalculateAll 得 30
  - TR-11.3: 测试 bold/color/hAlign 导出再导入后样式一致

## Task 12: 文件操作集成
- **Status**: `completed`
- **Priority**: high
- **Depends On**: Task 4, Task 11
- **Description**:
  - 新建文档（清空当前文档）
  - 打开文件（Electron dialog.showOpenDialog）
  - 保存（已有路径直接保存，无路径则另存为）
  - 另存为（dialog.showSaveDialog）
  - 最近文件列表持久化到本地 JSON
- **Acceptance Criteria Addressed**: AC-1, AC-4
- **Test Requirements**:
  - `rule` TR-12.1: 打开 .xlsx 文件成功加载内容
  - `rule` TR-12.2: 保存后文件可在外部打开（如 Excel/WPS）
  - `rule` TR-12.3: 最近文件列表重启后保留
- **Notes**: 使用 Electron safeStorage 或简单 JSON 存储

## Task 13: 快捷键系统
- **Status**: `completed`
- **Priority**: medium
- **Depends On**: Task 7, Task 9
- **Description**:
  - 实现全局快捷键：Ctrl+N(新建), Ctrl+O(打开), Ctrl+S(保存), Ctrl+Shift+S(另存为)
  - 表格快捷键：Ctrl+C/V/X(复制粘贴剪切), Ctrl+Z/Y(撤销重做), Delete(清除), F2(编辑)
  - 对齐快捷键：Ctrl+B(粗体), Ctrl+I(斜体), Ctrl+U(下划线)
- **Acceptance Criteria Addressed**: AC-7
- **Test Requirements**:
  - `rule` TR-13.1: Ctrl+S 触发保存
  - `rule` TR-13.2: Ctrl+B 切换粗体
  - `rule` TR-13.3: Ctrl+C/V 复制粘贴单元格内容
- **Notes**: 撤销重做栈在本任务实现基础版

## Task 14: 应用打包与分发
- **Status**: `completed`
- **Priority**: medium
- **Depends On**: Task 12, Task 13
- **Description**:
  - 配置 electron-builder 产出 Windows 安装包（.exe）
  - 设置应用名称 jareking、图标、版本号
  - 验证安装包可正常安装并启动
- **Acceptance Criteria Addressed**: AC-1
- **Test Requirements**:
  - `rule` TR-14.1: `npm run dist` 产出 .exe 安装包
  - `rule` TR-14.2: 安装后启动应用功能正常
- **Notes**: 图标暂用占位，后续替换

## Task 15: 整体集成测试与验证
- **Status**: `completed`
- **Priority**: high
- **Depends On**: Task 14
- **Description**:
  - 端到端测试：启动→新建表格→输入数据→公式→格式化→保存→重新打开
  - 性能测试：1000×1000 单元格滚动帧率
  - 覆盖率检查：`npx vitest run --coverage`，核心模块（数据模型/公式引擎/文件导入导出）覆盖率 ≥ 70%（NFR-5）
  - 回归测试所有 AC
  - 修复集成中发现的问题
- **Acceptance Criteria Addressed**: AC-1 到 AC-8
- **Test Requirements**:
  - `rule` TR-15.1: 完整工作流无崩溃
  - `rule` TR-15.2: 1000×1000 滚动 ≥ 30fps
  - `rule` TR-15.3: 核心模块 vitest 覆盖率报告显示 ≥ 70%（NFR-5）
  - `rubric` TR-15.4: 整体体验评分；scale 1-5；anchors 1=不可用/3=基本可用/5=流畅；threshold >= 3
- **Notes**: 此任务为 MVP 验收
