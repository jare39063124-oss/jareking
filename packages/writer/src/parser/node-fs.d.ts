/**
 * 最小化的 node:fs/promises 环境声明。
 *
 * T1.2 解析器运行于 Node/Electron 主进程，需要用 fs 读取 .docx 文件。
 * 沙箱未安装 @types/node（writer 的 tsconfig 也设置了 "types": []），
 * 故在此为 parseDocxFile 仅用到的 readFile 提供最小类型声明，
 * 不引入整个 @types/node。
 */
declare module 'node:fs/promises' {
  /** 读取文件为二进制（运行时返回 Buffer，此处按 Uint8Array 暴露，二者兼容） */
  export function readFile(path: string): Promise<Uint8Array>;
}
