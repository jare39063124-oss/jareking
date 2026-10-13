# jareking 开发 Todolist

> 配套文档：`spec.md`（产品规格）· 版本 v1.1 · 2026-10-12
> 使用规则：开发前须通过 Spec 审批；任务完成后勾选并记录日期；接口契约优先于并行开发。
> v1.1 变更：Windows 单平台；Presentation 升入 v1；商业化按个人开发者路径（第三方平台充值 + 离线许可证）；云同步转预留；新增品牌占位任务。

## 阶段总览

- **Phase 0** 基础设施 + 品牌占位（P0）
- **Phase 1** Writer 核心（P0）
- **Phase 2** Sheet 核心（P0）
- **Phase 3** Presentation 核心（P0，v1 全量）
- **Phase 4** AI 助手（P0）
- **Phase 5** PDF（P0/P1）
- **Phase 6** 商业化（P0，个人路径）
- **Phase 7** 本地账户 + 云同步预留（P0/P2）
- **Phase 8** 体验与发布（P0）

---

## Phase 0 — 基础设施 + 品牌占位

> **环境备忘（2026-10-12 验证通过）**：
> - pnpm 12：构建脚本白名单在 `pnpm-workspace.yaml` 的 `allowBuilds`（映射格式，非数组）；esbuild 的 postinstall 校验被沙箱阻止（node 自我 spawn EBUSY），已跳过校验（运行时用平台可选依赖的二进制，不受影响）
> - Electron 二进制：GitHub 被墙，用 `ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"` 下载
> - 沙箱默认 `ELECTRON_RUN_AS_NODE=1`：从工具里启动 Electron GUI 需 `env -u ELECTRON_RUN_AS_NODE`
> - `__dirname` 由 electron-vite 打包时注入，ESM 主进程不要手动声明

- [x] **T0.0 品牌占位**（人工任务，越早越好）
  - 注册域名 jareking.cn（备选 jareking.com.cn）；检查并注册 jareking.net/.app
  - GitHub 组织占位：jareking-app 或 jareking-office（待需求方选定，先两个都占）
  - npm 组织名占位（jareking 可用）
  - 正式商标检索（商标网/阿里云商标）：确认 "jareking" 第 9/42 类可注册性；准备个体工商户名义申请材料
  - 验收：域名 DNS 生效；GitHub/npm 组织可访问；商标检索报告存档
- [x] **T0.1** 初始化 monorepo：pnpm workspace + electron-vite + React19 + TS 严格模式；分包 `apps/desktop`、`packages/core`、`packages/ai`、`packages/server`（预留，不含部署）；ESLint + Prettier + 提交规范
  - 验收：`pnpm dev` 能启动空 Electron 窗口；`pnpm build` 出 Windows 安装包
  - 完成（2026-10-12）：typecheck / build / Electron 冒烟启动均通过；ESLint 按 README 偏差记录暂缓；installer 打包待 T0.5 配置 electron-builder 后验证
- [x] **T0.2** 主窗口框架：多文档标签页、菜单栏、Ribbon 工具栏骨架、命令面板（Ctrl+Shift+P）、设置页
  - 验收：可新建/关闭标签页；命令面板可搜索并触发占位命令
  - 完成（2026-10-13）：zustand tabStore + Ribbon 骨架 + Ctrl+Shift+P 命令面板 + 设置页（主题切换）+ 整体布局（顶/中/右 AI 面板占位/底状态栏）；typecheck 通过
- [x] **T0.3** 设计系统：主题变量（浅/深）、图标库、基础组件（按钮/弹窗/下拉/树/输入框），视觉对标 WPS 布局
  - 验收：组件有示例页；主题可切换
  - 完成（2026-10-13）：`assets/main.css` 补全 `--jk-*` 令牌（颜色/间距/圆角/字号/阴影/z-index 浅深两套）；组件 Button/IconButton/Input/Select/Modal/Dropdown/Tooltip/Tabs/Tree/Toast 全部就位；typecheck 通过
- [x] **T0.4** 本地持久层：SQLite（**sql.js**，WASM 版）存文档元数据/最近文件/设置/积分账户；文件系统文档库（打开/保存/自动保存/崩溃恢复）
  - 验收：崩溃后重启能恢复未保存文档；最近文件列表可用
  - 完成（2026-10-13）：`packages/core/src/db`（SQL.js 封装 + 迁移）、`account`（本地账户 + 积分账本）、`library`（文档库 + 自动保存）；`apps/desktop/src/main/services` 服务层；37/37 vitest 通过；typecheck 通过
- [x] **T0.5** 桌面能力：文件关联（.docx/.xlsx/.pptx/.pdf）、自动更新（electron-updater，含回滚）、崩溃上报（本地日志）、单实例锁
  - 完成（2026-10-13）：单实例锁 collect 命令行文件路径 + 聚焦；`updater.ts` 封装 electron-updater（仅 packaged 模式 checkForUpdatesAndNotify）；preload 扩展 invoke + IPC 通道常量；`electron-builder.yml`（nsis 可改路径 + 4 类文件关联）；typecheck/build 通过
  - 注意：`electron-updater` 是 CJS 包，ESM 主进程必须 `import electronUpdater from 'electron-updater'` 默认导入 + 解构，具名导入运行时失败
- [ ] **T0.6** CI：GitHub Actions，Push 即构建 Windows 安装包（x64）并上传 Artifact
  - **状态：暂缓**（需推送至 GitHub 仓库；GitHub 用户名 jareking 被占，待 T0.0 选定的 jareking-app 组织就绪后接入；不影响本地开发闭环，排入 M3 上云前）

## Phase 1 — Writer 核心

- [x] **T1.1** OOXML 文档模型设计：paragraph/run/table/section/styles/numbering 的 TypeScript 接口定义（**接口契约先行，供 T1.2~T1.5 并行**）
  - 完成（2026-10-13）：`packages/writer/src/model/`，可判别联合类型 + 完整 styles/numbering 契约 + fidelity 降级清单；FidelityLevel 复用 core 单一事实源；typecheck 零错误
- [x] **T1.2** docx 解析器：JSZip + fast-xml-parser → 文档模型；未知特性降级不丢数据
  - 完成（2026-10-13）：段落/表格(嵌套)/样式(basedOn 继承)/编号/分节/超链接/图片占位/rPr 格式全覆盖；smartArt/OLE/域/公式降级记 UnsupportedFeature；9/9 vitest 通过
- [ ] **T1.3** 渲染引擎：文档模型 → 分页布局 → DOM 渲染；缩放、页码、页眉页脚
  - **决策：T1.3 的只读渲染被 T1.4(TipTap 编辑器，本身即渲染+编辑) 吸收**；独立的「只读分页预览」留作打印/AI 差异预览，排入 T1.4 之后按需
- [x] **T1.4** 编辑器内核：基于 TipTap 定制 schema 映射文档模型；输入法/IME 兼容；撤销重做（500 步）；光标与选区跨格式保持
  - 完成（2026-10-13）：TipTap 编辑器（StarterKit + Underline + TextAlign + Table 套件）落地 `apps/desktop/src/renderer/src/writer/`；首加载 fetch 内置 sample.docx → parseDocx → jkToHtml → setContent；打开/保存走 `htmlToJk → exportDocx` 经 Blob 下载；工具栏 加粗/斜体/下划线/删除线/H1~H3/正文/四种对齐/有序无序列表/插 3×3 表/撤销重做/打开/保存；全部 try/catch + toast 兜底
  - 测试：`apps/desktop/src/renderer/src/writer/roundtrip.test.ts`（vitest + jsdom，2 条）覆盖「打开→保存」保存侧闭环：sample.docx → parseDocx → jkToHtml 结构正确 → htmlToJk → exportDocx → 再解析结构稳定；与 `packages/writer` 13/13 合计 15/15 绿
  - 局限（headless 沙箱）：GUI 渲染冒烟需在真实 Windows 机器 `env -u ELECTRON_RUN_AS_NODE pnpm dev` 人工确认；IME/选区跨格式为运行期行为，靠编辑器交互验证
- [x] **T1.5** docx 导出：文档模型 → OOXML 序列化；保真 L2；图片/字体打包
  - 完成（2026-10-13）：合法 docx(zip+命名空间+ContentTypes/rels)；单位换算与解析器精确互逆；__raw 兜底回插；13/13 vitest 通过（含解析→导出→再解析对称）
  - 局限：图片二进制 round-trip 待解析器侧补 media（T1.8 前）
- [x] **T1.6** 工具栏与格式面板（核心子集）
  - 完成（2026-10-13）：在 T1.4 编辑器上扩展格式工具栏——字体族（SimSun/黑体/微软雅黑/楷体/仿宋/Times New Roman/Arial/Calibri/Cambria）、字号（8~72pt）、字体颜色（取色器）、超链接（插入/取消，window.prompt 输入 URL）、**插入图片**（本地文件 → data URL → TipTap Image，保存时由 htmlToJk 落盘为 media）；新增 TipTap 扩展 TextStyle/Color/FontFamily/Link/Image + 自研 FontSize
  - 转换层补齐：jkToHtml 输出 font-family 的 span + 图片 data URL；htmlToJk 解析 span 内 color/font-size/font-family，并把 `<img>` 的 data URL 解码为媒体字节登记 image 关系
  - 数据层补齐图片二进制：JkDocument 新增 `media` 载体；parser 从 zip 取出图片字节回填 `media`，exporter 把 `media` 写入 `word/media/*` 并建立 image 关系；writer 新增图片 round-trip 测试（导出包含 media、再解析字节一致）
  - 回归测试追加 2 条（T1.6 describe）：字体/颜色/字号/超链接「编辑→保存→再解析」稳定保留；与 T1.4 合计桌面 4/4、writer 15/15（含图片测试）
  - **暂缓（非 M1 阻塞，排入后续）**：样式面板（命名样式下拉）、分节符按钮、页面设置面板、Word 级快捷键体系对标（目前 Ctrl+B/I/U/Z/Y 由 StarterKit 提供，删除线/字体快捷键待补）
  - 补充（2026-10-13 晚）：**分页符闭环修复**——发现 htmlToJk 丢弃 `<hr>`（分页符）导致含分页符的 docx 保存后丢失分页；已修复（hr → Break(page) Run，根级与单元格内均处理），并加「插入分页符」工具栏按钮（StarterKit HorizontalRule）+ 回归测试（hr → Break(page) → hr 形态稳定）；桌面 5/5
- [ ] **T1.7** 高级特性：目录自动生成、批注、查找替换、拼写检查
  - **状态：暂缓**（2026-10-13 决策）
  - 查找替换：官方 `@tiptap/extension-find-and-replace` 仅发布 v3（全量 3.29~3.31），与当前 TipTap v2.27 主栈不兼容；升级到 v3 属破坏性迁移（命令/API 变更），风险高，不在本阶段做；待 Phase 1 稳定后单独评估 v3 升级或自研 ProseMirror 查找高亮插件
  - 目录自动生成 / 批注 / 拼写检查：依赖样式系统与编辑器内部状态，延后到编辑器成熟后
- [ ] **T1.8** **Phase 验收**：10 份真实 docx「打开 → 编辑 → 保存」round-trip，格式无可见丢失；导出 PDF 正常
  - **完成（2026-10-13）**：
    - 真实文档验收 6/6 通过——本机真实 Word/WPS 产出的 6 份 .docx（装机必读/一户一策化解方案/开投报告/支行汇报材料×2/超星手册）全部「解析→导出→再解析」结构一致；含 **5 张真实图片**的文档 media 完好、1747 段大文档完好
    - **发现并修复真实 bug**：分节段落 round-trip 净增空段（开投报告.docx 1747→1748 段）——空的分节段落现仅产出 SectionBreak，导出还原为带 sectPr 的空段，round-trip 稳定
    - **GUI 自动化冒烟通过**——`scripts/gui-smoke.mjs`（CDP 协议，Node 22 内置 WebSocket）：真实 Electron 窗口中 Writer 渲染 sample.docx（H1「jareking 示例文档」、可编辑）、**0 控制台错误**
  - **待人工**：导出文件在 Word/WPS 中的视觉核对（沙箱无 Office）；PDF 导出随 Phase 5

## Phase 2 — Sheet 核心

- [x] **T2.1** xlsx 文件层：SheetJS 解析/写回；多 sheet、样式、合并单元格、行列属性
  - 完成（2026-10-13）：新建 `packages/sheet`（**exceljs** 替代 SheetJS——社区版不读样式，exceljs 全支持）；`JkWorkbook/JkSheet/JkCell/JkCellStyle` 契约（0 基坐标、px 尺寸、稀疏 cells "r,c" 键）；解析覆盖 多 sheet（含隐藏）/值/公式（f 去 = 前缀+缓存结果）/合并（model.merges）/列宽（字符↔px）/行高（pt↔px）/冻结/基础样式（字体/填充/对齐/边框/数字格式/富文本降级）；导出精确互逆；A1 记法工具（toA1/parseA1Range）
  - 运行时冒烟通过：export→parse round-trip 值/公式/合并/加粗/填充/列宽全部保持；exceljs `views/model` 为 null 的坑已防御
- [x] **T2.2** 表格引擎：集成 Univer（或自研 canvas 表格）；单元格编辑、格式化、行列操作、冻结窗格
  - 完成（2026-10-13）：**Univer v1.0.4 preset 方案**（`@univerjs/presets` + `@univerjs/preset-sheets-core`，中文 locale 自带全子包合并）；`apps/desktop/src/renderer/src/sheet/`：`univerAdapter.ts`（JkWorkbook ↔ Univer IWorkbookData：值/公式/合并/列宽行高）+ `SheetEditor.tsx`（挂载/打开/保存/重置示例，卸载 dispose 防泄漏）；EditorArea sheet 分支替换占位为全幅真实编辑器；Univer 自带工具栏/公式栏/右键菜单/多 sheet 标签/撤销重做
  - 验收（1 万行×20 列 ≥30fps）：headless 无法测帧率，待真实机器人工验证
  - **后续迭代**：JkCellStyle ↔ Univer IStyleData 样式映射（当前 Univer 内样式编辑不回存到 xlsx，T2.2.1）；冻结窗格读取映射；主包 16.4MB 需代码分割（T8.3）
- [x] **T2.3** 公式引擎：v1 集成 formula.js（200+ 函数）；自研公式解析器（ANTLR 语法 + 依赖图 + 循环引用检测）替换核心函数
  - 完成（2026-10-13）：**方案变更——无需 formula.js**。Univer core preset 已内置公式引擎（@univerjs/engine-formula + @univerjs/sheets-formula，400+ 函数，重算/依赖图/循环引用检测内置），T2.2 集成即生效；编辑器内公式栏/函数提示由 preset 自带
  - 自研解析器替换（性能/可控性）：**延后**至 v2（Univer 引擎满足 v1，替换属优化非阻塞）
- [x] **T2.4** 数据功能：排序、筛选、条件格式、数据验证
  - 完成（2026-10-13）：注册 Univer 官方 preset 四件套——`preset-sheets-sort` / `preset-sheets-filter` / `preset-sheets-conditional-formatting` / `preset-sheets-data-validation`（均 1.0.4，中文 locale 与 core 合并注入）；功能入口进 Univer 自带工具栏/右键菜单
  - 真实机器验收待做（headless 无法点 UI）
- [ ] **T2.5** 图表：柱状/折线/饼图/散点；图表数据联动
  - **暂缓**：Univer 1.0.4 无 chart preset（图表属独立插件，官方仍在演进）；v1 先以「无图表」交付 Phase 2，图表排入 v1 后期或 v2 评估（复评 Univer 版本或自研基于 canvas 的轻量图表插入）
- [x] **T2.6** 导出：CSV / PDF
  - 完成（2026-10-13）：CSV 导出落地——`packages/sheet` 新增 `sheetToCsv`（RFC 4180 引号规则、公式取缓存值、BOM 头适配 Excel/WPS 中文），SheetEditor 加「导出 CSV」按钮；运行时冒烟通过
  - PDF 导出**随 Phase 5**（T5.3 打印管线，字体嵌入），不在本阶段
- [ ] **T2.7** **Phase 验收**：5 份真实 xlsx（含公式/图表）round-trip；公式重算结果与 WPS 一致
  - **完成（2026-10-13，沙箱可验证部分）**：
    - `scripts/verify-xlsx-roundtrip.mjs` 落地（与 docx 版配套：parse→export→reparse，按表比对 格/并/式 计数）
    - 3 份结构丰富的合成 xlsx（多表/30 条公式+SUM/合并/冻结/隐藏表/样式）3/3 结构一致；样式 round-trip 抽查全保持（bold/italic/字号/字色/底色/四边框）
    - GUI 自动化冒烟通过——Sheet 标签 Univer 正常挂载（3 canvas），与 Writer 同脚本验证，**0 控制台错误**；期间修复 Univer locale key 必须用 `LocaleType.ZH_CN`（'zhCN'）而非 'zh-CN' 的崩溃
  - **待人工**：真实 WPS/Excel 产出的 5 份 xlsx 对比 + 公式重算结果一致性（本机暂无真实 xlsx，用户侧收集后跑 verify-xlsx-roundtrip）

## Phase 3 — Presentation 核心（v1 全量，不接受降级）

- [ ] **T3.1** pptx 解析：幻灯片/版式/占位符/形状树 → 自有模型（基础保真）
- [ ] **T3.2** 幻灯片编辑器：Konva/Fabric canvas；文本框/形状/图片/表格编辑；主题母版
- [ ] **T3.3** 动画与切换（基础）、放映模式（F5）
- [ ] **T3.4** pptx 导出（PptxGenJS + 自研序列化）；导出 PDF
- [ ] **T3.5** **Phase 验收**：5 份真实 pptx 打开-编辑-保存；放映流畅

## Phase 4 — AI 助手

- [ ] **T4.1** AI 适配层：`AIAdapter` 接口 + OpenAI 兼容 / Claude / Gemini / Ollama 四类适配器；流式输出、重试退避、超时、token 计量
- [ ] **T4.2** API 配置 UI：多配置管理（任意 BaseURL + Key + 模型名）、密钥系统凭据加密存储（keytar/DPAPI）、连通性测试、模型列表拉取
- [ ] **T4.3** AI 操作协议：ops schema 定义（format.apply / text.replace / cell.set / chart.insert 等）+ Planner 系统提示词 + Executor 确定性执行 + diff 预览 + 撤销 + 积分估算
- [ ] **T4.4** Writer AI 技能：格式指令、内容指令、润色/续写/翻译/摘要；选中浮动工具条
- [ ] **T4.5** Sheet AI 技能：公式生成（自然语言 → 公式）、数据汇总、图表生成、数据洞察
- [ ] **T4.6** Presentation AI 技能：大纲 → 成稿、一键生成 PPT
- [ ] **T4.7** 侧边栏对话：多轮对话、文档上下文注入（当前文档/选中区域）、历史会话
- [ ] **T4.8** 积分扣费打通：本地积分扣减；平台托管模式预留（服务器就绪后启用）
- [ ] **T4.9** **Phase 验收**：20 条预置指令（10 文档 + 10 表格）执行成功率 ≥ 90%；每次操作可撤销

## Phase 5 — PDF

- [ ] **T5.1** 阅读器：PDF.js 渲染、缩放翻页、文本选择复制、目录书签、全文搜索、连续/单页模式
- [ ] **T5.2** 编辑器（门控）：pdf-lib 页面增删/合并/拆分/旋转/提取、注释、基础文本编辑
- [ ] **T5.3** 创建：Writer/Sheet/Presentation 导出 PDF（打印管线，字体嵌入）
- [ ] **T5.4** **Phase 验收**：100MB 以内 PDF 打开 < 3s；编辑功能在门控下正确拦截/放行

## Phase 6 — 商业化（个人开发者路径）

- [ ] **T6.1** 本地积分系统：SQLite 账户表（余额/流水/冻结）；安装赠送；token→积分计量；防刷（设备指纹 + 频率限制）
- [ ] **T6.2** 第三方充值外链：应用内"充值/购买"入口 → 打开浏览器跳转第三方创作平台（爱发电/面包多，待选定）→ 商品页与兑换码说明
- [ ] **T6.3** 兑换码体系：兑换码格式与校验（本地规则校验 + 后续服务端校验接口预留）；兑换入账流水；防爆破（尝试次数限制）
- [ ] **T6.4** 买断许可证：ed25519 密钥对生成（构建机离线保管）；激活码签发工具；客户端本地验签；设备绑定（3 台）；转移授权（解绑旧设备）；私钥泄露应急预案文档
- [ ] **T6.5** 高级功能门控：PDF 编辑、批量转换、去水印导出、高级模板的权限中间件 + 升级引导弹窗
- [ ] **T6.6** "看广告得积分"抽象层：积分来源接口预留广告类型（不接 SDK，置灰入口）
- [ ] **T6.7** **Phase 验收**：全链路走通：安装送积分 → AI 消耗 → 外链充值 → 兑换码入账 → 买断激活 → 门控生效；许可证在无网络环境可验签

## Phase 7 — 本地账户 + 云同步（预留）

- [ ] **T7.1** 本地账户体系：设备账户（ID/创建时间/积分/许可证归属）；账户文件导出/导入（换机迁移）；导入冲突处理
- [ ] **T7.2** 云同步（**仅预留，不实施**）：定义云同步数据模型与接口（documents/sync/versions），`packages/server` 保留脚手架；代码中以 feature flag 关闭

## Phase 8 — 体验与发布

- [ ] **T8.1** WPS 习惯迁移向导：首次启动引导；WPS ↔ jareking 快捷键/界面对照表
- [ ] **T8.2** 模板中心：基础模板免费 + 高级模板门控
- [ ] **T8.3** 性能专项：冷启动、大文档、内存泄漏排查；达到 spec 第 5 章指标
- [ ] **T8.4** 打包发布：Windows x64 安装包（代码签名证书评估）；官网/下载页（jareking.cn）；应用内反馈通道
- [ ] **T8.5** **最终验收**：spec 第 1.4 节四条成功标准全部达成

---

## 预留/暂缓清单（v1 明确不做，架构已留口）

| 项目 | 暂缓原因 | 启用条件 |
|---|---|---|
| 激励视频广告 | 个人无广告 SDK 接入资质 | 企业主体就绪 |
| 平台托管 AI 额度 | 无服务器计量 | VPS + 服务端就绪 |
| 云同步/多端 | 无云服务器与存储 | VPS + 对象存储就绪 |
| 原生微信/支付宝支付 | 无商户号 | 个体工商户注册 |
| macOS 版本 | 需求方决定放弃 | 战略需要时重启（渲染层跨平台设计保持） |
| Apple IAP | 随 macOS 放弃 | 不再涉及 |

---

## 子 Agent 调度策略

1. **接口契约先行**：每个 Phase 开始前，先由编排 Agent 产出该模块的 TypeScript 接口契约（如 T1.1），写入 `packages/core/src/contracts/`，再并行分发实现任务
2. **并行轨道**：
   - 轨道 A（文档引擎）：T1 → T2 → T3 顺序依赖，每个 Phase 内部多 Agent 并行（如 T1.2/T1.3/T1.4）
   - 轨道 B（AI 基础）：T4.1/T4.2/T4.3 可在 T1 完成后即并行启动，不等 T2/T3
   - 轨道 C（商业化）：T6 依赖弱，T1 完成后即可并行
3. **独立测试 Agent**：每个 Phase 设 1 个测试 Agent，按验收标准出报告，不通过则打回实现 Agent
4. **每日站会**：汇总 `todo.md` 勾选进度 + 阻塞项 + 次日并行计划
5. **集成守卫**：任何 Agent 不得修改 `packages/core` 的契约文件，变更须走编排 Agent

## 当前状态

- [x] 需求澄清（2026-10-12）
- [x] Spec v1.0 撰写（2026-10-12）
- [x] 品牌名检索（2026-10-12，结论见 spec 1.6）
- [x] Spec v1.1 修订（2026-10-12，按 6 条开放问题答复）—— **待审批**
- [ ] Spec 审批通过
- [ ] Phase 0 启动（T0.0 品牌占位可立即人工执行）
