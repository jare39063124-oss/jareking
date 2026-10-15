/**
 * pdfRender —— 渲染进程侧 PDF 页面渲染（PDF 转图片）。
 *
 * 用 pdf.js（浏览器主构建 + Web Worker）把每一页光栅化为 PNG。
 * 与 @jareking/pdf 的 pdfToText（Node/legacy，纯文本提取）互补：
 * 文本提取不需要画布，而渲染必须在有 DOM canvas 的渲染进程完成。
 *
 * 注：复杂字体（CID/CJK）若缺标准字体数据可能字形偏差，v1 用 useSystemFonts
 * 让 Chromium 回退系统字体；后续如需完美字形可补 standardFontDataUrl。
 */
import * as pdfjsLib from 'pdfjs-dist';

// Web Worker：Vite/electron-vite 会把该资源打包并注入正确 URL
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

export interface RenderedPage {
  page: number;
  /** PNG 字节流 */
  png: Uint8Array;
  width: number;
  height: number;
}

/**
 * 把 PDF 每一页渲染为 PNG。
 * @param bytes PDF 文件字节
 * @param scale 渲染缩放（默认 2，A4 双精度，约 168dpi 观感）
 */
export async function pdfToImages(bytes: Uint8Array, scale = 2): Promise<RenderedPage[]> {
  const doc: any = await pdfjsLib.getDocument({ data: bytes, useSystemFonts: true }).promise;
  const out: RenderedPage[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('无法创建画布上下文');
      // 白底（PDF 透明区域填充白，避免 PNG 透明黑底）
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob: Blob = await new Promise((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob 失败'))),
          'image/png',
        ),
      );
      const buf = new Uint8Array(await blob.arrayBuffer());
      out.push({ page: i, png: buf, width: canvas.width, height: canvas.height });
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return out;
}
