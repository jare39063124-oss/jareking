/**
 * pdfExport（渲染进程）—— 「导出 PDF」统一入口封装。
 *
 * 内部：调用主进程打印管线（IPC: pdf:export-html）拿到 PDF 字节，
 * 再交给统一下载助手 downloadBlob（与项目现有所有导出行为一致，且不弹原生对话框）。
 * 错误向上抛出，由调用方 toast 提示。
 */
import { downloadBlob } from './download';
import type { PrintPageSizeName } from '../../../shared/pdfPrint';

/** 「导出 PDF」请求（渲染层各编辑器构造） */
export interface ExportPdfOptions {
  /** 完整打印 HTML（由 buildPrintDocument 产出） */
  html: string;
  /** 下载文件名，缺省 '导出.pdf' */
  fileName?: string;
  /** 纸张规格，缺省 'A4'（主进程默认值一致） */
  pageSize?: PrintPageSizeName;
  /** 是否横向，缺省 false */
  landscape?: boolean;
  /** 页边距（毫米），缺省 15 */
  marginMm?: number;
}

/**
 * 调用主进程打印管线并把 PDF 交给统一下载助手。
 *
 * @returns 实际使用的文件名
 */
export async function exportHtmlToPdf(opts: ExportPdfOptions): Promise<string> {
  const fileName = opts.fileName ?? '导出.pdf';
  const bytes = await window.jareking.invoke<Uint8Array>(window.jareking.IPC.PDF_EXPORT_HTML, {
    html: opts.html,
    pageSize: opts.pageSize,
    landscape: opts.landscape,
    marginMm: opts.marginMm,
    fileName,
  });
  downloadBlob(bytes, fileName, 'application/pdf');
  return fileName;
}
