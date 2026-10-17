/**
 * node:crypto shim —— 用 Web Crypto 等价实现（Android WebView 支持 crypto.randomUUID，
 * 但仅在 secure context；Capacitor 使用 https://localhost 满足该条件，另留降级实现）。
 */
export function randomUUID(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // 降级：Math.random 拼装（仅用于本地主键，不用于安全场景）
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

export function randomBytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(out);
  else for (let i = 0; i < size; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

export default { randomUUID, randomBytes };
