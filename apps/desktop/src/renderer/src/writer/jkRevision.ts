/**
 * jkRevision —— Writer 修订（track changes）的 TipTap 承载。
 *
 * 由两部分组成：
 *  1. `JkRevisionMark`（mark）：承载单段文本的修订属性，令 jareking 编辑器能
 *     「原样保留」`<w:ins>`/`<w:del>` 语义并按修订样式显示（插入=下划线/蓝，删除=删除线/红）。
 *     - parseHTML：识别 span[data-jk-rev]（由 jkToHtml 生成 / renderHTML 还原）
 *     - renderHTML：还原为带 data-jk-rev / data-jk-rev-author / data-jk-rev-date 的 span
 *     - 保存时 htmlToJk 读回 span[data-jk-rev] → `Run.revision`，writer 包再落盘为
 *       `<w:ins>`/`<w:del>`（删除文本用 `<w:delText>`）。四端字段口径一致。
 *  2. `JkTrackChanges`（Extension，仅含 ProseMirror 插件）：开启「修订模式」后，
 *     把用户输入的新文本标记为插入、把删除的内容转为「删除线保留」。**默认关闭**，
 *     由 WriterEditor 的 revisionMode 状态经 options.enabled 实时驱动。
 *
 * 设计说明：mark（数据承载）与插件（实时光标行为）分离——mark 需进入所有编辑器
 * （含页眉页脚）的共享扩展集合，而插件只挂主编辑器；同名会导致 TipTap 扩展重名报错，
 * 故二者拆成独立扩展，插件扩展不含任何 mark/node 定义。
 */
import { Mark, Extension, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { ReplaceStep } from '@tiptap/pm/transform';

/** 修订 mark 名称（命令总线 / htmlToJk 共用，避免魔法字符串） */
export const JK_REVISION_MARK = 'jkRevision';

/** track-changes 插件 key（便于将来按 key 取插件实例） */
export const trackChangesKey = new PluginKey('jkTrackChanges');

/** 插件自身产生的事务标记（避免 appendTransaction 递归） */
const TRACK_CHANGES_META = 'jk-track-changes';

/** 插入修订的显示样式（下划线 + 蓝色） */
const INSERT_STYLE = 'text-decoration:underline;color:#1D4ED8;';
/** 删除修订的显示样式（删除线 + 红色） */
const DELETE_STYLE = 'text-decoration:line-through;color:#DC2626;';

export const JkRevisionMark = Mark.create({
  name: JK_REVISION_MARK,

  // 选区边界处插入文本时不自动延伸修订范围（新文本由插件按需显式打标，避免误扩）
  inclusive: false,

  addAttributes() {
    return {
      /** 修订类型：insert=插入，delete=删除 */
      kind: {
        default: 'insert' as 'insert' | 'delete',
        parseHTML: (el: HTMLElement) =>
          el.getAttribute('data-jk-rev') === 'delete' ? 'delete' : 'insert',
        renderHTML: (attrs: Record<string, unknown>) => ({
          'data-jk-rev': attrs.kind === 'delete' ? 'delete' : 'insert',
        }),
      },
      /** 修订作者（对应 w:author） */
      author: {
        default: null as string | null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-jk-rev-author'),
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.author ? { 'data-jk-rev-author': String(attrs.author) } : {},
      },
      /** 修订时间（ISO，对应 w:date） */
      date: {
        default: null as string | null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-jk-rev-date'),
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.date ? { 'data-jk-rev-date': String(attrs.date) } : {},
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-jk-rev]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const kind = HTMLAttributes['data-jk-rev'] === 'delete' ? 'delete' : 'insert';
    const style = kind === 'delete' ? DELETE_STYLE : INSERT_STYLE;
    return [
      'span',
      mergeAttributes(HTMLAttributes, { class: `jk-rev jk-rev-${kind}`, style }),
      0,
    ];
  },
});

/** 修订插件配置项 */
export interface TrackChangesOptions {
  /** 是否处于修订模式（由 WriterEditor 的 revisionMode 实时读取） */
  enabled: () => boolean;
  /** 修订作者名（默认「我」） */
  author: () => string;
}

/**
 * 修订模式插件（仅主编辑器挂载）。
 *
 * 行为（开启时）：
 *  - 用户插入文本 → 给新内容加 `jkRevision(kind=insert)` 标记；
 *  - 用户删除内容 → 把被删内容以 `jkRevision(kind=delete)` 标记插回（保留痕迹）。
 *
 * 安全降级：仅在「单事务 + 单个 replace 步骤」的常见编辑下记录（输入 / 粘贴 / 删除），
 * 复杂事务（多步、多事务批处理）直接放行不改写，避免位置映射出错；任何异常均吞掉
 * 并返回 null，绝不影响正常编辑。修订模式默认关闭，普通编辑路径完全不受影响。
 */
export const JkTrackChanges = Extension.create<TrackChangesOptions>({
  name: 'jkTrackChanges',

  addOptions() {
    return {
      enabled: () => false,
      author: () => '我',
    };
  },

  addProseMirrorPlugins() {
    const getEnabled = this.options.enabled;
    const getAuthor = this.options.author;
    return [
      new Plugin({
        key: trackChangesKey,
        appendTransaction: (transactions, oldState, newState) => {
          if (!getEnabled()) return null;
          try {
            // 仅处理「单事务 + 单 replace 步骤」的常见编辑
            if (transactions.length !== 1) return null;
            const tr = transactions[0];
            if (!tr.docChanged) return null;
            if (tr.getMeta(TRACK_CHANGES_META)) return null; // 跳过本插件自身产生的事务
            if (tr.steps.length !== 1) return null;
            const step = tr.steps[0];
            if (!(step instanceof ReplaceStep)) return null;

            const markType = newState.schema.marks[JK_REVISION_MARK];
            if (!markType) return null;

            const size = step.slice.content.size;
            const mapped = step.getMap().map(step.from);
            const author = getAuthor();
            const date = new Date().toISOString();
            const out = newState.tr;
            let changed = false;

            if (size > 0) {
              // 插入：给新内容加「插入」修订标记
              out.addMark(mapped, mapped + size, markType.create({ kind: 'insert', author, date }));
              changed = true;
            } else if (step.from < step.to) {
              // 纯删除：把被删内容以「删除」修订标记插回（track changes 保留痕迹）
              const removed = oldState.doc.slice(step.from, step.to);
              if (removed.size > 0) {
                out.insert(mapped, removed.content);
                out.addMark(
                  mapped,
                  mapped + removed.size,
                  markType.create({ kind: 'delete', author, date }),
                );
                changed = true;
              }
            }

            if (!changed) return null;
            out.setMeta(TRACK_CHANGES_META, true);
            return out;
          } catch {
            // 任何异常都不得影响正常编辑：放弃本次修订记录
            return null;
          }
        },
      }),
    ];
  },
});
