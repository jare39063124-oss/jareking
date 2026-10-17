/**
 * Office → PDF 主进程执行器（**Windows 实现**）。
 *
 * 职责：把 buildOfficePdfScript 生成的纯函数脚本落盘为临时 .ps1，
 * 再用 Node 内置 child_process.spawn 调 powershell.exe 执行，校验产物后返回路径。
 *
 * 约束：
 *  - 仅用 Node 内置模块（child_process / os / path / fs），不新增任何 npm 依赖；
 *  - COM 转换依赖本机安装 WPS / Microsoft Office，无头/沙箱环境无法实测，
 *    真实转换需在「本机已装 Office/WPS 的 Windows」上验收；
 *  - 本文件只被 `platform/officeConvert.ts`（门面）在 win32 下调用，
 *    自身不再做平台判断（平台判定单一来源在 `platform/index.ts`）。
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOfficePdfScript, type OfficeKind } from '../../shared/officePdfScript.js';
import { resolveOutputPath } from './common.js';

/** 单次转换的超时上限（120s）：超大文档/弹窗阻塞时兜底强杀 */
const CONVERT_TIMEOUT_MS = 120_000;

/**
 * 超时兜底：强杀指定进程及其子进程树。
 * 仅 kill(SIGKILL) 在 Windows 上未必能连带结束 COM 宿主子进程，
 * 故再调 taskkill /T 结束整棵树（含 WINWORD/EXCEL/POWERPNT）。
 */
function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
  } catch {
    /* 进程可能已退出，忽略 */
  }
}

/**
 * 执行已落盘的 PowerShell 脚本（阻塞至进程结束或超时）。
 * 退出码 0 视为成功；否则 reject，错误信息携带 stderr 片段便于定位。
 */
function runPowerShell(ps1Path: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', ps1Path],
      { windowsHide: true },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    // 超时兜底：强杀进程树并 reject（clearTimeout 在正常收尾路径执行）
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* 忽略 */
      }
      killProcessTree(child.pid);
      reject(
        new Error(
          `Office 转 PDF 超时（${Math.round(CONVERT_TIMEOUT_MS / 1000)}s）。` +
            '若文档过大，请拆分为较小文件后重试',
        ),
      );
    }, CONVERT_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // 进程无法启动（如 powershell.exe 不在 PATH）
    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法启动 PowerShell：${err.message}`));
    });

    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code === 0) {
        resolve();
        return;
      }

      // 取最后几行 stderr（通常是真正的 COM 错误），截断避免超长
      const detail = stderr.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 500);
      const fallback = stdout.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300);
      reject(
        new Error(
          `转换失败（退出码 ${code ?? '未知'}）：${detail || fallback || '无输出'}。` +
            '请确认已安装 Microsoft Office 或 WPS Office',
        ),
      );
    });
  });
}

/**
 * 把 Word/Excel/PPT 文档转换为 PDF（Windows：WPS/Office COM 自动化）。
 *
 * @param kind       文档大类（word / excel / ppt）
 * @param inputPath  输入文档绝对路径
 * @param outputPath 目标 PDF 路径（缺省则与输入同目录、同文件名换 .pdf）
 * @returns 转换后的 PDF 绝对路径
 * @throws 输入文件不存在 / PowerShell 执行失败 / 未生成产物
 */
export async function convertOfficeToPdfWin(
  kind: OfficeKind,
  inputPath: string,
  outputPath?: string,
): Promise<{ outputPath: string }> {
  if (!inputPath || !existsSync(inputPath)) {
    throw new Error(`找不到待转换文件：${inputPath || '(空路径)'}`);
  }

  const targetPath = resolveOutputPath(inputPath, outputPath);

  // 生成脚本 → 落盘临时 .ps1（带 UTF-8 BOM：Windows PowerShell 5.1 才按 UTF-8 解析中文错误串/注释）
  const script = buildOfficePdfScript({ kind, inputPath, outputPath: targetPath });
  const ps1Path = join(tmpdir(), `jareking-office-${Date.now()}.ps1`);
  writeFileSync(ps1Path, `\uFEFF${script}`, 'utf8');

  try {
    await runPowerShell(ps1Path);

    if (!existsSync(targetPath)) {
      throw new Error(
        '转换未生成 PDF 文件（可能被 WPS/Office 的弹窗阻断，或文档受密码保护）',
      );
    }
    return { outputPath: targetPath };
  } finally {
    // 清理临时脚本（失败也不覆盖原始错误）
    try {
      rmSync(ps1Path, { force: true });
    } catch {
      /* 忽略清理失败 */
    }
  }
}
