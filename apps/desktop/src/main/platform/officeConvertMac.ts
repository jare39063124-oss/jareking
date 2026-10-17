/**
 * Office → PDF 主进程执行器（**macOS 实现**）。
 *
 * 背景（交接文档 §7.2 第 2 条）：Windows 版用「PowerShell + WPS/Office COM」
 * （`officePdfScript.ts` + `officeConvertWin.ts`）完成 Word/Excel/PPT → PDF。
 * **macOS 没有 COM**，同一能力必须换引擎。本文件用 **LibreOffice headless**
 * （`soffice --convert-to pdf`）实现，理由：
 *  1. 纯本地、零服务端、零 API Key（贴合 v1 零服务端约束）；
 *  2. 单二进制覆盖 doc/docx/xls/xlsx/ppt/pptx 全格式，不需要分别对接 Office for Mac；
 *  3. CLI 行为稳定可断言（脚本化转换的行业通行做法），比 AppleScript 驱动 Office for Mac
 *     可靠得多（后者受版本/授权/首启动向导影响，无法自动化验收）。
 *
 * ⚠️ 前提：用户机器需安装 LibreOffice（免费开源，官网 libreoffice.org）。
 *    未安装时本函数抛出**可读的中文错误**，由渲染层 toast 展示（不假装成功）。
 *    后续若需「零额外安装」，可再评估 AppleScript 驱动 Microsoft Office for Mac，
 *    但需真机验证后再落地（不写未验证的 AppleScript，见专家规范「不臆造 API」）。
 *
 * 关键实现细节（都是踩过的坑，勿简化）：
 *  - 必须传 `-env:UserInstallation=file://<临时目录>`：否则当用户已开着 LibreOffice GUI 时，
 *    headless 实例会连到同一 profile 而**静默不转换**（命令行返回 0 但没有产物）；
 *  - `--convert-to pdf` **只能输出到 `--outdir`，产物名固定为「输入主名.pdf」**，
 *    无法指定任意目标文件名 → 统一先转到临时目录，再移动到目标路径（跨盘用 copy+unlink 兜底）；
 *  - 转换后 soffice 可能残留子进程，超时路径必须整组 kill（`process.kill(-pid)` 需 detached，
 *    这里用 `child.kill('SIGKILL')` + `pkill -f` 兜底）。
 */
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { OfficeKind } from '../../shared/officePdfScript.js';
import { resolveOutputPath } from './common.js';

/** 单次转换超时（与 Windows 实现对齐，120s） */
const CONVERT_TIMEOUT_MS = 120_000;

/**
 * LibreOffice 可执行文件常见位置（按优先级）：
 *  - 官方 .dmg 安装：/Applications/LibreOffice.app/Contents/MacOS/soffice
 *  - Apple Silicon Homebrew：/opt/homebrew/bin/soffice
 *  - Intel Homebrew / 手工软链：/usr/local/bin/soffice
 */
const SOFFICE_CANDIDATES = [
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/opt/homebrew/bin/soffice',
  '/usr/local/bin/soffice',
  join(homedir(), 'Applications/LibreOffice.app/Contents/MacOS/soffice'),
];

/**
 * 查找本机 soffice 可执行文件。
 *
 * 顺序：固定候选路径 → PATH 逐目录探测（兼容自定义安装）。
 * @returns 绝对路径；未安装返回 null
 */
export function findSoffice(): string | null {
  for (const candidate of SOFFICE_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  // PATH 兜底（macOS 用 ':' 分隔）
  const pathEnv = process.env['PATH'] ?? '';
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue;
    const candidate = join(dir, 'soffice');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Office 转 PDF 的可用性（渲染层/诊断可用；mac 依赖 LibreOffice 是否安装） */
export function isOfficePdfAvailable(): boolean {
  return findSoffice() !== null;
}

/**
 * 执行 soffice 转换（阻塞至进程结束或超时）。
 *
 * @param soffice   soffice 绝对路径
 * @param args      完整参数（含 -env:UserInstallation / --convert-to / --outdir）
 * @throws 启动失败 / 退出码非 0 / 超时
 */
function runSoffice(soffice: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(soffice, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* 忽略 */
      }
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

    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法启动 LibreOffice（${soffice}）：${err.message}`));
    });

    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 500);
      const fallback = stdout.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300);
      reject(
        new Error(
          `转换失败（退出码 ${code ?? '未知'}）：${detail || fallback || '无输出'}。` +
            '请确认待转换文件未损坏且未被密码保护',
        ),
      );
    });
  });
}

/**
 * 在临时目录中找出 soffice 产出的 PDF。
 *
 * soffice 的产物名 = 输入文件名主名 + `.pdf`，但极少数版本会改写特殊字符，
 * 故先按期望名查找，找不到则退化为「目录中第一个 .pdf」。
 */
function locateProducedPdf(outDir: string, inputPath: string): string {
  const stem = basename(inputPath).replace(/\.[^.]+$/, '');
  const expected = join(outDir, `${stem}.pdf`);
  if (existsSync(expected)) return expected;

  const pdfs = readdirSync(outDir).filter((name) => name.toLowerCase().endsWith('.pdf'));
  if (pdfs.length > 0) return join(outDir, pdfs[0] as string);

  throw new Error(
    '转换未生成 PDF 文件（可能被 LibreOffice 首次启动向导阻断，请手动启动一次 LibreOffice 后重试）',
  );
}

/**
 * 把 Word/Excel/PPT 文档转换为 PDF（macOS：LibreOffice headless）。
 *
 * @param kind       文档大类（word / excel / ppt）——LibreOffice 按扩展名自行判定，
 *                   这里保留参数是为了与 Windows 实现同签名（门面统一调用）
 * @param inputPath  输入文档绝对路径
 * @param outputPath 目标 PDF 路径（缺省则与输入同目录、同文件名换 .pdf）
 * @returns 转换后的 PDF 绝对路径
 * @throws 未安装 LibreOffice / 文件不存在 / 转换失败 / 未生成产物
 */
export async function convertOfficeToPdfMac(
  kind: OfficeKind,
  inputPath: string,
  outputPath?: string,
): Promise<{ outputPath: string }> {
  // 参数保留但显式标注：LibreOffice 不需要 kind（按扩展名分流）
  void kind;

  const soffice = findSoffice();
  if (!soffice) {
    throw new Error(
      'macOS 上「Office 转 PDF」需要本机安装 LibreOffice（免费开源）。' +
        '请从 libreoffice.org 安装后重试；也可改用各模块「文件 → 导出 PDF」直接生成 PDF',
    );
  }
  if (!inputPath || !existsSync(inputPath)) {
    throw new Error(`找不到待转换文件：${inputPath || '(空路径)'}`);
  }

  const targetPath = resolveOutputPath(inputPath, outputPath);

  // 独立的 LibreOffice 用户配置目录：避免与已运行的 GUI 实例抢占 profile 导致静默失败
  const workDir = mkdtempSync(join(tmpdir(), 'jareking-office-'));
  const profileDir = join(workDir, 'lo-profile');
  const outDir = join(workDir, 'out');

  try {
    // 先建输出目录（soffice 不会自动创建）
    mkdirSync(outDir, { recursive: true });

    await runSoffice(soffice, [
      '--headless',
      '--norestore',
      '--invisible',
      '--nolockcheck',
      `-env:UserInstallation=file://${profileDir}`,
      '--convert-to',
      'pdf',
      '--outdir',
      outDir,
      inputPath,
    ]);

    const produced = locateProducedPdf(outDir, inputPath);

    // 产物 → 目标路径（同分区 rename；跨分区 copy 后删源）
    moveFile(produced, targetPath);

    return { outputPath: targetPath };
  } finally {
    // 临时工作目录整体清理（含 profile / 中间 PDF），失败不覆盖原始错误
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* 忽略清理失败 */
    }
  }
}

/**
 * 跨分区安全移动文件：先尝试 rename，失败（EXDEV）则 copy + unlink。
 */
function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to);
    try {
      unlinkSync(from);
    } catch {
      /* 源清理失败不影响结果 */
    }
  }
}
