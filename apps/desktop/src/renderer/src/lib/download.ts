/**
 * download —— 渲染进程统一「浏览器下载」助手（公共能力下沉）。
 *
 * 背景（问题）：下载动作（`URL.createObjectURL` + `<a download>` + click + revoke）
 *   曾在 `PdfToolbox` / `SheetEditor` / `SlideEditor` / `WriterEditor` 各自复制一份，
 *   属重复实现，违反根目录 `AGENTS.md` 铁律 1.1「单一来源」。此处收敛为唯一实现，
 *   各模块 `import` 复用，杜绝「改一处漏一处」。
 *
 * 提供两个入口：
 *   - `downloadBlob`：从字节 / Blob 直接下载（xlsx / docx / pptx / pdf / csv / txt…）；
 *   - `downloadDataUrl`：从 dataURL 下载（图表 PNG 等内存图片）。
 *
 * 说明：
 *   - 仅渲染进程可用（依赖浏览器 `URL.createObjectURL` / `<a download>`）。
 *   - `Blob` 的 object URL 在触发点击后**延迟回收**（4s），确保下载已真正启动，
 *     避免个别浏览器在同步 revoke 后中断下载。
 */

/** 触发浏览器下载（Blob）。mime 默认 application/octet-stream */
export function downloadBlob(
  data: Uint8Array | Blob,
  filename: string,
  mime = 'application/octet-stream',
): void {
  // Uint8Array（ArrayBufferLike）与 BlobPart 类型不完全重叠，断言不改变运行时行为
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  triggerAnchorClick(url, filename);
  // 延迟回收，确保下载已触发
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 触发 dataURL 下载（图表 PNG 等） */
export function downloadDataUrl(dataUrl: string, filename: string): void {
  triggerAnchorClick(dataUrl, filename);
}

/** 内部：创建临时 `<a download>` 触发一次点击（URL / dataURL 共用） */
function triggerAnchorClick(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
