/**
 * pdfExport（主进程）—— Electron 原生打印管线：HTML → PDF 字节。
 *
 * 流程：把渲染层生成的打印 HTML 写入临时文件 → 隐藏 BrowserWindow.loadFile
 *   → 等待 did-finish-load（含 30s 超时兜底 / did-fail-load reject）
 *   → webContents.printToPDF（选项由 shared/pdfPrint.buildPrintToPdfOptions 组装）
 *   → 返回 PDF 字节（Uint8Array，structured clone 可跨进程）。
 *
 * 约束：
 *  - 仅用 electron + node 内置模块（fs/os/path），零新依赖。
 *  - 隐藏窗口关闭 JS（javascript:false）作纵深防御：打印内容由本应用自身生成。
 *  - finally 中必定销毁窗口并删除临时文件（失败也不覆盖原始错误）。
 */
import { BrowserWindow } from 'electron';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPrintToPdfOptions, type HtmlPdfRequest } from '../../shared/pdfPrint.js';

/** 加载打印内容的超时上限（30s）：避免 loadFile 异常时永久挂起 */
const LOAD_TIMEOUT_MS = 30_000;

/**
 * 把打印 HTML 渲染为 PDF 字节。
 *
 * @param req 渲染层发来的导出请求（html 必填）
 * @returns PDF 字节
 * @throws html 为空 / 加载失败 / 加载超时 / printToPDF 失败
 */
export async function htmlToPdfBuffer(req: HtmlPdfRequest): Promise<Uint8Array> {
  if (!req || typeof req.html !== 'string' || req.html.length === 0) {
    throw new Error('打印内容为空');
  }

  const tmpPath = join(
    tmpdir(),
    `jareking-print-${Date.now()}-${Math.random().toString(36).slice(2)}.html`,
  );
  writeFileSync(tmpPath, req.html, 'utf8');

  const win = new BrowserWindow({
    show: false,
    width: 794,
    height: 1123,
    webPreferences: {
      // 纵深防御：打印内容为本应用生成，关闭 JS 减少攻击面
      javascript: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  try {
    // 等待页面加载完成（did-finish-load）或失败（did-fail-load），并加超时兜底
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('加载打印内容超时'));
      }, LOAD_TIMEOUT_MS);

      win.webContents.once('did-finish-load', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
      win.webContents.once('did-fail-load', (_event, errorCode, errorDescription) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`加载打印内容失败（${errorCode}）：${errorDescription}`));
      });

      void win.loadFile(tmpPath);
    });

    // Electron 44：printToPDF 返回 Buffer；页面尺寸/页边距单位见 buildPrintToPdfOptions 注释
    const pdf = await win.webContents.printToPDF(buildPrintToPdfOptions(req));
    // Buffer → Uint8Array（保证 structured clone 跨进程传递为纯 Uint8Array）
    return new Uint8Array(pdf);
  } finally {
    try {
      win.destroy();
    } catch {
      /* 窗口可能已销毁，忽略 */
    }
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* 清理失败不影响返回结果/原始错误 */
    }
  }
}
