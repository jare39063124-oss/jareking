/**
 * Writer ops Executor（T4.3）——把 Planner 输出的 ops 确定性应用到 TipTap 编辑器。
 *
 * 原则：AI 永远不直接改文档；此处是唯一执行点，每个 op 独立 try/catch，
 * 失败跳过并记录（不中断后续 op）。执行完由调用方决定是否一次 undo 兜底。
 */
import type { Editor } from '@tiptap/react';
import type { WriterOp } from '@jareking/ai';

export interface ApplyResult {
  applied: string[];
  skipped: { op: string; reason: string }[];
}

const normalizeColor = (c: string) => (c.startsWith('#') ? c : `#${c}`);

export function applyWriterOps(editor: Editor, ops: WriterOp[]): ApplyResult {
  const applied: string[] = [];
  const skipped: ApplyResult['skipped'] = [];

  for (const op of ops) {
    try {
      switch (op.op) {
        case 'insertText': {
          editor.chain().focus().insertContent(op.text).run();
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
