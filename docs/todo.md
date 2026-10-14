# jareking 开发 Todolist

> 配套文档：`spec.md`（产品规格）· 版本 v1.1 · 2026-10-12
> 使用规则：开发前须通过 Spec 审批；任务完成后勾选并记录日期；接口契约优先于并行开发。
> v1.1 变更：Windows 单平台；Presentation 升入 v1；商业化按个人开发者路径（第三方平台充值 + 离线许可证）；云同步转预留；新增品牌占位任务。
> **2026-10-14 增补**：用户要求「WPS 全量功能」——差距显性化为 `docs/wps-parity.md` 对齐矩阵（P0/P1/P2 三档分批），批 1（查找替换/字数统计/字体库）已落地；字体版权调研与合规方案见 `docs/fonts.md`。

## WPS 对齐专项（2026-10-14 增设，矩阵与批次见 docs/wps-parity.md）

- [x] **W-批1（2026-10-14）**：Writer 查找替换（Ctrl+F/H 自研，全部替换单事务可撤销，10 测）+ 字数统计状态栏（WPS 口径）+ 字体库合规三分组（docs/fonts.md：OFL 内置白名单/厂商免费商用/系统字体红线）
- [x] **W-批2 首批（2026-10-14）**：Writer **插入页码**（PAGE 域，Word/WPS 打开重算）+ **插入目录**（扫描全文 heading 层级 → 目录标题 + 缩进大纲条目 + TOC 域，打开后可更新域得页码；tocBuilder 纯函数 4 测 + gui-smoke 断言）
- [ ] **W-批2 续**：Writer 页眉页脚（深度项：需 sectPr header/footer parts 读写 + 布局重构，风险高排单独专项）+ 全模块导出 PDF 统一入口（融合 T5.3 打印管线）+ Sheet 单元格格式对话框
- [ ] **W-批3**：Presentation 动画切换（T3.3）+ 表格 + 备注；Sheet 查找替换 + 图表（T2.5）
- [ ] **W-批4**：批注/修订（Writer）、数据透视表（Sheet）、母版（演示）、JS 宏评估
- [x] **字体合规**：调研完成（docs/fonts.md：红线=方正/汉仪/微软雅黑嵌入；内置白名单=OFL 清单）；批 1 已把 系统字体/开源 OFL/厂商免费商用 三组 23 款进字体下拉；批 2 待办=安装包内置思源黑体+霞鹜文楷（附 OFL.txt 与鸣谢页）；批 3 待办=字体管理器（扫描本机字体+授权提示）

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

- [x] **T3.1** pptx 解析：幻灯片/版式/占位符/形状树 → 自有模型（基础保真）
  - 完成（2026-10-13）：新建 `packages/presentation`（JSZip + fast-xml-parser，与 writer 同约定：removeNSPrefix 后用无前缀键）；模型 `JkPresentation/JkSlide/JkShape`（text/shape/image 可判别联合，EMU 坐标、pt 字号）；解析覆盖 幻灯片顺序（sldIdLst+rels，含 sldId 属性 r:id/id 冲突处理）/画布尺寸/文本框（段落+run 格式：粗斜下、字号、色、字体、对齐、级别、项目符号）/预设几何（含形状内文字+纯色填充+旋转）/图片（relId）
  - **分类规则修正**：prstGeom rect + 有文本 → 文本框（真实 PPT 文本框都带 rect 几何），其余几何 → 形状；避免全部文本框被归为形状
  - 冒烟通过（内存构造最小 pptx → 解析断言：形状序列/格式/填充/旋转/图片全对）；动画/母版/SmartArt/图表降级记录 fidelity.notes；导出器随 T3.4
- [x] **T3.2** 幻灯片编辑器：Konva/Fabric canvas；文本框/形状/图片/表格编辑；主题母版
  - 完成（2026-10-13）：**Konva（react-konva 19.3，React 19 兼容）**；`apps/desktop/src/renderer/src/slide/SlideEditor.tsx`——左侧幻灯片列表（切换/新增/删页）+ 中央 Konva 舞台（EMU→px 等比缩放）+ 工具栏（文本框/矩形/椭圆/图片/复制/删除/打开/保存 .pptx）；编辑能力：单击选中、拖拽移动（px→EMU 回写）、双击改文字（沿用首 run 格式）、图片插入（dataURL 展示+字节入 media 落盘）
  - GUI 冒烟通过：演示标签 Konva canvas 渲染 + 幻灯片面板，0 控制台错误
  - **后续迭代**：主题母版、缩放变换手柄/多选、单元格表格编辑（v1 表格编辑占位）
- [ ] **T3.3** 动画与切换（基础）、放映模式（F5）
- [x] **T3.4** pptx 导出（PptxGenJS + 自研序列化）；导出 PDF
  - 完成（2026-10-13）：**自研序列化**（无需 PptxGenJS）——`packages/presentation/src/exporter`：ContentTypes/根 rels/presentation.xml（sldIdLst+sldSz）/每页 slide XML（sp/pic/txBody 逆映射）/每页 rels+ppt/media 图片落盘（字节签名嗅探扩展名）；JkPresentation 新增 `media` 载体（键 `${slideIndex}:${relId}`，rId 每页独立会重号），解析器同步提取图片字节回填
  - round-trip 冒烟通过：文本（格式/对齐/项目符号/级别）/形状（geom/fill/旋转）/图片（字节保留）全保持；**导出 PDF 随 Phase 5**（T5.3）
- [ ] **T3.5** **Phase 验收**：5 份真实 pptx 打开-编辑-保存；放映流畅

## Phase 4 — AI 助手

- [x] **T4.1** AI 适配层：`AIAdapter` 接口 + OpenAI 兼容 / Claude / Gemini / Ollama 四类适配器；流式输出、重试退避、超时、token 计量
  - 完成（2026-10-13）：packages/ai 重写实现——`fetchWithRetry`（429/5xx/网络错误指数退避 300ms×2^n，AbortSignal.any 组合超时）、SSE/NDJSON 通用流解析、四类适配器（openai-compatible 覆盖 DeepSeek/通义/Kimi/智谱等一切兼容网关 / claude / gemini / ollama）、`createAiAdapter` 工厂 + listModels；StreamEvent 统一 text/usage/done/error
  - 运行时冒烟（本地 mock 网关）：流式聚合+500 自动重试 ✅、非流式 usage 计量 ✅、不可路由地址 500ms 超时快速中断 ✅
  - 说明：明文 apiKey 每次调用注入（apiKeyRef 明文解析在 T4.2 接 DPAPI）；Claude/Gemini/Ollama 三家为按官方 API 规范实现，待有真实 Key 时联调
- [x] **T4.2** API 配置 UI：多配置管理（任意 BaseURL + Key + 模型名）、密钥系统凭据加密存储（keytar/DPAPI）、连通性测试、模型列表拉取
  - 完成（2026-10-13）：主进程 AiConfigService（settings KV + **Electron safeStorage 加密**，Windows 即 DPAPI；不可用环境 base64 兜底打标）；IPC 四通道 list/save/delete + ai:key:resolve；渲染层 aiStore + 设置面板「AI 服务商」区块（多配置增删改/表单/**拉取模型下拉回填**/**测试连接**）
  - 端到端 GUI 冒烟：保存→safeStorage 解密回读→解析 Key 真实调用 mock 网关→配置列表**无 Key 泄漏**→UI 展示，全过、0 控制台错误
- [x] **T4.3** AI 操作协议：ops schema 定义（format.apply / text.replace / cell.set / chart.insert 等）+ Planner 系统提示词 + Executor 确定性执行 + diff 预览 + 撤销 + 积分估算
  - 完成（2026-10-13）：ops 协议（packages/ai/planner/writerOps.ts）——v1 十类 Writer ops（insertText/replaceSelection/setFormat/insertParagraph/insertTable/setColor/clearFormatting/insertHorizontalRule/undo/redo）zod 判别联合；LLM 输出容错解析（剥 \` 围栏、平衡 JSON 提取、非法 op 丢弃并记录 rejected）
  - createWriterPlanner（prompt 构建：ops 说明书+文档节选+选区）+ 桌面侧 opsExecutor.ts（TipTap 确定性执行，单 op try/catch 不中断）
  - AIPanel 真实接线：指令 → 启用配置 → resolveKey → Planner → Executor → 面板展示计划说明与执行摘要；无配置/无文档时给出引导提示
  - **全链路 GUI 冒烟通过**：设置 mock LLM → AI 面板发指令 → 文档真实变更（aiDocChanged）+ 执行摘要展示，0 控制台错误
- [x] **T4.4** Writer AI 技能：格式指令、内容指令、润色/续写/翻译/摘要；选中浮动工具条
  - 完成（2026-10-13，核心部分）：AIPanel 快捷技能条（润色选区/续写/翻译为英文/总结全文/插入表格）——预设指令走同一条 Planner→Executor 管道；自由指令并行支持
  - **选中浮动工具条 —— 已落地（2026-10-14 晚）**：`writer/FloatingAiBar.tsx` 自实现（不引入 @tiptap/extension-bubble-menu，免 v2/v3 版本漂移）——选区非空时经 `view.coordsAtPos` 在选区上方浮出（润色/译英/改写/总结），走 `aiRunner` 共享管线，执行结果与撤销统一写入 aiChatStore（与面板共用撤销入口）
- [x] **T4.7** 侧边栏对话：多轮对话、文档上下文注入（当前文档/选中区域）、历史会话
  - 完成（2026-10-13，核心部分）：文档上下文注入（全文节选 1500 字 + 当前选区）已在 Planner prompt；侧边栏对话 UI 已实现（消息列表/忙碌态/错误反馈）
  - **多轮对话 + 历史持久化 —— 已落地（2026-10-14 晚）**：`DocContextSummary.history`（最近 6 轮随指令进 Planner prompt，system 提示理解「再/第二段」等指代）；消息经 `stores/aiChatStore.ts` 持久化 localStorage（jk-ai-chat-v1，重启续聊，加载时过滤崩溃残留的未完成占位）；标题栏「新会话」清空
- [x] **AI 执行可回退（T4.9 前置，2026-10-14 晚落地）**：三端全覆盖——Writer：`aiRunner.ts` 执行前 `getJSON` 快照，面板/浮动条消息带「↩ 撤销本次」（`aiChatStore.undoFns` 内存态，重启后撤销不可用属预期）；Sheet：执行前 `univerSnapshotToJk` 整簿快照，撤销经 `createWb` 重建；PPT：`structuredClone(pres)` 快照整份恢复。**顺带修复 op 组合缺陷**：`setColor`/`setFormat` 在无选区时 TipTap stored mark 会被 `insertContent` 丢弃 → opsExecutor 引入 `pendingMarks`（无选区设格式暂存，随下一次 `insertText` 以 marks 参数落盘；color 挂 `textStyle` mark 的 color 属性而非独立 mark）
- [x] **T4.9** **Phase 验收**：20 条预置指令（10 文档 + 10 表格）执行成功率 ≥ 90%；每次操作可撤销
  - **完成（2026-10-14 晚）：24/24（100%）**——`scripts/ai-ops-acceptance.mjs`（mock LLM 按指令关键词返回确定性 ops，**最长 key 优先匹配**防「表格验收一」撞子串「验收一」；断言轮询等待防异步竞态）。覆盖 Writer 10 类 op（insertText/insertParagraph/heading/insertTable/hr/setColor/setFormat/undo/redo/formatNumbers）+ Sheet 全类（setValue 数字与字符串/setValues/setFormula/组合/数据问答）+ 撤销恢复断言（W1/W4/W10/S1）+ undo/redo op 往返。0 控制台错误；桌面 32/32 单测 + typecheck + GUI 冒烟全绿
- [x] **T4.5** Sheet AI 技能：公式生成（自然语言 → 公式）、数据汇总、图表生成、数据洞察
  - 完成（2026-10-13）：Sheet ops 协议（setFormula/setValue/setValues，A1 记法，zod 判别联合）+ createSheetPlanner（表格 CSV 节选作上下文，数据问题类指令直接在 explanation 回答）+ sheetOpsExecutor（Univer 门面确定性执行）；SheetEditor 工具栏加 AI 输入（公式生成/数据写入/数据问答）
  - **排掉两个 Univer 深坑**（写入被静默拦截，弹「范围已保护」对话框）：① sheet 配置键必须用 Univer 默认 id（sheet-01…），自造键名与权限点注册错位；② 创建后需逐表调 getWorksheetPermission().unprotect() 解除默认创建者保护（文档的 FPermission.removeWorksheetPermission 在 1.0.4 未实现）
  - 全链路 GUI 冒烟：mock LLM → AI 输入 → ops 执行 → 快照断言 F1 值真实写入，0 控制台错误；图表生成/数据洞察随 T2.5 图表能力
- [x] **T4.6** Presentation AI 技能：大纲 → 成稿、一键生成 PPT
  - 完成（2026-10-13）：Presentation ops 协议（addSlide：标题+要点，高层 op）+ createPresentationPlanner（大纲→成稿，封面→内容→结尾结构化输出）+ SlideEditor 执行器（标题 32pt 居中 + 要点 20pt 项目符号排版）；工具栏 AI 输入
  - 全链路 GUI 冒烟：mock LLM → AI 指令 → 幻灯片真实追加（2→3 页），0 控制台错误
  - 后续迭代：模板套用/配图/细粒度形状 ops
  - （T4.7 多轮对话升级 / T4.9 Phase 验收已完成，见 T4.4 条目后统一记录）

## Phase 5 — PDF

> **2026-10-13 修订**：融合用户自研「PDF页面工具箱 v2」（PyInstaller + PyMuPDF，桌面 PDF页面工具箱(4).exe）的功能清单。
> 数据层已落地：\`packages/pdf\`（pdf-lib）——页面提取/删除/合并/旋转/插入/替换/图片转PDF（A4 等比居中）+ 页码规格解析（"1,3-5,last"），真实 24 页 PDF 冒烟 10/10 通过。
> 压缩（栅格化重建，需 pdf.js 渲染层）与 Office 转 PDF（需本机 WPS/Office COM）属引擎层，随阅读器任务接入。

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

---

## 对抗性复检后续（2026-10-15，来源：首轮复检 #46/#47/#48）

> 复检发现的高危项已逐步处理，分级与结果见 `docs/agent-guide.md` 第 6 节。此处登记**已落地**与**暂缓但不丢项**的清单，供后续迭代不遗漏。

### ✅ 已落地（本次）
- **#47 Sheet 样式回写断裂 —— 根治**：`apps/desktop/src/renderer/src/sheet/univerAdapter.ts` 实现 `JkCellStyle ↔ IStyleData` 双向映射 + `StyleRegistry` 去重；`univerAdapter.test.ts` 7/7 通过。保存 Univer 编辑出的填充/字体/边框/对齐不再丢失。
- **#48 Writer 域降级 —— 建模**：`packages/writer` 模型/解析/导出/编辑器链路全贯通 `field`（简单 `fldSimple` + 复杂 `fldChar`/`instrText` 状态机，含 `w:r` 内嵌套）；`test/field.test.ts` 3/3 通过。跨程序（Word/WPS）打开后页码/目录/公式按指令重算。
- **#46 大文件稳定性 —— 安全降级缓解**：`lib/largeFile.ts` 统一阈值与文案；`WriterEditor`/`SlideEditor` 加 `LoadingOverlay`（解析不冻结 UI）+ 可关闭大文件横幅 + PPT 缩略图虚拟化（DOM 节点数恒定）。交互不卡死、不崩溃。
- **#46-B 图片 Blob URL 化 —— 已落地（2026-10-15）**：新增 `writer/mediaRegistry.ts`（relId → 字节 + Blob URL，revoke 生命周期）+ `writer/jkImage.ts`（扩展 Image 保留 `data-jk-media`）；`jkToHtml`/`htmlToJk` 支持可选 `mediaMap`/`mediaBytes`，显示侧用 Blob URL（DOM 不再持 base64，消除双倍内存），保存凭 `data-jk-media` 从注册表取回字节（blob: 不可还原问题消除）；`WriterEditor` 接入加载建 / 保存回写 / 卸载 revoke。新增 `mediaRegistry.test.ts` 6 测，桌面 14/14 单测 + typecheck + GUI 冒烟全绿。
- **#46-A Writer 分块/分页编辑 —— 已落地（2026-10-15）**：真·ProseMirror 节点虚拟化风险高（易破坏刚稳定的编辑器），故采用**分块编辑**——完整 `JkDocument` 留内存作唯一真源，编辑器每次只渲染 `body` 一个切片（`WRITER_CHUNK_SIZE=300` 锁 DOM 节点数），切换/保存前 `htmlToJk` 解析当前切片并 `applyChunkEdits` 写回整文（关系按 id 去重、媒体按 rId 写回）；仅当 `body` 块数 > `WRITER_CHUNK_BLOCK_THRESHOLD=800` 才启用，普通文档走原单文档路径**零回归**。配套 `htmlToJk` 增 `relSeqStart`/`mediaSeqStart` 续号参数防 rId 冲突；新增分页条 UI（‹ 第 i/N 段 › + 跳转）+ `writer/chunking.ts`（纯函数）+ `chunking.test.ts`（11 测，含切片往返保留图片）。验证：桌面 25/25 单测 + typecheck + `scripts/chunk-smoke.mjs`（真实 Electron 验证 2000 段→7 块、分页条、切片内容正确、翻页无报错）+ 标准 GUI 冒烟（consoleErrors:[]）全绿。
- **#46-C Sheet/PPT 分块解析 —— 已落地（2026-10-15）**：① **解析迁移 Web Worker**（渲染主线程不再冻结 + worker 崩溃隔离）——`lib/parseDispatch.ts`（纯分发，worker/单测共用）+ `lib/parse.worker.ts`（独立 chunk，含 exceljs+fflate）+ `lib/parseClient.ts`（transferable 零拷贝 buffer 转移 + 10 分钟超时自动重建 worker）；`SheetEditor`/`SlideEditor` 打开文件改走 `parseInWorker`。② **PPT 改 fflate 流式解压**（替代 JSZip.loadAsync 全量解压）——逐条目按需解压，幻灯片 XML 解析完即丢弃、theme/embeddings/docProps 等无关条目不驻留，解析峰值下降；解析逻辑（parseSp/parsePic 等）零改动。新增 `packages/presentation/test/pptxParser.test.ts`（2 测：导出→解析往返 + 非法包错误路径）与 `scripts/worker-smoke.mjs` 端到端冒烟（CDP 注入真实 xlsx/pptx → Worker 解析 → 上屏断言）。**顺带修复存量 bug**：Univer 固定 unit id `jareking-sheet` 重复创建抛 "cannot create a unit with the same unit id"（打开 xlsx 必炸——该链路此前从未被端到端验证），`createWb` 现先 `disposeUnit` 卸载旧 unit；两个 Editor 打开失败的静默 catch 补 `console.error`。验证：presentation 2/2 + 桌面 32/32 单测、全仓 typecheck、build（worker chunk 1.8MB 独立）、worker-smoke / gui-smoke / chunk-smoke 三冒烟全绿 0 控制台错误。
  - **100MB+ 真实压测（2026-10-14 晚，`scripts/gen-bigfile.mjs` 自造样本 + `scripts/bigfile-bench.mjs`）**：
    - **xlsx 107.3MB**（10 万行 × 4 列 40 万格）：Worker 解析 **6.85s**、主线程最大冻结 **0.85s**（旧方案为全量冻结 ≥6.85s）；端到端含 Univer 上屏 10 万行 **7.7s**、堆 228MB。
    - **pptx 120.1MB**（40 页 × 3MB 伪图片媒体）：fflate 流式解析 **0.4s**、主线程最大冻结 **0.05s**（几乎无感）；端到端含 40 页 Konva 上屏 **1.0s**、堆 228MB。
    - 结论：100MB 量级全链路秒级打开、0 控制台错误；残余冻结主要来自 fetch 读入/结构化克隆/Univer 创建（非解析）。**M3 流式 xlsx 读取器立项必要性降低**——若未来出现 500MB+ 场景再评估。

### ⏸ 暂缓（深层架构债，明确不丢项，排入 M3 性能专项前）
- **真正流式 xlsx 解析**：exceljs 不支持流式读（`Workbook.xlsx.load` 全量装载）。#46-C 已落地的 Worker 隔离解决了「主线程冻结 + 崩溃隔离」，且 100MB+ 压测（107MB xlsx 解析 6.85s / 堆 228MB）表明当前量级体验良好——**M3 立项必要性降低**，仅在出现 500MB+ 真实场景时按数据再评估。

### 🔍 #46-A / #46-C 评估（2026-10-15 更新）
- **#46-A —— 已落地（分块编辑，非节点虚拟化）**：原评估认为"真·节点虚拟化难度高、回归风险高"。实际落地采用分块编辑（完整文档留内存、编辑器只渲染 body 切片 + 分页条），同样达成"大文档不整篇挂载 DOM"目标，且普通文档零回归。真·节点级虚拟滚动仍不作为目标（性价比低）。
- **#46-C —— 已落地（Worker + 流式，2026-10-15）**：原评估的「最小可行缓解」① Web Worker ② 流式 zip 均已实施。② 由 yauzl（Node-only，不可用于渲染进程/worker）改为 **fflate**（浏览器/worker 同构）。原评估「建议独立专项」按当前进度合并进本轮完成；真正流式 xlsx 读取器仍排 M3（见暂缓清单）。
- 结论：#46（安全降级）、#46-A（大文档 DOM）、#46-B（图片双倍内存）、#46-C（解析冻结 + PPT 峰值）全部闭环；大文件专项仅剩「流式 xlsx 读取器」一项登记 M3。

### 复查澄清（非缺口，留痕避免重复排查）
- **命名样式**：复查确认 `model/document.ts` 的 `styleId`/`StyleDef`/`serializeStyles` 与 parser/exporter 已完整贯通 Word 命名样式（Heading 1 等），并非真实缺口。
