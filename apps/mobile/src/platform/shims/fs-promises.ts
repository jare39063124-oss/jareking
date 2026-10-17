/**
 * node:fs/promises shim —— 移动端无文件系统直读能力
 * （文件字节统一走 Web 层：`<input type=file>` → File 对象 → ArrayBuffer）。
 */
const fail = (name: string): never => {
  throw new Error(`[jareking-mobile] node:fs/promises.${name} 不可用：请使用文件选择器 / IndexedDB`);
};

export const readFile = async (): Promise<never> => fail('readFile');
export const writeFile = async (): Promise<never> => fail('writeFile');
export const mkdir = async (): Promise<never> => fail('mkdir');
export const unlink = async (): Promise<never> => fail('unlink');
export const readdir = async (): Promise<never> => fail('readdir');
export const stat = async (): Promise<never> => fail('stat');
export const copyFile = async (): Promise<never> => fail('copyFile');
export const access = async (): Promise<never> => fail('access');

export default { readFile, writeFile, mkdir, unlink, readdir, stat, copyFile, access };
