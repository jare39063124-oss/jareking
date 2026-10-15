/**
 * pdfjs —— 渲染进程 pdf.js 单例（Web Worker 单点配置）。
 *
 * 与 lib/pdfRender.ts 共用同一份 worker 配置，避免「PDF 转图片」与「PDF 阅读器」
 * 各自 import 'pdfjs-dist' 后重复（或漂移）设置 workerSrc。
 *
 * Worker 通过 `new URL('...', import.meta.url)` 交给 Vite/electron-vite 打包并注入
 * 正确资源 URL（开发态与生产态一致）。
 */
import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

export { pdfjsLib };
