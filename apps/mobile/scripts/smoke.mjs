#!/usr/bin/env node
/**
 * 移动端 Web 层冒烟（无头 Chromium + CDP，零第三方依赖）。
 *
 * 为什么需要它：Android WebView 与 Chromium 同内核，「能否在 WebView 里跑起来」
 * 可以在桌面无头浏览器里先验一遍，比每次装 APK 到真机反馈快一个数量级。
 *
 * 覆盖的断言（对应交接文档 §8.4 的硬要求）：
 *   1) 渲染层挂载成功（App 在复用代码下可运行）
 *   2) `window.jareking` 桥安装完成，且 IPC 通道表与桌面端完全一致（29 条）
 *   3) 最近文件通道返回合法结构
 *   4) 「选择文件 → 伪路径 → 读字节」全链路（Android 上由 SAF 提供 File 对象）
 *   5) 运行期无 console error / 未捕获异常
 *
 * 用法：node scripts/smoke.mjs [--url http://127.0.0.1:4173] [--shot out.png]
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(__dirname, '..');

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const URL_ = argOf('--url', 'http://127.0.0.1:4173');
const SHOT = argOf('--shot', join(appDir, '.smoke.png'));
const PORT = Number(argOf('--port', '9223'));

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const browser = CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.error('[smoke] ✗ 未找到 Chrome / Edge');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/* ---------------------------- CDP 极简客户端 ---------------------------- */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 30000);
    });
  }

  /** 在页面上下文求值（可 await Promise） */
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? '页面求值异常');
    }
    return res.result?.value;
  }
}

/* ------------------------------- 主流程 ------------------------------- */

const proc = spawn(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${PORT}`,
    '--window-size=390,844',
    '--user-data-dir=' + join(appDir, '.smoke-profile'),
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let ws = null;
let exitCode = 0;

try {
  // 等调试端口就绪
  let pageTarget = null;
  for (let i = 0; i < 60 && !pageTarget; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      // Edge 会额外带若干 background_page（内置扩展），必须按 type 过滤出真实标签页
      pageTarget = list.find((t) => t.type === 'page');
    } catch {
      /* 未就绪 */
    }
    if (!pageTarget) await sleep(250);
  }
  if (!pageTarget) throw new Error('浏览器调试端口未就绪');

  ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
  });

  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Storage.enable').catch(() => undefined);
  // 每次冒烟从干净状态开始（否则上一轮的备份/最近文件会污染断言与截图）
  await cdp
    .send('Storage.clearDataForOrigin', { origin: new global.URL(URL_).origin, storageTypes: 'all' })
    .catch(() => undefined);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });

  await cdp.send('Page.navigate', { url: URL_ });

  // 等 #root 出现子节点（首屏 React 挂载完成）
  let mounted = false;
  for (let i = 0; i < 80; i++) {
    try {
      mounted = await cdp.eval('!!document.querySelector("#root")?.children.length');
      if (mounted) break;
    } catch {
      /* 导航中 */
    }
    await sleep(250);
  }
  check('渲染层挂载（App 在复用代码下可运行）', mounted);

  // 1. 桥 + 通道表
  const bridge = await cdp.eval(`(() => {
    const j = window.jareking;
    return j ? { invoke: typeof j.invoke, channels: Object.keys(j.IPC ?? {}).length } : null;
  })()`);
  check('window.jareking 桥已安装', bridge?.invoke === 'function', JSON.stringify(bridge));

  // 通道覆盖率：桌面 channels.ts 的每一条都必须有移动端实现（防止接线遗漏）
  const diag = await cdp.eval(`window.__jkMobileDiagnostics?.() ?? null`);
  check(
    'IPC 通道全覆盖（桌面通道表逐条实现）',
    Boolean(diag) && diag.missing.length === 0,
    diag ? `${diag.implemented}/${diag.total} 已实现${diag.missing.length ? '，缺：' + diag.missing.join(',') : ''}` : '无自检接口',
  );

  // 2. 最近文件通道
  const recent = await cdp.eval(`(async () => {
    const rows = await window.jareking.invoke('doc:recent:list');
    return Array.isArray(rows) ? rows.length : -1;
  })()`);
  check('doc:recent:list 返回数组', recent >= 0, `条数 ${recent}`);

  // 3. 文件打开链路：File → 伪路径 → 读回字节（Android 由 SAF 提供 File）
  const samplePath = join(appDir, '../desktop/src/renderer/public/sample.docx');
  if (existsSync(samplePath)) {
    const b64 = (await readFile(samplePath)).toString('base64');
    const opened = await cdp.eval(`(async () => {
      const bin = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
      const file = new File([bin], 'sample.docx');
      const path = window.jareking.getPathForFile(file);
      const bytes = await window.jareking.invoke('doc:read-file', { path });
      const again = await window.jareking.invoke('doc:read-file', { path });
      return {
        path,
        size: bytes?.length ?? -1,
        expect: bin.length,
        cachedSize: again?.length ?? -1,
      };
    })()`);
    check(
      '选择文件 → 读回字节（含二次读缓存）',
      opened?.size === opened?.expect && opened?.cachedSize === opened?.expect,
      `${opened?.size}/${opened?.expect} bytes, path=${opened?.path}`,
    );
  } else {
    check('选择文件 → 读回字节', false, `缺少样本 ${samplePath}`);
  }

  // 4. 编辑器内核可用性：点「表格」→ Univer；刷新后点「文档」→ TipTap。
  //    两者都会离开空状态页，故每个用例前重新加载页面（空状态才重新出现）。
  const sheetMounted = await cdp.eval(`(async () => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('表格'));
    if (!btn) return { ok: false, why: '未找到「工作簿/表格」入口按钮' };
    btn.click();
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 200));
      // Univer 1.0.4 以 canvas 渲染表格主体
      if (document.querySelector('canvas') || document.querySelector('[class*="univer"]')) return { ok: true };
    }
    return { ok: false, why: 'Univer 表格未出现（24s 超时）' };
  })()`);
  check('Sheet 编辑器挂载（Univer 内核）', sheetMounted?.ok === true, sheetMounted?.why ?? '');

  await cdp.send('Page.reload', { ignoreCache: false });
  for (let i = 0; i < 80; i++) {
    try {
      if (await cdp.eval('!!document.querySelector("#root")?.children.length')) break;
    } catch {
      /* 刷新中 */
    }
    await sleep(250);
  }

  const writerMounted = await cdp.eval(`(async () => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('文字'));
    if (!btn) return { ok: false, why: '未找到「文档/文字」入口按钮' };
    btn.click();
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (document.querySelector('.ProseMirror')) return { ok: true };
    }
    return { ok: false, why: 'TipTap 编辑器未出现' };
  })()`);
  check('Writer 编辑器挂载（TipTap 内核）', writerMounted?.ok === true, writerMounted?.why ?? '');

  // 5. 备份（自动保存）通道闭环
  const backup = await cdp.eval(`(async () => {
    const api = window.jareking;
    await api.invoke(api.IPC.DOC_BACKUP_SAVE, {
      documentId: 'smoke-doc', module: 'writer', title: '冒烟.docx',
      bytes: new Uint8Array([80, 75, 3, 4]),
    });
    const list = await api.invoke(api.IPC.DOC_BACKUP_LIST);
    const restored = await api.invoke(api.IPC.DOC_BACKUP_RECOVER, { documentId: 'smoke-doc' });
    await api.invoke(api.IPC.DOC_BACKUP_DISCARD, { documentId: 'smoke-doc' });
    return { count: list?.length ?? -1, restored: restored?.path ?? null };
  })()`);
  check(
    '崩溃恢复：存 → 列 → 恢复 → 丢弃',
    backup?.count >= 1 && typeof backup?.restored === 'string',
    `备份 ${backup?.count} 条`,
  );

  // 5. 能力差异必须显式报错（不许假装实现）
  const unsupported = await cdp.eval(`(async () => {
    const api = window.jareking;
    const out = {};
    for (const [key, label] of [['PDF_OFFICE_TO_PDF','Office转PDF'], ['PDF_EXPORT_HTML','导出PDF']]) {
      try { await api.invoke(api.IPC[key], {}); out[label] = 'silent'; }
      catch (e) { out[label] = String(e.message).includes('移动端不支持') ? 'explicit' : 'other'; }
    }
    return out;
  })()`);
  check(
    '桌面专有能力在移动端显式拒绝（不静默）',
    unsupported?.['Office转PDF'] === 'explicit' && unsupported?.['导出PDF'] === 'explicit',
    JSON.stringify(unsupported),
  );

  // 6. 运行期错误
  const errors = cdp.events.filter(
    (e) =>
      (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
      e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'),
  );
  // 忽略被显式拒绝能力的预期错误（smoke 自己触发的除外——上面已用 try 包裹）
  const realErrors = errors.filter((e) => {
    const text = JSON.stringify(e.params);
    return !text.includes('favicon');
  });
  check('运行期无 console error / 未捕获异常', realErrors.length === 0, `${realErrors.length} 条`);
  if (realErrors.length) {
    for (const e of realErrors.slice(0, 5)) console.log('   ', JSON.stringify(e.params).slice(0, 300));
  }

  // 截图留档
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(SHOT, Buffer.from(shot.data, 'base64'));
  console.log(`\n[smoke] 截图：${SHOT}`);
} catch (err) {
  console.error(`\n[smoke] ✗ ${err.message}`);
  exitCode = 1;
} finally {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  proc.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n[smoke] ${results.length - failed.length}/${results.length} 通过${failed.length ? '（有失败）' : ' — 全绿'}`,
);
if (failed.length) exitCode = 1;
process.exit(exitCode);
