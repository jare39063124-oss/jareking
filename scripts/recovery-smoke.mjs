/**
 * recovery-smoke —— 「崩溃恢复（文档备份中心）」真实端到端冒烟。
 *
 * 与 scripts/pdf-export-smoke.mjs 同源的 CDP 自动化方式（Node ≥22 内置 WebSocket），
 * 但本脚本**自管 Electron 生命周期**，以覆盖「崩溃 → 重启」链路：
 *
 *   1) 清理残留 electron.exe → 用临时 user-data-dir 启动应用（--remote-debugging-port=9223 --jk-debug）；
 *   2) 阶段一：打开 Writer → 输入唯一文本 → 调 __jkWriterDebug.autosaveNow() →
 *      断言备份已落盘（__jkRecovery.list() 含该备份且 sizeBytes > 0）；
 *   3) taskkill /PID /T /F 强杀（模拟崩溃）→ 用**同一 user-data-dir** 重启；
 *   4) 阶段二：断言「文档备份中心」自动弹出且列表含该备份 → 点「恢复」→
 *      断言新标签页打开且文档内容为阶段一输入的文字；
 *   5) 断言两阶段 consoleErrors 为空；
 *   6) 清理临时 user-data-dir（可传 --keep 保留以便排查），并打印其位置。
 *
 * 用法（仓库根）：
 *   node scripts/recovery-smoke.mjs [--keep]
 * 前置：已执行 `pnpm build`（apps/desktop/out 就绪）。
 *
 * 退出码：0 通过；1 断言失败；2 脚本 / 启动 / 连接失败。
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PORT = 9223;
const KEEP = process.argv.includes('--keep');
const REPO_ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)));
const DESKTOP_DIR = join(REPO_ROOT, 'apps', 'desktop');
const TOKEN = `崩溃恢复冒烟-${Date.now().toString(36)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 解析 Electron 可执行文件绝对路径（electron 包在 Node 环境下即导出该路径） */
function resolveElectron() {
  try {
    const require = createRequire(join(DESKTOP_DIR, 'package.json'));
    return require('electron');
  } catch {
    // 回退：常见 Windows 布局
    return join(DESKTOP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
  }
}

/** 清理残留 Electron 进程（容忍失败） */
function killAllElectron() {
  try {
    execFileSync('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' });
  } catch {
    /* 无残留进程 / 非 Windows：忽略 */
  }
}

/** 按 PID 强杀进程树（模拟崩溃；容忍失败） */
function killPid(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* 已退出等：忽略 */
    }
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 忽略 */
    }
  }
}

/** 启动 Electron（返回 child）。关键：从 env 删除 ELECTRON_RUN_AS_NODE，否则会以纯 Node 模式运行。 */
function launch(userDataDir) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return spawn(
    resolveElectron(),
    ['.', `--remote-debugging-port=${PORT}`, '--jk-debug', `--user-data-dir=${userDataDir}`],
    { cwd: DESKTOP_DIR, env, stdio: 'inherit' },
  );
}

/** 轮询查找 Electron 主窗口页面目标 */
async function findPage() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = (await res.json()).filter((t) => t.type === 'page');
      const page = targets.find((t) => !t.url.startsWith('devtools'));
      if (page) return page;
    } catch {
      /* 未就绪，重试 */
    }
    await sleep(500);
  }
  throw new Error('未找到 Electron 页面目标（应用未启动或调试端口未开）');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.exceptions = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const { type, args } = msg.params;
        if (type === 'error') {
          this.consoleErrors.push(args.map((a) => a.value ?? a.description ?? '').join(' '));
        }
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(
          msg.params.exceptionDetails?.exception?.description ?? 'unknown',
        );
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    }
    return r.result?.value;
  }

  async waitFor(expression, { timeoutMs = 25000, intervalMs = 800 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await this.eval(expression);
        if (last) return last;
      } catch {
        /* 上下文可能仍在切换，忽略后重试 */
      }
      await sleep(intervalMs);
    }
    return last;
  }
}

/** 与 gui-smoke 同口径的可忽略噪声 */
function pickIgnorable(text) {
  const t = String(text);
  return (
    t.includes('favicon') ||
    t.includes('Autofill') ||
    t.includes('nsresult') ||
    t.includes('GPU') ||
    t.includes('gpu')
  );
}

/** 连接 CDP：等应用根就绪后返回 { cdp, page } */
async function connect() {
  const page = await findPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.waitFor(
    `!!document.querySelector('#root') && document.querySelector('#root').children.length > 0`,
  );
  return cdp;
}

/** 打开「文字」模块（点击空状态的新建按钮），并等待编辑器内容就绪 */
async function openWriterTab(cdp) {
  await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('文字'));
    if (btn) btn.click();
    return !!btn;
  })()`);
  return cdp.waitFor(
    `typeof window.__jkWriterDebug?.autosaveNow === 'function' && (window.__jkWriterDebug?.text?.()?.length ?? 0) > 0`,
  );
}

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'jk-recovery-smoke-'));
  console.log(`临时 user-data-dir: ${userDataDir}`);
  const result = { phase1: {}, phase2: {}, consoleErrors: [] };
  let failed = false;
  const allErrors = [];

  killAllElectron();

  try {
    /* ------------------------- 阶段一：编辑并落盘备份 ------------------------- */
    let child = launch(userDataDir);
    let cdp = await connect();

    const writerReady = await openWriterTab(cdp);
    console.log(`[阶段一] Writer 就绪=${!!writerReady}`);

    const typed = await cdp.eval(`(() => {
      const el = document.querySelector('.jk-prose');
      if (!el) return 'no-editor';
      el.focus();
      const ok = document.execCommand('insertText', false, ${JSON.stringify(TOKEN)});
      return ok ? 'typed' : 'exec-failed';
    })()`);
    console.log(`[阶段一] 输入结果=${typed}`);

    const textOk = await cdp.waitFor(
      `(window.__jkWriterDebug?.text?.() ?? '').includes(${JSON.stringify(TOKEN)})`,
    );

    const savedSize = await cdp.eval(`window.__jkWriterDebug.autosaveNow()`, true);
    const items = await cdp.eval(`window.__jkRecovery.list()`, true);

    result.phase1 = {
      writerReady: !!writerReady,
      typed,
      textOk: !!textOk,
      savedSize,
      itemCount: Array.isArray(items) ? items.length : -1,
      firstItem: Array.isArray(items) ? items[0] : null,
    };
    const backupOk =
      typeof savedSize === 'number' &&
      savedSize > 0 &&
      Array.isArray(items) &&
      items.length >= 1 &&
      items.some((i) => i.sizeBytes > 0);
    console.log(
      `[阶段一] 文本命中=${!!textOk} 落盘字节=${savedSize} 备份数=${result.phase1.itemCount} ${backupOk ? '✅' : '❌'}`,
    );
    if (!textOk || !backupOk) failed = true;

    /* --------------------------- 模拟崩溃并重启 --------------------------- */
    killPid(child.pid);
    await sleep(1500);
    killAllElectron();
    await sleep(1000);

    child = launch(userDataDir);
    cdp = await connect();

    /* ----------------------- 阶段二：自动弹出 → 恢复 ----------------------- */
    const autoOpened = await cdp.waitFor(`(window.__jkRecovery?.count?.() ?? 0) > 0`, {
      timeoutMs: 30000,
    });
    const modalVisible = await cdp.waitFor(
      `!!document.querySelector('[role="dialog"][aria-label="文档备份中心"]')`,
    );
    result.phase2 = { autoListed: !!autoOpened, modalVisible: !!modalVisible };
    console.log(`[阶段二] 自动列出=${!!autoOpened} 备份中心弹出=${!!modalVisible}`);

    const clicked = await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '恢复');
      if (btn) btn.click();
      return !!btn;
    })()`);
    const restored = await cdp.waitFor(
      `(window.__jkWriterDebug?.text?.() ?? '').includes(${JSON.stringify(TOKEN)})`,
      { timeoutMs: 30000 },
    );
    result.phase2.clickedRestore = !!clicked;
    result.phase2.restored = !!restored;
    console.log(`[阶段二] 点击恢复=${!!clicked} 内容还原=${!!restored} ${restored ? '✅' : '❌'}`);
    if (!autoOpened || !modalVisible || !clicked || !restored) failed = true;

    /* --------------------------- 控制台错误 --------------------------- */
    const errors = [...cdp.exceptions, ...cdp.consoleErrors].filter((e) => !pickIgnorable(e));
    allErrors.push(...errors);
    result.consoleErrors = allErrors.slice(0, 10);
  } catch (e) {
    console.error('冒烟执行异常：', e.message);
    failed = true;
    allErrors.push(e.message);
    result.consoleErrors = allErrors.slice(0, 10);
  } finally {
    killAllElectron();
    // 等待进程真正退出并释放文件句柄，否则 Windows 上可能无法删除临时目录
    await sleep(2000);
    if (!KEEP) {
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        console.warn(`清理临时目录失败，请手动删除：${userDataDir}`);
      }
    } else {
      console.log(`已保留临时 user-data-dir：${userDataDir}`);
    }
  }

  if (allErrors.length > 0) failed = true;

  console.log('=== 崩溃恢复冒烟结果 ===');
  console.log(JSON.stringify(result, null, 2));
  console.log(failed ? '❌ 崩溃恢复冒烟未通过' : '✅ 崩溃恢复冒烟通过');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('冒烟脚本失败:', e.message);
  process.exit(2);
});
