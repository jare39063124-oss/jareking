/**
 * OOXML（.docx WordprocessingML）文档「内容模型」接口定义。
 *
 * 设计目标（T1.1）：覆盖 WordprocessingML 核心元素，面向 v1 保真 L2
 * （spec 4.2 / 7.3：.docx 全量读写高保真，复杂特性降级标注）。
 *
 * 四态一致约束：同一模型既可被 T1.2 解析器从 docx 读入，
 * 也可驱动 T1.3 渲染、被 T1.4 编辑器修改、再由 T1.5 序列化回 docx。
 * 因此 Block / Inline 一律采用带 `type` 字面量的「可判别联合类型」，
 * 便于渲染/编辑做类型收窄（discriminated union narrowing）。
 *
 * 解耦说明：本文件是「文档内容」；`packages/core/contracts/document.ts`
 * 的 `DocumentMeta` 是「文件级元数据」（标题/路径/格式/保真等级…），二者不重复。
 *
 * 单位约定：尺寸/坐标统一使用 EMU（English Metric Units，1 英寸 = 914400 EMU，
 * 1 厘米 = 360000 EMU）；字号 `size` 为 half-point（半磅，24 = 12pt）。
 */

import type { FidelityLevel } from '@jareking/core';
import type { UnsupportedFeature } from './fidelity';

/* =========================================================================
 * 0. 兜底扩展字段
 * =========================================================================
 * 每个主要接口都预留 `data?: Record<string, unknown>`，用于原样保留
 * 当前版本尚未建模的 OOXML 特性（如 w:framePr、w:tcW 复杂写法等），
 * 以满足 L2 保真「未知内容先保留再降级」的要求，避免解析时丢数据。
 */

/** 通用兜底字段类型（所有模型节点的可选扩展槽） */
export interface ModelExtra {
  /** 暂未建模的特性原样保留（键建议带命名空间，如 "ooxml:framePr"） */
  data?: Record<string, unknown>;
}

/* =========================================================================
 * 1. 根文档
 * ========================================================================= */

/** Writer 文档内容模型根节点（对应 WordprocessingML 的 document.xml 正文 + 关联部件） */
export interface JkDocument extends ModelExtra {
  /** 正文块级元素序列（对应 w:body 的子节点） */
  body: Block[];
  /** 分节信息列表（对应各 w:sectPr；最后一节通常内联在 body 末尾段落的 pPr 中） */
  sections: Section[];
  /** 样式定义表（对应 styles.xml） */
  styleDefs: StyleSheet;
  /** 编号定义表（对应 numbering.xml） */
  numberingDefs: Numbering;
  /** 文档级设置（对应 settings.xml 的常用项） */
  settings: DocumentSettings;
  /** 资源引用表（对应 .rels；图片/超链接/页眉页脚均通过 rId 关联） */
  relationships: Relationship[];
  /**
   * 二进制媒体载体（保存期使用，非持久化字段）。
   * 键为资源 rId，值为图片字节；导出时据此把媒体写入 word/media/*，
   * 并在 document.xml.rels 中建立 image 类型关系。解析时从 zip 取出回填。
   */
  media?: Record<string, Uint8Array>;
  /** 本模型保真等级与降级记录（解析阶段填充） */
  fidelity: FidelityReport;
  /**
   * 批注列表（对应 word/comments.xml 的 w:comment 集合）。
   * 行内锚点位置由各 `Paragraph.commentRanges` 记录（按 runs 索引切片），
   * 二者通过批注 id 关联（与 commentRangeStart/End 的 w:id 一致）。
   */
  comments?: JkComment[];
  /**
   * 文档内出现过的修订作者汇总（便于 UI 展示「谁在何时改过」，可选字段）。
   * 由解析器扫描正文 run 的 `revision` 汇总去重（同一作者取最近一次修订时间）。
   */
  revisions?: RevisionAuthor[];
}

/**
 * 修订作者汇总项（对应 `JkDocument.revisions` 元素）。
 *
 * 说明：修订本身以行内 `Run.revision` 承载（插入/删除逐 run 记录），
 * 本类型仅用于「文档级作者清单」展示，不参与 OOXML 落盘。
 */
export interface RevisionAuthor {
  /** 修订作者（对应 w:author） */
  author: string;
  /** 该作者最近一次修订时间（ISO 字符串，对应 w:date） */
  date: string;
}

/**
 * 批注（对应 comments.xml 的 w:comment）。
 *
 * 设计说明（四端一致）：`id` 是批注的唯一标识，与文档正文中
 * `w:commentRangeStart`/`w:commentRangeEnd`/`w:commentReference` 的 `w:id` 对应；
 * `text` 承载批注正文（多段落用 \n 连接）；`resolved` 为 jareking 内部状态
 * （导出时对应 w:done="1"，Word/WPS 打开后可继续显示在审阅窗格）。
 */
export interface JkComment {
  /** 批注 id（对应 w:comment@w:id，字符串数字，与文档内 commentRangeStart/End 的 w:id 一致） */
  id: string;
  /** 作者（对应 w:author） */
  author?: string;
  /** 作者缩写（对应 w:initials） */
  initials?: string;
  /** 创建时间（对应 w:date，ISO 字符串） */
  date?: string;
  /** 批注正文纯文本（段落用 \n 分隔） */
  text: string;
  /** 是否已解决（jareking 内部状态，w:done="1" 时导出注释保留；v1 可选） */
  resolved?: boolean;
}

/* =========================================================================
 * 2. 块级元素（Block）可判别联合
 * =========================================================================
 * 对应 w:body 下可直接出现的块：段落、表格、分节符等。
 */
export type Block = Paragraph | Table | SectionBreak | ParagraphBreak;

/** 块级节点基础标记（供联合收窄与兜底扩展） */
export interface BlockBase extends ModelExtra {
  type: Block['type'];
}

/** 段落（对应 w:p）：由若干行内元素 runs 组成，可带段落属性 pPr */
export interface Paragraph extends BlockBase {
  type: 'paragraph';
  /** 行内元素数组（文本 Run / 图片 / 超链接 / 换行符 / 脚注引用…） */
  runs: Inline[];
  /** 段落属性（Word: w:pPr）—— 对齐/缩进/行距/样式引用/编号引用/大纲级别 */
  pPr?: ParagraphProperties;
  /**
   * 段落内的批注范围（按 runs 索引切片；对应 commentRangeStart/End 包围的行内区间）。
   * 索引区间 [start, end) 为左闭右开，指向 `runs` 数组；导出时在 start 处插入
   * `<w:commentRangeStart>`，在 end 处插入 `<w:commentRangeEnd>` 与引用 run。
   */
  commentRanges?: CommentRange[];
}

/**
 * 段落内批注范围（行内锚点）。
 *
 * 建模说明：Word 的批注锚点由同一 `w:id` 的 `w:commentRangeStart` / `w:commentRangeEnd`
 * 界定一段连续的行内内容。jareking 以「runs 索引区间」表达该锚点，
 * 与 `JkComment.id` 对应；四端（model/parser/exporter/editor）保持一致。
 * 端点 run 索引左闭右开：start 含、end 不含。
 */
export interface CommentRange {
  /** 批注 id（与 JkComment.id / w:id 一致） */
  id: string;
  /** 起始 run 索引（含） */
  start: number;
  /** 结束 run 索引（不含） */
  end: number;
}

/** 表格（对应 w:tbl）：行数组 + 表格属性 + 列网格；单元格内可嵌套任意 Block（含表格） */
export interface Table extends BlockBase {
  type: 'table';
  /** 表格行（对应 w:tr） */
  rows: TableRow[];
  /** 表格属性（Word: w:tblPr）—— 边框/宽度/对齐/样式 */
  tablePr?: TableProperties;
  /** 列宽定义（Word: w:tblGrid）—— 各列宽度（EMU） */
  grid?: TableGrid;
}

/** 分节符（对应 w:sectPr 作为块出现，如「下一页分节符」）：携带其后分节属性 */
export interface SectionBreak extends BlockBase {
  type: 'sectionBreak';
  /** 分节类型（Word: w:type，默认 nextPage） */
  breakType: 'nextPage' | 'nextColumn' | 'continuous' | 'evenPage' | 'oddPage';
  /** 该分节符之后的分节属性（页边距/纸张/页眉页脚关联） */
  section: Section;
}

/** 显式段落断行 / 空段落标记（多数情况下段落本身即断句；此节点用于保留连续空行等显式结构） */
export interface ParagraphBreak extends BlockBase {
  type: 'paragraphBreak';
}

/* =========================================================================
 * 3. 行内元素（Inline）可判别联合
 * =========================================================================
 * 对应 w:p 内可出现的行内内容：文本 Run、超链接、图片、换行符、脚注引用。
 */
export type Inline = Run | Hyperlink | Image | Break | FootnoteRef | Field | Formula;

/**
 * 公式（OMML，WPS 对齐）
 * v1 以线性文本承载（可读、可再编辑），导出为 m:oMath 原生公式对象，
 * Word/WPS 打开后可继续编辑；矩阵/方程组等高级结构登记 W-P2。
 */
export interface Formula extends InlineBase {
  type: 'formula';
  /** 线性公式文本（如 "x^2+y^2=z^2"） */
  text: string;
}

/** 行内节点基础标记（供联合收窄与兜底扩展） */
export interface InlineBase extends ModelExtra {
  type: Inline['type'];
}

/** 文本片段 / 字符格式载体（对应 w:r）：承载文本 text 与字符属性 rPr */
export interface Run extends InlineBase {
  type: 'run';
  /** 文本内容（对应 w:t；已解码 XML 实体） */
  text: string;
  /** 字符属性（Word: w:rPr）—— 字体/字号/粗体/斜体/下划线/颜色/删除线/上下标 */
  rPr?: RunProperties;
  /**
   * 修订标记（track changes）。
   * - `insert`：该 run 为「插入」内容（OOXML 中被 `<w:ins>` 包裹，文本用 `<w:t>`）；
   * - `delete`：该 run 为「删除」内容（OOXML 中被 `<w:del>` 包裹，文本用 `<w:delText>`）。
   * 无此字段即普通（未修订）run，解析/导出均按原有路径处理。
   */
  revision?: RunRevision;
}

/**
 * 修订标记（track changes）。
 *
 * 采用「挂在 Run 上」而非新增行内类型，理由：一字一 run 的粒度与 OOXML
 * `<w:ins>`/`<w:del>` 直接对应，避免引入新的可判别联合分支导致四端
 * （model/parser/exporter/renderer）大面积收窄改动；`kind`/`author`/`date`
 * 与 `<w:ins|w:del>` 的 `w:author`/`w:date` 一一对应。
 */
export interface RunRevision {
  /** 修订类型：insert=插入的文本，delete=删除的文本 */
  kind: 'insert' | 'delete';
  /** 修订作者（对应 w:ins/w:del 的 w:author） */
  author?: string;
  /** 修订时间（ISO 字符串，对应 w:ins/w:del 的 w:date） */
  date?: string;
}

/** 超链接（对应 w:hyperlink）：通过 rId 指向外部 URL 或文档内书签锚点 */
export interface Hyperlink extends InlineBase {
  type: 'hyperlink';
  /** 资源引用 id（对应 r:id，指向 relationships 中的外部/内部链接） */
  relId?: string;
  /** 文档内跳转锚点（对应 w:anchor，书签名）；与 relId 互斥使用 */
  anchor?: string;
  /** 链接文本（行内元素，一般为若干 Run） */
  runs: Inline[];
}

/** 行内图片（对应 w:drawing → wp:inline → a:graphic；资源经 r:embed 引用） */
export interface Image extends InlineBase {
  type: 'image';
  /** 资源引用 id（对应 r:embed，指向 relationships 中的图片部件） */
  embed: string;
  /** 显示宽度（EMU）；缺失时由容器决定 */
  width?: number;
  /** 显示高度（EMU） */
  height?: number;
  /** 替代文本（对应 a:alt / wp:docPr descr；v1 支持基础渲染与保留） */
  alt?: string;
}

/** 换行 / 分页 / 分栏符（对应 w:br / w:cr；w:br@w:type="page" 即分页符） */
export interface Break extends InlineBase {
  type: 'break';
  /** 断行类型：textWrapping=软回车，page=分页符，column=分栏符 */
  breakType: 'textWrapping' | 'page' | 'column';
}

/** 脚注引用（对应 w:footnoteReference）：指向脚注部件中的条目 */
export interface FootnoteRef extends InlineBase {
  type: 'footnoteRef';
  /** 脚注 id（对应 w:footnoteReference@w:id） */
  id?: string;
}

/**
 * Word 域（对应 w:fldSimple / w:fldChar + w:instrText 序列）：
 * PAGE / NUMPAGES / DATE / TIME / TOC / 页码 / 目录等。
 * jareking 内部以静态结果文本展示，导出时还原为 w:fldSimple，Word/WPS 打开后重算，
 * 从而跨程序保真（否则域会被降级为静态文本而丢失语义）。
 */
export interface Field extends InlineBase {
  type: 'field';
  /** 域指令（去掉外层花括号），如 "PAGE"、"NUMPAGES"、"DATE \\@ \"yyyy-MM-dd\"" */
  instr: string;
  /** 缓存的显示结果文本（导出时作为占位文本落盘，Word/WPS 打开后重算覆盖） */
  result?: string;
}

/* =========================================================================
 * 4. 表格行 / 单元格
 * ========================================================================= */

/** 表格行（对应 w:tr）：含单元格数组与行属性 */
export interface TableRow extends ModelExtra {
  type: 'tableRow';
  /** 单元格数组（对应 w:tc） */
  cells: TableCell[];
  /** 行属性（Word: w:trPr）—— 行高/表头重复等 */
  rowPr?: TableRowProperties;
}

/** 表格单元格（对应 w:tc）：内含块级元素数组，支持嵌套表格 */
export interface TableCell extends ModelExtra {
  type: 'tableCell';
  /** 单元格内容（块级元素，可含 Paragraph / Table 实现嵌套表格） */
  blocks: Block[];
  /** 单元格属性（Word: w:tcPr）—— 边框/合并/宽度/垂直对齐 */
  cellPr?: TableCellProperties;
}

/** 列网格（对应 w:tblGrid/w:gridCol）：各列宽度（EMU） */
export interface TableGrid {
  /** 各列宽度（EMU）；长度即列数 */
  cols: number[];
}

/* =========================================================================
 * 5. 段落属性（pPr）
 * ========================================================================= */
export interface ParagraphProperties extends ModelExtra {
  /** 段落样式引用（对应 w:pStyle@w:val，指向 StyleSheet 中的 styleId） */
  styleId?: string;
  /** 编号引用（对应 w:numPr：numId + ilvl） */
  numPr?: NumberingReference;
  /** 对齐方式（对应 w:jc@w:val） */
  jc?: Alignment;
  /** 缩进（对应 w:ind） */
  ind?: Indentation;
  /** 行距与段间距（对应 w:spacing） */
  spacing?: Spacing;
  /** 大纲级别 0-9（对应 w:outlineLvl@w:val；用于目录/导航） */
  outlineLvl?: number;
  /** 是否保持与下段同页（对应 w:keepNext） */
  keepNext?: boolean;
  /** 段前分页（对应 w:pageBreakBefore） */
  pageBreakBefore?: boolean;
  /**
   * 是否对齐文档网格（对应 w:snapToGrid；默认 true）。
   * WPS 对该属性敏感：显式 false 时行高紧凑，丢失后 WPS 按网格行距渲染导致页数暴涨。
   */
  snapToGrid?: boolean;
  /** 孤行控制（对应 w:widowControl；默认 true） */
  widowControl?: boolean;
}

/** 对齐方式（Word: w:jc 取值子集） */
export type Alignment =
  | 'start'
  | 'end'
  | 'left'
  | 'right'
  | 'center'
  | 'justify'
  | 'distribute'
  /** OOXML 原值：两端对齐（justify 的 Word 原生写法，解析需保留） */
  | 'both';

/** 缩进（对应 w:ind；单位 EMU，首行/悬挂用磅值） */
export interface Indentation {
  /** 左缩进（EMU） */
  left?: number;
  /** 右缩进（EMU） */
  right?: number;
  /** 首行缩进（EMU，正=首行缩进，负=悬挂缩进） */
  firstLine?: number;
  /** 悬挂缩进（EMU，与 firstLine 二选一） */
  hanging?: number;
}

/** 行距 / 段间距（对应 w:spacing） */
export interface Spacing {
  /** 段前间距（EMU，对应 w:before） */
  before?: number;
  /** 段后间距（EMU，对应 w:after） */
  after?: number;
  /** 行距值（对应 w:line；含义取决于 lineRule） */
  line?: number;
  /** 行距规则（对应 w:lineRule：auto=倍数，exact/exactRule=固定值，atLeast=最小值） */
  lineRule?: 'auto' | 'exact' | 'atLeast';
}

/* =========================================================================
 * 6. 字符属性（rPr）
 * ========================================================================= */
export interface RunProperties extends ModelExtra {
  /** 字符样式引用（对应 w:rStyle@w:val） */
  styleId?: string;
  /** 粗体（对应 w:b） */
  bold?: boolean;
  /** 斜体（对应 w:i） */
  italic?: boolean;
  /** 下划线（对应 w:u@w:val；none 表示无下划线） */
  underline?: Underline;
  /** 删除线（对应 w:strike） */
  strike?: boolean;
  /** 双删除线（对应 w:dstrike） */
  doubleStrike?: boolean;
  /** 上下标（对应 w:vertAlign@w:val） */
  verticalAlign?: 'baseline' | 'superscript' | 'subscript';
  /** 字体颜色（对应 w:color@w:val，6 位十六进制，不含 #） */
  color?: string;
  /** 字体（对应 w:rFonts：ascii/eastAsia/hAnsi/cs） */
  font?: Font;
  /** 字号（half-point，对应 w:sz@w:val；24 = 12pt） */
  size?: number;
  /** 高亮（对应 w:highlight@w:val） */
  highlight?: string;
}

/** 下划线样式（Word: w:u 取值子集） */
export type Underline =
  | 'none'
  | 'single'
  | 'double'
  | 'thick'
  | 'dotted'
  | 'dashed'
  | 'wave'
  | 'words';

/** 字体族（对应 w:rFonts；分别控制 ASCII / 东亚 / 默认 / 复杂文种） */
export interface Font {
  /** ASCII 字符字体（w:ascii） */
  ascii?: string;
  /** 东亚字符字体（w:ea，中文常用，对应 w:eastAsia） */
  eastAsia?: string;
  /** 默认字体（w:hAnsi） */
  hAnsi?: string;
  /** 复杂文种字体（w:cs） */
  cs?: string;
  /**
   * 字体提示（w:hint，如 "eastAsia"）——决定东亚字符的回退优先级。
   * WPS 渲染敏感：丢失后中文字体回退路径改变。
   */
  hint?: string;
}

/* =========================================================================
 * 7. 表格属性（tblPr / trPr / tcPr）
 * ========================================================================= */
export interface TableProperties extends ModelExtra {
  /** 表格样式引用（对应 w:tblStyle@w:val） */
  styleId?: string;
  /** 表格对齐（对应 w:jc） */
  jc?: Alignment;
  /** 表格宽度（EMU；对应 w:tblW） */
  width?: number;
  /** 边框（对应 w:tblBorders，简化为一组边线描述） */
  borders?: TableBorders;
  /** 单元格边距（对应 w:tblCellMar） */
  cellMargin?: TableCellMargin;
  /** 表格底纹（对应 w:tblPr/w:shd） */
  shd?: TableShading;
}

/** 表格边框（对应 w:tblBorders：top/left/bottom/right/insideH/insideV） */
export interface TableBorders {
  top?: BorderSide;
  left?: BorderSide;
  bottom?: BorderSide;
  right?: BorderSide;
  insideHorizontal?: BorderSide;
  insideVertical?: BorderSide;
}

/** 单边线（对应 w:top 等：val/color/sz） */
export interface BorderSide {
  /** 线型（对应 w:val：single/none/double/thick...） */
  style: string;
  /** 颜色（6 位十六进制，不含 #） */
  color?: string;
  /** 线宽（八分之一磅，对应 w:sz） */
  size?: number;
}

/** 单元格边距（对应 w:tblCellMar） */
export interface TableCellMargin {
  top?: number;
  left?: number;
  bottom?: number;
  right?: number;
}

/** 底纹/底纹填充（对应 w:shd：单元格、行、表格三级通用） */
export interface TableShading {
  /** 图案值（w:val，如 clear/solid）；通常 clear，表示以 fill 为底 */
  val?: string;
  /** 前景色（w:color，主题色或 auto）；通常 auto */
  color?: string;
  /** 背景填充色（w:fill，6 位十六进制，不含 #）；为实际可见底纹色 */
  fill?: string;
}

/** 行属性（对应 w:trPr） */
export interface TableRowProperties extends ModelExtra {
  /** 行高（EMU，对应 w:trHeight） */
  height?: number;
  /** 跨页重复表头（对应 w:tblHeader） */
  headerRepeat?: boolean;
  /** 行底纹（对应 w:trPr/w:shd） */
  shd?: TableShading;
}

/** 单元格属性（对应 w:tcPr） */
export interface TableCellProperties extends ModelExtra {
  /** 单元格宽度（EMU，对应 w:tcW） */
  width?: number;
  /** 垂直对齐（对应 w:vAlign：top/center/bottom） */
  vAlign?: 'top' | 'center' | 'bottom';
  /** 水平合并（对应 w:gridSpan，跨列数） */
  gridSpan?: number;
  /** 垂直合并（对应 w:vMerge：restart=起始，continue=接续） */
  vMerge?: 'restart' | 'continue';
  /** 单元格边框（对应 w:tcBorders） */
  borders?: TableBorders;
  /** 单元格底纹（对应 w:tcPr/w:shd） */
  shd?: TableShading;
}

/* =========================================================================
 * 8. 样式系统
 * =========================================================================
 * 对应 styles.xml：每个 StyleDef 由 styleId 唯一标识，元素通过 styleId 引用。
 */
export interface StyleSheet {
  /** 样式定义列表 */
  styles: StyleDef[];
  /** 文档默认格式（对应 w:docDefaults，应用样式前的兜底值） */
  docDefaults?: DocDefaults;
}

/** 文档默认样式（对应 w:docDefaults/rPrDefault + pPrDefault） */
export interface DocDefaults extends ModelExtra {
  rPr?: RunProperties;
  pPr?: ParagraphProperties;
}

/** 样式定义（对应 w:style） */
export interface StyleDef extends ModelExtra {
  type: 'styleDef';
  /** 样式标识（对应 w:style@w:styleId，元素通过 styleId 引用） */
  styleId: string;
  /** 样式类型（对应 w:style@w:type） */
  styleType: 'paragraph' | 'character' | 'table' | 'numbering';
  /** 样式显示名（对应 w:name@w:val） */
  name?: string;
  /** 基于 / 继承的样式（对应 w:basedOn@w:val，引用另一 styleId） */
  basedOn?: string;
  /** 后续段落样式（对应 w:next@w:val） */
  next?: string;
  /** 链接的字符样式（对应 w:link@w:val，段落样式链字符样式时） */
  link?: string;
  /** 是否为默认样式（对应 w:default） */
  isDefault?: boolean;
  /** 段落格式（对应 w:pPr） */
  pPr?: ParagraphProperties;
  /** 字符格式（对应 w:rPr） */
  rPr?: RunProperties;
  /** 表格格式（对应 w:tblPr） */
  tblPr?: TableProperties;
}

/* =========================================================================
 * 9. 编号系统
 * =========================================================================
 * 对应 numbering.xml：抽象编号（abstractNum）定义多级格式，
 * 具体编号（num）通过 abstractNumId 引用并允许级别覆盖。
 */
export interface Numbering {
  /** 抽象编号定义列表（对应 w:abstractNum） */
  abstractNum: AbstractNumbering[];
  /** 具体编号实例列表（对应 w:num） */
  num: ConcreteNumbering[];
}

/** 抽象编号定义（对应 w:abstractNum） */
export interface AbstractNumbering extends ModelExtra {
  /** 抽象编号 id（对应 w:abstractNum@w:abstractNumId） */
  abstractNumId: string;
  /** 各级别定义（对应 w:lvl，最多 9 级，level 0-8） */
  levels: NumberingLevel[];
}

/** 具体编号实例（对应 w:num） */
export interface ConcreteNumbering extends ModelExtra {
  /** 具体编号 id（对应 w:num@w:numId，段落 numPr 引用此值） */
  numId: string;
  /** 引用的抽象编号 id（对应 w:abstractNumId） */
  abstractNumId: string;
  /** 级别覆盖（对应 w:lvlOverride，覆盖抽象编号的指定级别） */
  overrides?: NumberingLevelOverride[];
}

/** 编号级别定义（对应 w:lvl） */
export interface NumberingLevel extends ModelExtra {
  /** 级别 0-8（对应 w:lvl@w:ilvl） */
  level: number;
  /** 编号格式（对应 w:numFmt@w:val：decimal/upperLetter/bullet...） */
  format?: NumberingFormat;
  /** 级别文本（对应 w:lvlText@w:val，如 "%1."、"%1.%2"） */
  text?: string;
  /** 起始值（对应 w:start@w:val） */
  start?: number;
  /** 级别缩进（EMU，对应 w:lvl@w:pPr/w:ind） */
  ind?: Indentation;
  /** 级别字符格式（对应 w:lvl@w:rPr） */
  rPr?: RunProperties;
}

/** 编号级别覆盖（对应 w:lvlOverride） */
export interface NumberingLevelOverride extends ModelExtra {
  /** 被覆盖的级别 0-8 */
  level: number;
  /** 覆盖后的起始值（对应 w:startOverride） */
  startOverride?: number;
  /** 完全重定义该级别（对应 w:lvl） */
  levelRedefine?: NumberingLevel;
}

/** 编号格式（Word: w:numFmt 常见取值） */
export type NumberingFormat =
  | 'decimal'
  | 'upperRoman'
  | 'lowerRoman'
  | 'upperLetter'
  | 'lowerLetter'
  | 'ordinal'
  | 'bullet'
  | 'none';

/** 段落中的编号引用（对应 w:numPr：numId + ilvl） */
export interface NumberingReference {
  /** 具体编号实例 id（对应 w:numId@w:val） */
  numId: string;
  /** 级别 0-8（对应 w:ilvl@w:val） */
  ilvl: number;
}

/* =========================================================================
 * 10. 分节与页面
 * ========================================================================= */
export interface Section extends ModelExtra {
  type: 'section';
  /** 页边距（EMU，对应 w:pgMar） */
  pageMargin?: PageMargin;
  /** 纸张尺寸（EMU，对应 w:pgSz） */
  pageSize?: PageSize;
  /** 页面方向（对应 w:pgSz@w:orient） */
  orientation?: 'portrait' | 'landscape';
  /** 页眉关联（每项指向 relationships 的 rId） */
  headerRefs?: SectionRef[];
  /** 页脚关联（每项指向 relationships 的 rId） */
  footerRefs?: SectionRef[];
  /**
   * 页眉内容块（默认页眉；首页/奇偶页留待后续）。
   * 仅作为模型内便捷承载——真正落盘依靠 headerRefs + 生成的 word/headerN.xml 部件。
   */
  header?: Block[];
  /**
   * 页脚内容块（默认页脚）。落盘方式同 header。
   */
  footer?: Block[];
}

/** 页边距（对应 w:pgMar，单位 EMU） */
export interface PageMargin {
  top: number;
  right: number;
  bottom: number;
  left: number;
  /** 页眉距上边界（EMU） */
  header?: number;
  /** 页脚距下边界（EMU） */
  footer?: number;
  /** 装订线（EMU） */
  gutter?: number;
}

/** 纸张尺寸（对应 w:pgSz，单位 EMU） */
export interface PageSize {
  /** 页宽（EMU） */
  width: number;
  /** 页高（EMU） */
  height: number;
}

/** 页眉/页脚关联（对应 w:headerReference / w:footerReference） */
export interface SectionRef {
  /** 关联类型（default/even/odd/first 对应首页/奇偶页差异化） */
  refType: 'default' | 'first' | 'even' | 'odd';
  /** 资源引用 id（指向 relationships 中的 header/footer 部件） */
  relId: string;
}

/* =========================================================================
 * 11. 资源引用（.rels）
 * ========================================================================= */
export type RelationshipType =
  | 'image'
  | 'hyperlink'
  | 'header'
  | 'footer'
  | 'footnotes'
  | 'endnotes'
  | 'comments'
  | 'styles'
  | 'numbering'
  | 'settings'
  | 'officeDocument'
  | (string & {});

/** 资源引用（对应 .rels 的 Relationship：rId ↔ 目标） */
export interface Relationship extends ModelExtra {
  /** 引用 id（如 "rId1"，与 draw:embed / hyperlink:r:id 等对应） */
  id: string;
  /** 关系类型（对应 Type，决定目标如何解析） */
  type: RelationshipType;
  /** 目标（包内相对路径如 "media/image1.png"，或外部 URL） */
  target: string;
  /** 目标模式（internal=包内，external=外部链接） */
  targetMode?: 'internal' | 'external';
}

/* =========================================================================
 * 12. 文档设置（settings.xml 子集）
 * ========================================================================= */
export interface DocumentSettings extends ModelExtra {
  /** 默认制表位（EMU，对应 w:defaultTabStop） */
  defaultTabStop?: number;
  /** 是否奇偶页不同（对应 w:evenAndOddHeaders） */
  evenAndOddHeaders?: boolean;
  /** 是否首页不同（对应 w:titlePg） */
  titlePage?: boolean;
  /** 兼容模式（对应 w:compatSetting，记录最小 Word 版本等） */
  compat?: Record<string, string>;
}

/* =========================================================================
 * 13. 保真报告（解析阶段填充）
 * ========================================================================= */

/** 保真报告：记录本文档实际达到的保真等级与降级特性清单 */
export interface FidelityReport {
  /** 解析后判定的保真等级（L1/L2/L3，对齐 spec 4.2） */
  level: FidelityLevel;
  /** 解析 / 序列化时遇到、本版本不能完美还原的特性（用于 UI 提示） */
  features: UnsupportedFeature[];
}
