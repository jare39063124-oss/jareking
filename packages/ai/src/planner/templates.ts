/**
 * 格式模板体系（用户反馈 1：预设标准格式 —— 政府公文 / 毕业论文等）。
 *
 * 模板是「确定性的排版参数集」：本地直接执行，不消耗 AI、离线可用。
 * 参数与 TidyDocumentOp 对齐；标题层级按中文办公惯例映射。
 */

export interface FormatTemplate {
  id: string;
  name: string;
  description: string;
  tidy: {
    firstLineIndent: number;
    lineSpacing: string;
    bodyAlign: 'justify' | 'left';
    bodyFontSize?: number;
    bodyFontFamily?: string;
  };
  /** 标题层级格式（level 1-3） */
  headings: {
    level: number;
    fontFamily: string;
    fontSize: number;
    align: 'center' | 'left';
    bold: boolean;
  }[];
}

export const FORMAT_TEMPLATES: FormatTemplate[] = [
  {
    id: 'gov-doc',
    name: '政府公文（GB/T 9704 风格）',
    description: '标题二号小标宋居中；一级标题三号黑体；二级三号楷体；正文三号仿宋、首行缩进 2 字符、行距固定 28 磅',
    tidy: { firstLineIndent: 2, lineSpacing: '28pt', bodyAlign: 'justify', bodyFontSize: 16, bodyFontFamily: '仿宋' },
    headings: [
      { level: 1, fontFamily: '黑体', fontSize: 16, align: 'left', bold: false },
      { level: 2, fontFamily: '楷体', fontSize: 16, align: 'left', bold: false },
      { level: 3, fontFamily: '仿宋', fontSize: 16, align: 'left', bold: true },
    ],
  },
  {
    id: 'thesis',
    name: '毕业论文（通用高校规范）',
    description: '正文小四宋体、1.5 倍行距、首行缩进 2 字符；一级标题四号黑体；西文 Times New Roman',
    tidy: { firstLineIndent: 2, lineSpacing: '1.5', bodyAlign: 'justify', bodyFontSize: 12, bodyFontFamily: '宋体' },
    headings: [
      { level: 1, fontFamily: '黑体', fontSize: 14, align: 'left', bold: false },
      { level: 2, fontFamily: '黑体', fontSize: 12, align: 'left', bold: false },
      { level: 3, fontFamily: '黑体', fontSize: 12, align: 'left', bold: false },
    ],
  },
  {
    id: 'report',
    name: '通用报告（日常办公）',
    description: '正文小四宋体、1.5 倍行距、首行缩进 2 字符；标题黑体层级清晰',
    tidy: { firstLineIndent: 2, lineSpacing: '1.5', bodyAlign: 'justify', bodyFontSize: 12, bodyFontFamily: '宋体' },
    headings: [
      { level: 1, fontFamily: '黑体', fontSize: 16, align: 'left', bold: false },
      { level: 2, fontFamily: '黑体', fontSize: 14, align: 'left', bold: false },
      { level: 3, fontFamily: '黑体', fontSize: 12, align: 'left', bold: false },
    ],
  },
  {
    id: 'business',
    name: '商务汇报（紧凑现代）',
    description: '正文五号宋体、1.25 倍行距、首行缩进 2 字符；标题微软雅黑层级',
    tidy: { firstLineIndent: 2, lineSpacing: '1.25', bodyAlign: 'justify', bodyFontSize: 10.5, bodyFontFamily: '宋体' },
    headings: [
      { level: 1, fontFamily: '微软雅黑', fontSize: 18, align: 'left', bold: true },
      { level: 2, fontFamily: '微软雅黑', fontSize: 14, align: 'left', bold: true },
      { level: 3, fontFamily: '微软雅黑', fontSize: 12, align: 'left', bold: true },
    ],
  },
];

export function getTemplate(id: string): FormatTemplate | undefined {
  return FORMAT_TEMPLATES.find((t) => t.id === id);
}

/** 模板 id 列表（给 LLM 的 applyTemplate 说明用） */
export const TEMPLATE_IDS = FORMAT_TEMPLATES.map((t) => t.id).join('|');
