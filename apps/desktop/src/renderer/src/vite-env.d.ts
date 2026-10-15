/**
 * Vite 客户端环境类型声明。
 * 渲染进程经 Vite 打包，资源可用 `import url from '...?url'` 形式导入。
 * 这里仅声明 `*?url` 模块（返回资源 URL 字符串）与 `import.meta.env` 中用到的
 * 环境变量字段，不依赖 vite/client 全量类型，避免跨包解析差异。
 */
declare module '*?url' {
  const src: string;
  export default src;
}

/** Vite 注入的环境变量（仅声明渲染进程实际用到的字段） */
interface ImportMetaEnv {
  /** 应用基础路径（Vite 注入，末尾带 `/`），用于拼接 public 资源 URL */
  readonly BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
