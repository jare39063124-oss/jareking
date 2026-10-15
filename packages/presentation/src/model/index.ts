/**
 * jareking Presentation 数据模型（T3.1 接口契约）。
 *
 * 对应 .pptx（PresentationML）核心结构，v1 基础保真：
 * 幻灯片序列 / 形状树（文本框、图片、预设几何形状）/ 段落与文字格式。
 *
 * 坐标约定：位置与尺寸统一 EMU（1 英寸 = 914400 EMU），与 OOXML 原值一致；
 * 字号用磅（pt）（OOXML 的 sz 为百分之一磅，换算仅在读写边界发生）。
 * 颜色约定：#RRGGBB。
 */

/** 演示文稿 */
export interface JkPresentation {
  /** 幻灯片（按放映顺序） */
  slides: JkSlide[];
  /** 画布宽（EMU，对应 p:sldSz@cx） */
  slideWidth: number;
  /** 画布高（EMU，对应 p:sldSz@cy） */
  slideHeight: number;
  /**
   * 图片二进制载体（键 = `${slideIndex}:${relId}`，rId 每页独立会重号）。
   * 解析时从包内 media 提取回填；导出时据此写入 ppt/media/*。
   */
  media?: Record<string, Uint8Array>;
  /** v1 保真报告（未建模特性记录于此） */
  fidelity?: PresentationFidelity;
}

export interface PresentationFidelity {
  level: 'L1' | 'L2' | 'L3';
  /** 降级说明（如「动画未保留」「SmartArt 降级为文本」） */
  notes: string[];
}

/** 幻灯片 */
export interface JkSlide {
  /** 部件名（如 "slide1"，对应 ppt/slides/slideN.xml） */
  partName?: string;
  shapes: JkShape[];
  /** 版式名（来自 slideLayout，v1 仅记录） */
  layout?: string;
  /** 切换效果（v1 仅 none/fade；其余效果解析降级为 none） */
  transition?: 'none' | 'fade' | 'slide';
  /** 演讲者备注（纯文本，段落以 \n 分隔；WPS/PowerPoint 备注栏内容，放映时不显示） */
  notes?: string;
}

/* =========================================================================
 * 形状（可判别联合）
 * ========================================================================= */

export type JkShape = JkTextShape | JkAutoShape | JkImageShape | JkTableShape;

/** 形状公共属性 */
export interface ShapeBase {
  id?: string;
  name?: string;
  /** 左上角 x/y（EMU） */
  x: number;
  y: number;
  /** 宽高（EMU） */
  w: number;
  h: number;
  /** 旋转（度，顺时针，对应 xfrm@rot/60000） */
  rotation?: number;
}

/** 文本框（含占位符文本） */
export interface JkTextShape extends ShapeBase {
  type: 'text';
  paragraphs: TextParagraph[];
  /** 占位符类型（title/ctrTitle/subTitle/body…，v1 仅记录） */
  placeholder?: string;
  /** 原始几何（PPT 文本框通常带 prstGeom rect；导出还原用） */
  geom?: string;
}

/** 预设几何形状（矩形/椭圆/箭头…，可含文字） */
export interface JkAutoShape extends ShapeBase {
  type: 'shape';
  /** prstGeom@prst（如 rect/ellipse/roundRect） */
  geom: string;
  paragraphs?: TextParagraph[];
  /** 纯色填充 #RRGGBB（主题/渐变填充降级忽略） */
  fill?: string;
}

/** 图片（二进制经 media 载体回传，与 writer 思路一致） */
export interface JkImageShape extends ShapeBase {
  type: 'image';
  /** 关系 id（r:embed，指向图片部件） */
  relId: string;
  /** 解析期提取的图片二进制（键 relId → 字节），仅保存期使用 */
}

/* =========================================================================
 * 表格（对应 p:graphicFrame → a:graphicData → a:tbl）
 * ========================================================================= */

/** 单元格底/边/文本（v1 精简） */
export interface JkTableCell {
  /** 单元格文本（段落以 \n 分隔） */
  text: string;
  /** 文本字号（pt，可选；OOXML 的 sz 为百分之一磅，换算仅在读写边界发生） */
  fontSize?: number;
  /** 文本颜色 #RRGGBB（可选） */
  color?: string;
  /** 加粗（可选） */
  bold?: boolean;
  /** 水平对齐（可选，默认 left） */
  align?: 'left' | 'center' | 'right';
}

/** 表格行 */
export interface JkTableRow {
  cells: JkTableCell[];
  /** 行高 EMU（可选，缺省按 table 均分） */
  height?: number;
}

/** 表格形状（对应 p:graphicFrame → a:graphicData → a:tbl） */
export interface JkTableShape extends ShapeBase {
  type: 'table';
  /** 列宽（EMU 数组，长度=列数） */
  colWidths: number[];
  rows: JkTableRow[];
  /** 表格整体高（EMU，可选；缺省回退 ShapeBase.h） */
  height?: number;
}

/* =========================================================================
 * 文字
 * ========================================================================= */

export interface TextParagraph {
  runs: TextRun[];
  align?: 'left' | 'center' | 'right' | 'justify';
  /** 大纲级别 0-8（对应 a:lvl） */
  level?: number;
  bullet?: boolean;
}

export interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** 字号（磅；OOXML sz 百分之一磅 ÷ 100） */
  fontSize?: number;
  /** 字色 #RRGGBB */
  color?: string;
  fontFamily?: string;
}
