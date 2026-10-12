# @jareking/writer

jareking Writer（Word 文档处理）子包的**文档内容模型**定义。本包是 Phase 1 的 **T1.1 接口契约先行**产物。

## 职责

- 定义 OOXML（.docx WordprocessingML）核心元素的**纯 TypeScript 接口/类型 + 常量**；
- **框架无关、零运行时依赖**：只有类型与常量，不引入 zod / 解析库 / 渲染库（运行时校验留待 T1.2）；
- 与 `@jareking/core` 解耦：`core` 的 `DocumentMeta` 是「文件级元数据」（标题/路径/格式/保真等级），本包是「文档内容」（body / 样式 / 编号 / 分节 / 资源）。

## 文件结构

| 文件 | 内容 |
|---|---|
| `src/model/document.ts` | 核心：OOXML 文档内容模型（`JkDocument` → `Block`/`Inline` 可判别联合、段落/表格/样式/编号/分节/资源） |
| `src/model/fidelity.ts` | 保真等级语义常量（`FIDELITY_META`）、降级特性类型（`UnsupportedFeature`） |
| `src/model/index.ts` | 模型统一导出 |
| `src/index.ts` | 包入口（re-export model） |

## 核心类型层次

```
JkDocument（文档根）
├─ body: Block[]                        正文块级序列
│   └─ Block（可判别联合，type 字段）
│       ├─ Paragraph  段落（runs: Inline[]，pPr 段落属性）
│       ├─ Table      表格（rows: TableRow[]，tablePr，grid）
│       │   └─ TableRow → TableCell → blocks: Block[]  （支持嵌套表格）
│       ├─ SectionBreak  分节符（携带 section 属性）
│       └─ ParagraphBreak 显式段落断行
│
├─ sections: Section[]                  分节（页边距/纸张/方向/页眉页脚关联）
├─ styleDefs: StyleSheet                样式定义表（StyleDef 按 styleId 引用，支持 basedOn 继承）
├─ numberingDefs: Numbering             编号定义（AbstractNumbering + ConcreteNumbering + 级别）
├─ settings: DocumentSettings           文档设置
├─ relationships: Relationship[]        资源引用（rId ↔ 目标：图片/超链接/页眉页脚）
└─ fidelity: FidelityReport             保真等级 + 降级特性清单
        └─ Inline（可判别联合，type 字段）
            ├─ Run          文本片段（text，rPr 字符属性）
            ├─ Hyperlink    超链接（relId / anchor + runs）
            ├─ Image        行内图片（embed=rId，width/height/alt）
            ├─ Break        换行/分页/分栏符
            └─ FootnoteRef  脚注引用
```

每个主要接口均预留 `data?: Record<string, unknown>` 兜底槽，用于原样保留当前未建模的 OOXML 特性，契合 L2 保真「未知内容先保留再降级」。

## 对接约定（供后续任务消费）

- **T1.2 解析器**：消费本模型，实现 `parse(docxBytes): JkDocument`；将遇到的不可完美还原特性填入 `JkDocument.fidelity.features`（`UnsupportedFeature`），并据还原能力回填 `fidelity.level`（v1 目标 L2）。
- **T1.3 渲染器**：消费本模型，实现 `render(doc: JkDocument): 分页布局/DOM`；读取 `Section` 做页面设置、`Relationship` 通过 `rId` 拉取图片/页眉页脚资源。
- **T1.4 编辑器**：基于 TipTap（ProseMirror）定制 schema 双向映射 `Block`/`Inline`；编辑产物仍是 `JkDocument`，保证「编辑态」与「文档内容」同源。
- **T1.5 导出器**：消费本模型，实现 `serialize(doc: JkDocument): docxBytes`；通过 `relationships` 打包图片/字体，序列化回 OOXML。

四态一致约束：同一 `JkDocument` 既能解析而来、驱动渲染、被编辑修改、再序列化回 docx。

## 验证

```bash
pnpm --filter @jareking/writer typecheck
```

仅做类型检查（不启动 Electron、不安装运行时依赖）。

## T1.2 docx 解析器（文档解析）

> 实现位置：`src/parser/docxParser.ts`、`src/parser/node-fs.d.ts`（最小 node:fs 环境声明）。包入口 `src/index.ts` 已 re-export。

- **入口**：`parseDocx(buffer: Uint8Array)`（异步，JSZip 异步读包）/ `parseDocxFile(path: string)`（Node/Electron 主进程按路径读文件再解析）；二者均产出 `JkDocument`。
- **依赖**：JSZip（读 zip 各部件）、fast-xml-parser（XML 解析，开启 `removeNSPrefix` 去掉 w:/a:/r: 等命名空间前缀，标签变 `p/r/t`、属性变 `@_val/@_id`）。
- **解析映射范围**：
  - 块级：`w:p`→Paragraph（`runs` 由行内元素构成，`pPr` 取对齐/缩进/行距/大纲级别/样式与编号引用）、`w:tbl`→Table（行→单元格，单元格 `blocks` 递归解析，支持嵌套表格）、`pPr/sectPr`→SectionBreak（携带其后分节属性）。
  - 行内：`w:r`→Run（文本拼接保留空格、字符属性 rPr）、`w:hyperlink`→Hyperlink（经 `.rels` 把 rId/anchor 解析）、`w:drawing`/`w:pict`→Image（记录 `embed` rId + EMU 尺寸占位，二进制加载留待 T1.3）、`w:br`/`w:cr`→Break。
  - 其他部件：`styles.xml`→`styleDefs`（StyleDef，含 basedOn 继承/next/link/docDefaults）、`numbering.xml`→`numberingDefs`（AbstractNumbering + ConcreteNumbering + 级别）、`sectPr`→`sections`（页边距/纸张/方向/页眉页脚关联）、`document.xml.rels`→`relationships`、`settings.xml`→`settings`。
- **保真与降级（spec 4.2 / L2）**：常见结构按 L2 解析并回填 `fidelity.level='L2'`；无法完美映射的特性（`smartArt`/`oleObject`/`field`/`contentControl`/未知块级元素…）记入 `fidelity.features: UnsupportedFeature[]`，并把原始节点保留在 `data` 兜底槽（各 Block/Inline 的 `data.__raw`，未知块级在 `JkDocument.data.__unparsedBlocks`），保证「打开→保存」round-trip 不丢数据。
- **单位约定（对齐 `document.ts` 注释）**：长度字段统一 EMU；Word twips ×635 转 EMU（`ind`/`spacing`/`pgSz`/`pgMar`/`tblGrid`/`tcW`）；字号 `sz` 为半磅（half-point）原值存储（44 = 22pt）；drawing `extent` cx/cy 已是 EMU 原值存储。
- **测试**：`test/fixtures.ts`（JSZip 在运行时构造最小合法 docx，可控制纯文本/格式/表格/超链接/图片/未知元素等）、`test/docxParser.test.ts`（9 个 vitest 用例覆盖上述 8 类验收 + 文件路径解析）。运行：`pnpm --filter @jareking/writer test`。
