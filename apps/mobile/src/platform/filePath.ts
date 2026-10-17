/**
 * 伪路径与文件分类（纯函数，可单测）。
 *
 * 背景：Android 无法把 SAF 选中的文件映射成真实磁盘路径（`content://` 也不是稳定标识，
 * 且 WebView 拿不到 FD），因此移动端用 `jkfile://<id>/<文件名>` 作为文件的稳定身份，
 * 承担桌面端 `filePath` 的全部职责（最近列表主键、自动保存 documentId、崩溃恢复键）。
 */

/** 伪路径协议头 */
export const PSEUDO_SCHEME = 'jkfile://';

/** 文件模块分类（与 core 契约 DocModule 的取值保持一致：演示模块永远是 'slide'） */
export type FileModule = 'writer' | 'sheet' | 'slide' | 'pdf';
export type FileFormat = 'docx' | 'xlsx' | 'pptx' | 'pdf';

/** 生成伪路径 */
export function makePseudoPath(id: string, name: string): string {
  return `${PSEUDO_SCHEME}${id}/${encodeURIComponent(name)}`;
}

/** 解析伪路径；非本协议（如桌面遗留的 C:\ 路径）返回 null */
export function parsePseudoPath(path: string): { id: string; name: string } | null {
  if (!path.startsWith(PSEUDO_SCHEME)) return null;
  const rest = path.slice(PSEUDO_SCHEME.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const id = rest.slice(0, slash);
  const raw = rest.slice(slash + 1);
  if (!id || !raw) return null;
  try {
    return { id, name: decodeURIComponent(raw) };
  } catch {
    // 非法百分号编码：按原样使用，避免整条链路因文件名异常而失败
    return { id, name: raw };
  }
}

/** 扩展名 → 模块 / 格式（不支持的类型按 Writer 处理，由解析器给出真实诊断） */
export function classify(name: string): { module: FileModule; format: FileFormat } {
  const ext = (name.toLowerCase().split('.').pop() ?? '').trim();
  if (ext === 'xlsx') return { module: 'sheet', format: 'xlsx' };
  if (ext === 'pptx') return { module: 'slide', format: 'pptx' };
  if (ext === 'pdf') return { module: 'pdf', format: 'pdf' };
  return { module: 'writer', format: 'docx' };
}
