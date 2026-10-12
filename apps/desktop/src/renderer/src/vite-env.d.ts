/**
 * Vite 客户端环境类型声明。
 * 渲染进程经 Vite 打包，资源可用 `import url from '...?url'` 形式导入。
 * 这里仅声明 `*?url` 模块（返回资源 URL 字符串），不依赖 vite/client 全量类型，
 * 避免跨包解析差异。
 */
declare module '*?url' {
  const src: string;
  export default src;
}
