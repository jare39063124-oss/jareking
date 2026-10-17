/**
 * node:path shim —— 纯字符串实现（WebView 无 path 模块）。
 * 只覆盖项目实际用到的少量 API；不存在的行为一律抛错，避免静默错误。
 */
export function normalize(p: string): string {
  const abs = p.startsWith('/');
  const parts: string[] = [];
  for (const seg of p.split(/[\\/]+/)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (parts.length && parts[parts.length - 1] !== '..') parts.pop();
      else if (!abs) parts.push('..');
      continue;
    }
    parts.push(seg);
  }
  return (abs ? '/' : '') + parts.join('/');
}

export function join(...segments: string[]): string {
  return normalize(segments.filter(Boolean).join('/'));
}

export function dirname(p: string): string {
  const n = normalize(p.replace(/[\\/]+$/, ''));
  const i = n.lastIndexOf('/');
  if (i < 0) return '.';
  return i === 0 ? '/' : n.slice(0, i);
}

export function basename(p: string, ext?: string): string {
  const n = p.split(/[\\/]+/).pop() ?? '';
  return ext && n.endsWith(ext) ? n.slice(0, -ext.length) : n;
}

export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i);
}

export function resolve(...segments: string[]): string {
  return normalize(segments.filter(Boolean).join('/'));
}

export const sep = '/';

export default { normalize, join, dirname, basename, extname, resolve, sep };
