# AGENTS.md — jareking 工程协作宪章（所有 AI / 开发者必读）

> 本文件是**强制标准**。任何模型（Claude / GPT / DeepSeek / Gemini …）或人接手本项目，
> **先读本文件**，再读 `docs/agent-guide.md`（详细说明书）、`docs/spec.md`（产品规格）、`docs/todo.md`（进度）。
> 目的：多模型/多会话协作时，接口与标准不漂移。
> 最近更新：2026-10-15。

## 0. 一句话

jareking = Windows 单平台的 **WPS 平替办公套件**（Writer / Sheet / Presentation / PDF + 可自配 AI），
技术栈 Electron + React 19 + TypeScript（严格）+ Tailwind + Zustand，pnpm workspace monorepo。

## 1. 铁律（违反 = 跑偏）

### 1.1 单一来源（Single Source of Truth）——**多模型协作最易搞坏，务必死守**
- 跨包共享的**类型 / 常量只允许定义一次**，别处一律 `import`；需要对外转发时用 `import` + `export type`。
- **契约类型**在 `packages/core/src/contracts/*.ts`（如 `DocModule` / `DocFormat` / `AiProviderKind`）。
  **不得**在别处重复定义。
- **文档模型**在各自包：`packages/writer|sheet|presentation/src/model/`（`JkDocument` / `JkWorkbook` / `JkPresentation` 及 `Jk*` 子类型）。
- **IPC 通道名**只允许在 `apps/desktop/src/ipc/channels.ts` 定义。
- **演示模块标识统一为 `'slide'`，永不使用 `'presentation'`** 作为模块值。
- ⚠️ 反例教训（真实踩过的坑）：`DocModule` 曾在 `core` 与 `desktop/tabStore` 各存一份；`PendingOpen.module` 用 `'presentation'`、`PlannerModule` 也用 `'presentation'`，而系统其余处用 `'slide'` → 导致「最近使用」里 PPT 条目无法直达打开。已统一，勿再分叉。

### 1.2 契约冻结
`packages/core/src/contracts/*` 不得随意改；确需变更须先说明理由、评估全部影响面，并同步更新 `docs/agent-guide.md` 第 5 节。

### 1.3 验证门禁（提交前必须全绿，缺一不可）
```bash
CODEBUDDY_SAFE_DELETE_ENABLED=0 pnpm build   # EXIT=0（必须带该环境变量）
pnpm typecheck                               # EXIT=0（含 desktop 真检查 renderer）
pnpm test                                    # 全绿
```
任一失败先修，**禁止带病提交**。

### 1.4 禁原生弹窗
**严禁 `window.prompt` / `window.alert`**（会阻断 Electron CDP 自动化）。一律用项目 `Modal` 组件——
且 Modal 必须 **portal 到 `#root` 内**（挂到 `document.body` 会导致按钮事件失效）。

### 1.5 无新依赖
除确有必要且项目已有同类能力，否则**不引入新依赖**（体积敏感，见 `docs/size-strategy.md`）。

### 1.6 代码风格
- **全中文注释**；复用既有实现（不要另起一套）：解析/序列化、单位换算（`exporter/units.ts` 必须互逆）、`jkToHtml`/`htmlToJk`、relId 分配等。
- 样式用设计令牌（`bg-surface` / `text-fg` / `text-muted` / `text-accent` / `bg-hover` / `border` / `text-tiny`…），不硬编码颜色。

### 1.7 AI 业务代码隔离
非 AI 任务不要改 `AIPanel.tsx` / `aiRunner.ts` / `aiStore.ts` / `aiChatStore.ts` / `packages/ai`（仅类型层面的最小修复除外，且不得改业务逻辑）。

### 1.8 改 UI 接线后跑冒烟
改 `Modal` / `Ribbon` / `AIPanel` 等 UI 接线后，**必须重跑** `scripts/gui-smoke.mjs`（见 agent-guide 3.2）。

### 1.9 改 OOXML 解析/导出后跑对抗审计
改 docx/xlsx/pptx/pdf 的**解析器或导出器**后，必须跑 `node scripts/adversarial-audit.mjs`（边界/恶意输入 + round-trip 保真 + 包完整性含**悬空关系** + **WPS COM 跨软件打开**）。⚠️ 反例教训：pptx 导出器曾因**缺母版/版式/主题骨架**导致导出的 pptx 在 WPS/PowerPoint **打不开**（P0，跨软件不可读）——导出骨架类改动必跑本脚本。

### 1.10 视觉与素材合规（红线）
**只对标功能、布局与交互范式；视觉素材必须自有或已授权。**
- ❌ 严禁从其他软件（WPS / Office / 任何第三方）**安装目录提取**图标 / 插画 / 字体 / 动效 / 音效 / 模板；
- ❌ 严禁使用他人**商标与品牌标识**；❌ 禁止用他人品牌配色作为主视觉；
- ✅ 新增视觉素材（图标/插画/字体/音效）**必须**在 `docs/assets-provenance.md` 登记来源与许可。
- 依据：WPS GUI 受**著作权 + 外观设计专利**（金山「趣键盘」案判赔 25 万，「开发并提供下载 = 实施该 GUI 外观设计」）+ 商标法 + 反不正当竞争法多重保护，**「复制 + 略改」不能脱责**。详见 `docs/research-wps-gui-ip.md`。

## 2. 构建 / 验证 / 提交 / 推送（速查）

```bash
# 构建（仓库根；必须带 env，否则安全删除策略会拦截 electron-builder）
CODEBUDDY_SAFE_DELETE_ENABLED=0 pnpm build

# 类型检查 / 单测（仓库根）
pnpm typecheck
pnpm test

# 提交
git -c user.name="jareking-dev" -c user.email="dev@jareking.local" commit -m "feat(scope): ..."

# 推送（Token 注入 insteadOf；出网走本地代理，github 隧道时通时断 → 失败重试）
T=<GitHub PAT，见用户长期记忆>
for i in 1 2 3 4 5 6; do
  git -c url."https://${T}@github.com/jare39063124-oss/jareking.git".insteadOf="https://github.com/jare39063124-oss/jareking.git" \
      push origin HEAD && break
  sleep 12
done
```
- 落点仓库 `jare39063124-oss/jareking`，分支 `master`。**直连 github 不可用**（必须走代理/Token 注入）。
- 代理到 `github.com` 的隧道**时通时断（`CONNECT tunnel failed 502`）**：多试几次即可命中窗口。

## 3. 文档导航（改动后同步更新，勿让它过时）
| 文档 | 用途 | 更新时机 |
|---|---|---|
| `AGENTS.md`（本文件） | 协作宪章 / 铁律 | 标准变化时 |
| `docs/agent-guide.md` | 模块地图 / 环境 / 调试钩子 / 风险清单 / 症状索引 | 改架构、新增模块后 |
| `docs/spec.md` | 产品规格 | 需求变更 |
| `docs/todo.md` | 任务与勾选状态 | **每完成一项** |
| `docs/wps-parity.md` | WPS 对齐差距矩阵 | 对齐推进时 |
| `docs/size-strategy.md` | 体积战略（Electron 瘦身 + WebView2 评估） | 体积相关 |
| `docs/fonts.md` | 字体版权与零风险白名单 | 字体相关 |
| `docs/macros.md` | 宏方案（JS 宏 Worker 沙箱） | 宏相关 |

## 4. 当前基线（每次变化请更新；截至 2026-10-16）
- **测试**：writer 58 / desktop 232 / presentation 52 / core 46 / sheet 55 / pdf 15 / ai 16（合计 474）。
- **已实现**：
  - Writer：docx 读写（L2）+ 域/页码/目录 + **批注** + **修订** + 查找替换 + 页眉页脚 + 脚注/尾注 + 分栏 + 公式（OMML）+ **样式管理器**；
  - Sheet：xlsx + 公式 + 样式双向映射 + 查找替换 + **单元格格式对话框（Ctrl+1）** + **插入图表（选区→PNG 预览/下载）** + **数据透视表** + **分列/删除重复项**；
  - Presentation：开/编/存 + **表格** + 备注 + 图表 + 动画切换 + 放映 + **母版/版式** + **对象超链接** + **排练计时**（advTm 自动换片，2026-10-16）；
  - PDF：页面工具（合并/拆分/提取/删除/旋转/插入/替换）+ **转 TXT / 转图片** + **Office 转 PDF（本机 COM）** + 水印；
  - **全模块导出 PDF**：Writer/Sheet/Presentation → Electron 原生打印管线（`shared/pdfPrint.ts` 纸张单一事实源 + `lib/printHtml.ts` + `sheet/sheetToHtml.ts` + `slide/presentationToHtml.ts` + `main/services/pdfExport.ts`，IPC `pdf:export-html`）；验收脚本 `scripts/pdf-export-smoke.mjs`；
  - AI：适配器（OpenAI 兼容/Claude/Gemini/Ollama）+ Planner + 本地 ops 执行。
- **公共能力下沉**：图表渲染 `lib/chartRenderer.ts`、字体清单 `lib/fonts.ts`、下载助手 `lib/download.ts`（原散落各处，已收敛）。
- **待做**：Writer 拼写检查、Sheet 图表散点类型、WPS 级精确分页（**打印设置对话框已于 2026-10-16 落地**：纸张/方向/页边距/打印区域/重复标题行，见 docs/todo.md W-批2续）。

## 5. 不要做
- 不要 `rm -rf` / 删除用户文件；不要强推（`--force`）/ 重置 git 历史。
- 不要为过 typecheck 而大面积 `@ts-ignore`（个别第三方类型缺陷用 `@ts-expect-error` + 注释说明）。
- 不要重复定义共享类型（见铁律 1.1）。
- 不要跳过验证门禁（见铁律 1.3）。
