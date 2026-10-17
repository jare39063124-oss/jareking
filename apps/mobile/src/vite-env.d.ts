/**
 * 移动端全局类型声明。
 * `window.jareking` 由 src/platform/index.ts 在启动时安装（形状与 desktop preload 一致）。
 *
 * 注意：本文件含 import，属**模块**，因此全局声明必须写在 `declare global` 内，
 * 否则 ImportMeta 增强不会对 @renderer 下的源码生效（WriterEditor 会报 `env` 不存在）。
 */
import type { JarekingApi } from './platform';

declare global {
  interface Window {
    jareking: JarekingApi;
  }

  /** Vite 注入的环境变量（渲染层会读 BASE_URL 拼 public 资源路径） */
  interface ImportMetaEnv {
    readonly BASE_URL: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

/** Vite 资源导入（与 desktop 一致） */
declare module '*?url' {
  const src: string;
  export default src;
}

export {};
