# jareking 验收清单

## 验收标准验证

### AC-1: 四大模块入口（表格/文字/演示/PDF）
- [x] 起始页显示四个模块卡片
- [x] 点击卡片打开对应模块视图
- [x] 表格模块为完整实现，其余为占位

### AC-2: 电子表格编辑（单元格输入、选择、编辑）
- [x] Canvas 渲染网格，虚拟滚动
- [x] 点击选中单元格，拖拽选区域
- [x] 双击编辑，Enter/Tab/Esc 操作
- [x] 数字识别（Number 转换）

### AC-3: 公式计算（SUM/AVERAGE/IF 等）
- [x] 公式引擎支持 SUM/AVERAGE/MIN/MAX/COUNT/IF/ROUND/ABS
- [x] 循环引用检测
- [x] 错误值 #DIV/0!/#VALUE!/#REF!/#NAME?/#N/A
- [x] 编辑后重算依赖链

### AC-4: .xlsx 导入导出
- [x] 导出 WorkbookModel → ExcelJS → .xlsx
- [x] 导入 .xlsx → WorkbookModel（值/公式/样式）
- [x] 基础样式往返一致（字体/颜色/对齐）

### AC-5: 基础格式化（粗体/斜体/颜色/对齐）
- [x] Ribbon 工具栏：粗体/斜体/下划线/文字颜色/填充色/对齐
- [x] 格式刷功能
- [x] Canvas 正确渲染样式

### AC-6: 快捷键支持
- [x] Ctrl+Z/Y 撤销重做
- [x] Ctrl+C/V/X 复制粘贴剪切
- [x] Ctrl+B/I/U 粗体斜体下划线
- [x] Ctrl+S/O/Shift+S 保存/打开/另存为
- [x] Delete 清除

### AC-7: 文件操作（新建/打开/保存/另存为）
- [x] 新建文档标签
- [x] 打开 .xlsx 文件
- [x] 保存/另存为
- [x] 最近文件列表持久化

### AC-8: 应用打包
- [x] electron-builder 配置
- [x] `npm run dist` 产出 Windows 安装包
- [x] `release/win-unpacked/jareking.exe` 生成成功

### AC-9: 测试覆盖率 ≥70%（核心模块）
- [x] model 模块覆盖率 88.93%
- [x] formula 模块覆盖率 75.77%
- [x] io 模块覆盖率 89.36%
- [x] 总计 43 个测试全部通过

### NFR-1: 本地运行无云端依赖
- [x] 纯 Electron 桌面应用，无网络请求

### NFR-2: MIT 协议
- [x] package.json license: MIT

### NFR-3: 不使用成品办公引擎
- [x] 自研编辑内核（Canvas + 数据模型 + 公式引擎）
- [x] ExcelJS 仅用于文件 I/O

### NFR-5: 测试覆盖率 ≥70%
- [x] 核心模块达标

## 验证命令
```bash
npm run build          # 构建成功
npx vitest run         # 43 tests passed
npx vitest run --coverage  # 核心模块 ≥70%
npm run dist:dir       # 产出 jareking.exe
```
