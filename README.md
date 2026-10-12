# jareking

> WPS 平替办公套件：Writer / Sheet / Presentation / PDF 全格式兼容 + 用户自配 API 的 AI 助手。
> Windows 10/11（x64）单平台 · Electron + React + TypeScript

## 文档

- 产品规格：[`docs/spec.md`](docs/spec.md)（v1.1）
- 开发 Todolist：[`docs/todo.md`](docs/todo.md)（Phase 0-8）

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

## 当前进度

- [x] 需求澄清 + Spec v1.1（待审批记录见 docs/spec.md 第 11 章）
- [x] Phase 0 脚手架（monorepo / Electron 壳 / 契约）
- [ ] Phase 0 收尾（UI 框架 / 设计系统 / 本地持久层 / 桌面能力 / CI）

## 实现说明（与 Spec 的偏差记录）

- TypeScript 固定 `^5.9.3`（TS 7 太新，生态工具链未跟上）
- React 使用 `^19.3`（当前稳定版，Spec 初稿写 18）
- 本地数据库用 `sql.js`（SQLite WASM 版，避免原生模块在 Electron 下的构建问题）
- ESLint 暂缓，Phase 8 统一补
