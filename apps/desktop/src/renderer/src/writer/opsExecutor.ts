/**
 * Writer ops Executor（T4.3）——把 Planner 输出的 ops 确定性应用到 TipTap 编辑器。
 *
 * 原则：AI 永远不直接改文档；此处是唯一执行点，每个 op 独立 try/catch，
 * 失败跳过并记录（不中断后续 op）。执行完由调用方决定是否一次 undo 兜底。
 */
import type { Editor } from '@tiptap/react';
import type { WriterOp } from '@jareking/ai';
import { getTemplate, type FormatTemplate } from '@jareking/ai';
import { renderChartToPng } from './chartRenderer';

export interface ApplyResult {
  applied: string[];
  skipped: { op: string; reason: string }[];
}

const normalizeColor = (c: string) => (c.startsWith('#') ? c : `#${c}`);

/** 无选区时 setColor/setFormat 的待应用格式（随下一次 insertText 以 marks 落盘） */
interface PendingMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export function applyWriterOps(editor: Editor, ops: WriterOp[]): ApplyResult {
  const applied: string[] = [];
  const skipped: ApplyResult['skipped'] = [];
  const pendingMarks: PendingMark[] = [];

  /** 无选区时把格式暂存为 pendingMark（TipTap stored mark 会被 insertContent 丢弃） */
  const stashMarkIfNoSelection = (): boolean => {
    const { empty } = editor.state.selection;
    return empty;
  };

  for (const op of ops) {
    try {
      switch (op.op) {
        case 'insertText': {
          if (pendingMarks.length) {
            editor
              .chain()
              .focus()
              .insertContent({ type: 'text', text: op.text, marks: pendingMarks.map((m) => ({ type: m.type, attrs: m.attrs ?? {} })) })
              .run();
            pendingMarks.length = 0;
          } else {
            editor.chain().focus().insertContent(op.text).run();
          }
          applied.push(op.op);
          break;
        }
        case 'replaceSelection': {
          // TipTap insertContent 天然替换当前选区
          editor.chain().focus().insertContent(op.text).run();
          applied.push(op.op);
          break;
        }
        case 'setFormat': {
          if (stashMarkIfNoSelection()) {
            pendingMarks.push({ type: op.mark, attrs: {} });
            applied.push(op.op);
            break;
          }
          const chain = editor.chain().focus();
          if (op.value) chain.setMark(op.mark).run();
          else chain.unsetMark(op.mark).run();
          applied.push(op.op);
          break;
        }
        case 'insertParagraph': {
          if (op.heading) {
            editor
              .chain()
              .focus()
              .insertContent({
                type: 'heading',
                attrs: { level: op.heading },
                content: op.text ? [{ type: 'text', text: op.text }] : [],
              })
              .run();
          } else {
            editor
              .chain()
              .focus()
              .insertContent({
                type: 'paragraph',
                content: op.text ? [{ type: 'text', text: op.text }] : [],
              })
              .run();
          }
          applied.push(op.op);
          break;
        }
        case 'insertTable': {
          editor
            .chain()
            .focus()
            .insertTable({ rows: op.rows, cols: op.cols, withHeaderRow: op.headerRow ?? false })
            .run();
          applied.push(op.op);
          break;
        }
        case 'setColor': {
          if (stashMarkIfNoSelection()) {
            // TipTap 的 Color 扩展不是独立 mark，颜色挂在 textStyle mark 的 color 属性上
            pendingMarks.push({ type: 'textStyle', attrs: { color: normalizeColor(op.color) } });
            applied.push(op.op);
            break;
          }
          editor.chain().focus().setColor(normalizeColor(op.color)).run();
          applied.push(op.op);
          break;
        }
        case 'clearFormatting': {
          editor.chain().focus().unsetAllMarks().run();
          applied.push(op.op);
          break;
        }
        case 'insertHorizontalRule': {
          editor.chain().focus().setHorizontalRule().run();
          applied.push(op.op);
          break;
        }
        case 'undo': {
          editor.chain().focus().undo().run();
          applied.push(op.op);
          break;
        }
        case 'redo': {
          editor.chain().focus().redo().run();
          applied.push(op.op);
          break;
        }
        case 'insertChart': {
          const dataUrl = renderChartToPng(op.chartType, op.labels, op.series, op.title);
          if (!dataUrl) {
            skipped.push({ op: op.op, reason: '图表渲染失败（canvas 不可用）' });
            break;
          }
          editor.chain().focus().setImage({ src: dataUrl, alt: op.title || '图表' }).run();
          applied.push(op.op);
          break;
        }
        case 'tidyDocument': {
          const count = applyTidy(editor, {
            firstLineIndent: op.firstLineIndent,
            lineSpacing: op.lineSpacing,
            bodyAlign: op.bodyAlign,
            bodyFontSize: op.bodyFontSize,
            bodyFontFamily: op.bodyFontFamily,
            collapseBlankLines: op.collapseBlankLines,
          });
          if (count.paragraphs === 0) {
            skipped.push({ op: op.op, reason: '未找到可整理的正文段落' });
          } else {
            applied.push(op.op);
          }
          break;
        }
        case 'applyTemplate': {
          const template = getTemplate(op.templateId);
          if (!template) {
            skipped.push({ op: op.op, reason: `未知模板 ${op.templateId}` });
            break;
          }
          applyTemplate(editor, template);
          applied.push(op.op);
          break;
        }
        case 'formatNumbers': {
          const count = applyThousandSeparators(editor, op.scope === 'selection');
          if (count === 0) {
            skipped.push({ op: op.op, reason: '未找到需要加千分符的数字' });
          } else {
            applied.push(op.op);
          }
          break;
        }
        default: {
          skipped.push({ op: JSON.stringify(op).slice(0, 60), reason: '未知操作' });
        }
      }
    } catch (err) {
      skipped.push({
        op: op.op,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { applied, skipped };
}

/* =========================================================================
 * 文档整理辅助（用户反馈 1：一键排版 / 模板 / 千分符）
 * ========================================================================= */

interface TidyParams {
  firstLineIndent: number;
  lineSpacing: string;
  bodyAlign: 'justify' | 'left';
  bodyFontSize?: number;
  bodyFontFamily?: string;
  collapseBlankLines: boolean;
}

/** 全文整理：段落缩进/行距/对齐 + 正文字体字号 + 清理连续空段 */
function applyTidy(editor: Editor, params: TidyParams): { paragraphs: number } {
  const { state, schema } = editor;
  const tr = state.tr;
  let paragraphs = 0;

  // 1. 清理连续空段（保留单个空段作为分隔）
  if (params.collapseBlankLines) {
    const emptyRanges: [number, number][] = [];
    let prevEmpty = false;
    state.doc.descendants((node, pos) => {
      if (node.type.name === 'paragraph' && node.content.size === 0) {
        if (prevEmpty) emptyRanges.push([pos, pos + node.nodeSize]);
        prevEmpty = true;
      } else if (node.type.name !== 'text') {
        prevEmpty = false;
      }
      return true;
    });
    for (const [from, to] of emptyRanges.reverse()) tr.delete(from, to);
  }

  // 2. 段落排版（标题保持各自对齐；正文统一）
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return true;
    const isHeading = node.type.name === 'heading';
    const attrs: Record<string, string | null> = {
      textIndent: isHeading || params.firstLineIndent === 0 ? null : `${params.firstLineIndent}em`,
      lineHeight: params.lineSpacing,
    };
    if (!isHeading) {
      // 已有居中/右对齐的段落保持原对齐，其余统一为 bodyAlign
      if (!node.attrs.textAlign || node.attrs.textAlign === 'left') {
        attrs.textAlign = params.bodyAlign;
      }
    }
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs });
    paragraphs++;

    // 3. 正文字号/字体（标题不动）
    if (!isHeading && (params.bodyFontSize || params.bodyFontFamily)) {
      const markAttrs: Record<string, string> = {};
      if (params.bodyFontSize) markAttrs.fontSize = `${params.bodyFontSize}pt`;
      if (params.bodyFontFamily) markAttrs.fontFamily = params.bodyFontFamily;
      const from = pos + 1;
      const to = pos + node.nodeSize - 1;
      if (to > from) tr.addMark(from, to, schema.marks.textStyle.create(markAttrs));
    }
    return true;
  });

  if (tr.docChanged) editor.view.dispatch(tr);
  return { paragraphs };
}

/** 套用格式模板：标题层级格式 + 正文 tidy 参数 */
function applyTemplate(editor: Editor, template: FormatTemplate): void {
  const { state, schema } = editor;
  const tr = state.tr;
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return true;
    const isHeading = node.type.name === 'heading';
    const level = isHeading ? Number(node.attrs.level ?? 1) : 0;
    const headingFmt = template.headings.find((h) => h.level === level);
    const attrs: Record<string, string | null> = {
      textIndent: isHeading ? null : `${template.tidy.firstLineIndent}em`,
      lineHeight: template.tidy.lineSpacing,
    };
    if (isHeading && headingFmt) {
      attrs.textAlign = headingFmt.align;
      const from = pos + 1;
      const to = pos + node.nodeSize - 1;
      if (to > from) {
        tr.addMark(from, to, schema.marks.textStyle.create({ fontFamily: headingFmt.fontFamily, fontSize: `${headingFmt.fontSize}pt` }));
        if (headingFmt.bold) tr.addMark(from, to, schema.marks.bold.create());
      }
    } else if (!isHeading) {
      if (!node.attrs.textAlign || node.attrs.textAlign === 'left') {
        attrs.textAlign = template.tidy.bodyAlign;
      }
      if (template.tidy.bodyFontSize || template.tidy.bodyFontFamily) {
        const markAttrs: Record<string, string> = {};
        if (template.tidy.bodyFontSize) markAttrs.fontSize = `${template.tidy.bodyFontSize}pt`;
        if (template.tidy.bodyFontFamily) markAttrs.fontFamily = template.tidy.bodyFontFamily;
        const from = pos + 1;
        const to = pos + node.nodeSize - 1;
        if (to > from) tr.addMark(from, to, schema.marks.textStyle.create(markAttrs));
      }
    }
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs });
    return true;
  });
  if (tr.docChanged) editor.view.dispatch(tr);
}

/**
 * 数字千分符：整数部分 ≥4 位的数字加逗号分隔。
 * 保护：已含逗号的数字跳过；小数部分不动；年份区间（2020-2026）按年号跳过（纯4位且前后是 - 或 / 时不加）。
 */
function applyThousandSeparators(editor: Editor, selectionOnly: boolean): number {
  const { state } = editor;
  const tr = state.tr;
  const range = selectionOnly ? { from: state.selection.from, to: state.selection.to } : null;
  let count = 0;

  state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true;
    if (range && (pos < range.from || pos + node.nodeSize > range.to)) return true;
    const text = node.text;
    // 匹配连续数字（可含已有的千分位逗号与小数点）
    const re = /(?<![\d.,])(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d{4,})(?![\d.])/g;
    let result = '';
    let last = 0;
    let m: RegExpExecArray | null;
    let localCount = 0;
    while ((m = re.exec(text))) {
      const raw = m[0];
      // 跳过：已含逗号（已格式化）；纯4位且位于区间符号旁（年份/编号，如 2020-2026、2024/10）
      if (raw.includes(',')) continue;
      if (/^\d{4}$/.test(raw)) {
        const before = text[m.index - 1];
        const after = text[m.index + 4];
        if (before === '-' || before === '/' || after === '-' || after === '/') continue;
      }
      const [intPart, decPart] = raw.split('.');
      if (intPart.length < 4) continue;
      const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (decPart ? `.${decPart}` : '');
      if (formatted === raw) continue;
      result += text.slice(last, m.index) + formatted;
      last = m.index + raw.length;
      localCount++;
    }
    if (localCount > 0) {
      result += text.slice(last);
      const from = pos;
      const to = pos + node.nodeSize;
      tr.replaceWith(from, to, state.schema.text(result, node.marks));
      count += localCount;
    }
    return true;
  });

  if (count > 0) editor.view.dispatch(tr);
  return count;
}
