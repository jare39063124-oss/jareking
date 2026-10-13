# jareking

> WPS 平替办公套件：Writer / Sheet / Presentation / PDF 全格式兼容 + 用户自配 API 的 AI 助手。
> Windows 10/11（x64）单平台 · Electron + React + TypeScript

## 文档

- 产品规格：[`docs/spec.md`](docs/spec.md)（v1.1）
- 开发 Todolist：[`docs/todo.md`](docs/todo.md)（Phase 0-8）
- 使用说明书：[`docs/manual.md`](docs/manual.md)（功能与操作指南）

## 目录结构

```
jareking/
├── apps/
│   └── desktop/          # Electron 桌面应用（主进程 / 预加载 / 渲染进程）
├── packages/
│   ├── core/             # 核心库：契约、本地数据库、账户积分、文档库
│   ├── ai/               # AI 适配层（Phase 4 实施，当前仅接口契约）
│   └── server/           # 云端服务（v1 预留，不部署）
└── docs/                 # Spec 与 Todolist
```

## 快速开始

```bash
# 安装依赖（首次约需下载 Electron 二进制）
corepack pnpm install

# 开发模式（先构建 core/ai，再启动 electron-vite dev）
corepack pnpm dev

# 类型检查 / 构建
corepack pnpm typecheck
corepack pnpm build

# 测试
corepack pnpm test
```

## 已实现功能（痛点攻坚批次）

- **Writer 排版工具箱**（离线、本地确定性执行，零成本）：一键整理、千分符、四套格式模板（政府公文 GB/T 9704 / 毕业论文 / 通用报告 / 商务汇报）、参考文档格式克隆
- **AI 自然语言助手**：用户自配任意 BaseURL+Key（OpenAI 兼容 / Claude / Gemini / Ollama），自带 Key 不扣积分、DPAPI 加密存储；LLM-as-Planner 规划操作、本地 Executor 确定性落地
- **AI 数据可视化**：自然语言触发插入柱状/折线/饼图（自绘 PNG，零依赖）
- **存储透明**：设置面板「存储管理」展示数据位置与占用，无云副本无隐藏缓存
- 四大模块（Writer / Sheet / Presentation / PDF）基础能力 + Sheet/PPT AI

详见 [`docs/manual.md`](docs/manual.md)。

## 当前进度

- [x] 需求澄清 + Spec v1.1（待审批记录见 docs/spec.md 第 11 章）
- [x] Phase 0 脚手架（monorepo / Electron 壳 / 契约）
- [ ] Phase 0 收尾（UI 框架 / 设计系统 / 本地持久层 / 桌面能力 / CI）

## 实现说明（与 Spec 的偏差记录）

- TypeScript 固定 `^5.9.3`（TS 7 太新，生态工具链未跟上）
- React 使用 `^19.3`（当前稳定版，Spec 初稿写 18）
- 本地数据库用 `sql.js`（SQLite WASM 版，避免原生模块在 Electron 下的构建问题）
- ESLint 暂缓，Phase 8 统一补
