/**
 * 外部文件打开消费者（双击关联文件 → 直达编辑器）。
 *
 * 数据流（跨平台统一，两条来源）：
 *  - **macOS**：LaunchServices 派发 `open-file` → 主进程入队（不新起进程）；
 *  - **Windows / Linux**：第二个实例启动 → `second-instance` 的 argv 入队。
 * 两条来源最终都由主进程 `doc:pending:take`（取走即清空）交给本模块，
 * 再走既有 `setPendingOpen + openTab` 机制，由目标编辑器挂载时消费并解析真实文件
 * —— **不新增各编辑器的打开路径**（复用 recoveryStore 已验证的同一条链路）。
 *
 * 调用时机（由 App.tsx 负责）：
 *  1. 渲染层挂载后一次（冷启动双击文件：事件在 ready 前已入队）；
 *  2. `window` 获得焦点时（应用已在运行，用户再次双击文件）。
 *
 * 已知限制：`pendingOpenStore` 为**单槽**语义（同一时刻只挂一个待打开文件），
 * 故一次收到多个文件时只打开第一个，其余明确提示用户，而不是静默丢弃或错配到别的标签。
 */
import { setPendingOpen } from '../stores/pendingOpenStore';
import { useTabStore, type DocModule } from '../stores/tabStore';
import { toast } from '../stores/toastStore';

/** 受支持扩展名 → 模块（**演示固定为 'slide'**，铁律 1.1） */
const EXT_TO_MODULE: Record<string, DocModule> = {
  doc: 'writer',
  docx: 'writer',
  xls: 'sheet',
  xlsx: 'sheet',
  ppt: 'slide',
  pptx: 'slide',
  pdf: 'pdf',
};

/** 按扩展名推断模块（不支持返回 null） */
export function moduleFromPath(filePath: string): DocModule | null {
  const lower = filePath.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return null;
  return EXT_TO_MODULE[lower.slice(dot + 1)] ?? null;
}

/** 取文件名（兼容 Windows `\` 与 POSIX `/` 分隔符） */
export function baseNameOf(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return idx >= 0 ? filePath.slice(idx + 1) : filePath;
}

/**
 * 拉取并消费主进程的待打开文件队列。
 *
 * 幂等、可重复调用（队列空时直接返回）。任何异常都吞掉并返回 false，
 * 绝不让「外部打开」这条旁路影响应用启动。
 *
 * @returns 是否真的打开了文件
 */
export async function consumePendingOpenFiles(): Promise<boolean> {
  try {
    const api = window.jareking;
    // 非 Electron 环境（单测 / 纯浏览器预览）直接跳过
    if (!api?.invoke || !api.IPC?.DOC_PENDING_TAKE) return false;

    const paths = await api.invoke<string[]>(api.IPC.DOC_PENDING_TAKE);
    if (!Array.isArray(paths) || paths.length === 0) return false;

    // 过滤出可处理项（主进程已过滤过扩展名，这里再挡一层，防契约变更后漏判）
    const openable = paths.filter((p) => moduleFromPath(p) !== null);
    if (openable.length === 0) return false;

    const first = openable[0] as string;
    const module = moduleFromPath(first);
    if (!module) return false;

    const name = baseNameOf(first);
    setPendingOpen({ module, path: first, name });
    useTabStore.getState().openTab(module, name);

    // 多文件场景：单槽 pendingOpen 只能挂一个，其余如实告知（不静默丢弃）
    if (openable.length > 1) {
      toast.info(
        `已打开「${name}」，另有 ${openable.length - 1} 个文件未打开（请逐个双击或使用「打开」入口）`,
      );
    }
    return true;
  } catch {
    // 外部打开属于增强体验：失败静默，不影响主流程
    return false;
  }
}
