# jareking 宏（Macro）方案 —— 对齐 WPS 宏/VBA

> 状态：**方案定稿，v1 实现排入批4**（2026-10-15）
> 定位：WPS 宏是 VBA；jareking 是个人开发者 + Electron，不可能有 VBA 运行时，
> 对齐目标定为「**可自动化的批处理能力**」而非语法兼容。

## 1. 方案选型：JS 宏沙箱（Worker 隔离）

| 方案 | 结论 |
|---|---|
| VBA 兼容引擎（如 vb.js 类项目） | 生态不成熟、体积大、Electron 集成脆弱——否决 |
| **JS 宏 + Worker 沙箱** | ✅ 采纳：与 Electron/前端同栈、Worker 天然隔离崩溃、宏 API 可精确授权 |
| 录制宏 | v2：先做脚本宏，录制依赖事件埋点，后置 |

## 2. v1 范围（批4 实现）

- **宏编辑器**：工具栏「宏」入口 → Modal/面板（代码编辑 + 运行 + 输出日志）
- **执行环境**：独立 Worker（复用 #46-C 的 worker 基建），**无 DOM / 无 Node API**；
  宏只能通过 `jk` 白名单 API 触达文档，超时（默认 10s）与内存上限由 Worker 侧约束
- **jk API（v1）**：
  ```js
  jk.getText()                 // 全文
  jk.setText(t)                // 覆盖全文
  jk.appendText(t)
  jk.findReplace(a, b, opts)   // 查找替换（复用 findReplace.ts）
  jk.getSelection() / jk.replaceSelection(t)
  jk.applyOps(ops)             // 复用 writer ops（格式/表格/分页等）
  jk.sheet.getCellText(a1) / jk.sheet.setValues(a1, matrix)
  jk.log(...)                  // 输出到宏日志面板
  ```
- **宏存储**：`userData/macros/*.jk.js`（设置区管理：新建/重命名/删除/导出）
- **安全边界**：宏仅能操作当前文档数据 + 调 jk API；不读文件（v1）、不发网络；
  运行前用户显式点击（不自动执行）

## 3. 与 WPS 的对齐口径（诚实说明）

| 能力 | WPS | jareking v1 |
|---|---|---|
| 自定义自动化 | VBA | JS 宏（Worker 沙箱） |
| Excel 式工作表函数 | ✓ | ✓（Univer 400+ 函数） |
| 录制宏 | ✓ | ✗ v2 |
| VBA 语法兼容 | — | ✗ 不提供（说明文档明示差异） |

## 4. 待实现清单（批4）

- [ ] `macroRunner.ts`：Worker 沙箱 + jk API 桥（消息协议）
- [ ] 宏编辑器面板（代码框 + 运行 + 日志 + 超时/取消）
- [ ] 宏文件管理（新建/保存/删除/列出）+ 设置区入口
- [ ] API 单测（jk.sheet/jk.findReplace 覆盖）+ 冒烟断言（运行示例宏改文档）
- [ ] 文档：用户手册「宏」章节（API 表 + 示例）