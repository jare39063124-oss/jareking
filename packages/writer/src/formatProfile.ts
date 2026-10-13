/**
 * 参考文档格式提取（用户反馈 1：参考本地某个文档的格式）。
 *
 * 从一份参考 .docx 中提取「正文格式档案」：字体/字号/行距/对齐/首行缩进。
 * 提取结果直接转为 tidyDocument op 参数，套用到当前文档——本地确定性执行，
 * 不调用 AI、离线可用。
 *
 * 提取源优先级：Normal 样式 > docDefaults（Word/WPS 文档的通用约定）。
 */
import { XMLParser } from 'fast-xml-parser';

export interface FormatProfile {
  /** 正文字体（eastAsia 优先） */
  bodyFontFamily?: string;
  /** 正文字号（pt） */
  bodyFontSize?: number;
  /** 行距：倍数（如 "1.5"）或固定磅值（如 "28pt"） */
  lineSpacing?: string;
  /** 首行缩进（字符） */
  firstLineIndent?: number;
  /** 正文对齐 */
  bodyAlign?: 'justify' | 'left';
  /** 提取说明（供 UI 展示） */
  summary: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseAttributeValue: false,
});

/** 从 docx 字节流提取正文格式档案（失败返回 null） */
export async function extractFormatProfile(bytes: Uint8Array): Promise<FormatProfile | null> {
  try {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(bytes);
    const stylesXml = await zip.file('word/styles.xml')?.async('string');
    if (!stylesXml) return null;
    const styles = parser.parse(stylesXml)?.styles;
    if (!styles) return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const docDefaults: any = styles.docDefaults?.rPrDefault?.rPr;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const normal: any = findStyle(styles, 'Normal');

    // ---- 字体 ----
    const rFonts = normal?.rPr?.rFonts ?? docDefaults?.rFonts;
    const bodyFontFamily = rFonts?.['@_eastAsia'] || rFonts?.['@_ascii'] || undefined;

    // ---- 字号（半磅 → pt） ----
    const sz = Number(normal?.rPr?.sz?.['@_val'] ?? docDefaults?.sz?.['@_val'] ?? NaN);
    const bodyFontSize = Number.isFinite(sz) && sz > 0 ? sz / 2 : undefined;

    // ---- 行距 ----
    const spacing = normal?.pPr?.spacing ?? docDefaults?.pPrDefault?.pPr?.spacing;
    let lineSpacing: string | undefined;
    if (spacing?.['@_line'] && spacing['@_lineRule']) {
      const line = Number(spacing['@_line']);
      const rule = spacing['@_lineRule'];
      if (rule === 'auto' && Number.isFinite(line)) lineSpacing = String(line / 240);
      else if (Number.isFinite(line)) lineSpacing = `${line / 20}pt`;
    }

    // ---- 首行缩进（firstLineChars 优先，字符单位 /100） ----
    const ind = normal?.pPr?.ind;
    let firstLineIndent: number | undefined;
    if (ind?.['@_firstLineChars']) {
      const chars = Number(ind['@_firstLineChars']) / 100;
      if (Number.isFinite(chars) && chars > 0) firstLineIndent = chars;
    } else if (ind?.['@_firstLine']) {
      // twips → 字符（按 12pt 字符 ≈ 240 twips 估算）
      const twips = Number(ind['@_firstLine']);
      if (Number.isFinite(twips) && twips > 0) firstLineIndent = Math.round((twips / 240) * 10) / 10;
    }

    // ---- 对齐 ----
    const jc = normal?.pPr?.jc?.['@_val'];
    const bodyAlign: FormatProfile['bodyAlign'] = jc === 'both' || jc === 'justify' ? 'justify' : jc === 'left' ? 'left' : undefined;

    const parts: string[] = [];
    if (bodyFontFamily) parts.push(bodyFontFamily);
    if (bodyFontSize) parts.push(`${bodyFontSize}pt`);
    if (lineSpacing) parts.push(`行距 ${lineSpacing}`);
    if (firstLineIndent) parts.push(`首行缩进 ${firstLineIndent} 字符`);
    if (bodyAlign === 'justify') parts.push('两端对齐');

    return {
      bodyFontFamily,
      bodyFontSize,
      lineSpacing,
      firstLineIndent,
      bodyAlign,
      summary: parts.length ? parts.join(' · ') : '未识别到明确的正文格式（已按通用规范整理）',
    };
  } catch {
    return null;
  }
}

/** 在 styles 中按 styleId 或名称找样式定义 */
function findStyle(styles: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const list = Array.isArray(styles.style) ? styles.style : styles.style ? [styles.style] : [];
  for (const s of list as Record<string, unknown>[]) {
    if (s['@_styleId'] === name || s['@_name'] === name) return s;
  }
  // 兜底：默认段落样式（w:default="1" 且 type paragraph）
  for (const s of list as Record<string, unknown>[]) {
    if (s['@_default'] === '1' && s['@_type'] === 'paragraph') return s;
  }
  return undefined;
}
