/**
 * Node 内置模块 shim（WebView 环境）。
 *
 * 背景：`packages/core` 的持久层（sql.js + node:fs）是桌面实现，移动端改用 IndexedDB。
 * 但 `@jareking/core` 是 barrel 导出，打包期仍会解析到这些模块——因此用 shim 顶替，
 * 保证「能打包」；一旦运行期真的被调用，会抛出可定位的错误而不是静默失败。
 */

const message = (name: string): never => {
  throw new Error(`[jareking-mobile] node:${name} 在移动端不可用（持久层请用 src/storage）`);
};

export const existsSync = (): boolean => false;
export const mkdirSync = (): void => message('fs.mkdirSync');
export const readFileSync = (): never => message('fs.readFileSync');
export const writeFileSync = (): never => message('fs.writeFileSync');
export const unlinkSync = (): never => message('fs.unlinkSync');
export const readdirSync = (): never => message('fs.readdirSync');
export const statSync = (): never => message('fs.statSync');
export const createReadStream = (): never => message('fs.createReadStream');
export const createWriteStream = (): never => message('fs.createWriteStream');
export const promises = {
  readFile: async (): Promise<never> => message('fs/promises.readFile'),
  writeFile: async (): Promise<never> => message('fs/promises.writeFile'),
  mkdir: async (): Promise<never> => message('fs/promises.mkdir'),
  unlink: async (): Promise<never> => message('fs/promises.unlink'),
  readdir: async (): Promise<never> => message('fs/promises.readdir'),
  stat: async (): Promise<never> => message('fs/promises.stat'),
};
export const writeFile = async (): Promise<never> => message('fs/promises.writeFile');
export const readFile = async (): Promise<never> => message('fs/promises.readFile');

export default {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  statSync,
  promises,
};
