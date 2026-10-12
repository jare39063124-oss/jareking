# @jareking/core

核心库：契约、本地数据库、账户积分、文档库。

## 约定

- ESM 输出，**相对导入必须带 `.js` 扩展名**（如 `import { x } from './db/index.js'`），保证 Node ESM 运行时可解析
- 禁止引入需要原生编译的依赖（用 sql.js 而非 better-sqlite3 的原因）
- 新模块先加 TypeScript 接口契约到 `src/contracts/`，再写实现（接口契约先行）
- 测试用 vitest，与被测文件同目录或 `test/` 下，命名 `*.test.ts`

## 结构

```
src/
├── contracts/    # 跨模块接口契约（禁止随意变更，变更走编排 Agent）
├── db/           # SQLite（sql.js WASM）封装与迁移（T0.4）
├── account/      # 本地账户 + 积分流水（T0.4 / T6.1）
└── library/      # 文档库：最近文件 / 自动保存 / 崩溃恢复（T0.4）
```
