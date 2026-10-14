/**
 * #46-C 大文件压测：100MB+ xlsx / pptx 真实打开，验证 Worker 化效果并留档数据。
 *
 * 指标：
 *  - 解析耗时（Worker 内）
 *  - 主线程最大冻结间隔（rAF 心跳：解析期间 maxGap 应 ≪ 总耗时，证明不冻结）
 *  - 渲染进程 JS 堆用量（performance.memory 轮询峰值）
 *  - 端到端打开（含 Univer/Konva 上屏）总耗时与正确性断言
 *
 * 前置：electron . --remote-debugging-port=9222 --jk-debug（新构建）
 * 用法：node scripts/bigfile-bench.mjs
 */
import process from 'node:process';
import path from 'node:path';
import http from 'node:http';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const XLSX = path.join(root, 'output', 'big-sample.xlsx');
const PPTX = path.join(root, 'output', 'big-sample.pptx');

const port = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(1);

async function findPage() {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = (await res.json()).filter((t) => t.type === 'page');
      const page = targets.find((t) => !t.url.startsWith('devtools'));
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error('未找到 Electron 页面目标');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
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
          this.consoleErrors.push(args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
        }
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push('[exception] ' + (msg.params.exceptionDetails?.exception?.description ?? '').slice(0, 300));
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
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result?.value;
  }
}

/* ---------------- 心跳与堆采样 ---------------- */

const HEARTBEAT_JS = `(() => {
  window.__jkHB = { maxGap: 0, totalGaps: 0, running: true };
  let last = performance.now();
  const tick = (t) => {
    if (!window.__jkHB?.running) return;
    const gap = t - last;
    if (gap > window.__jkHB.maxGap) window.__jkHB.maxGap = gap;
    window.__jkHB.totalGaps++;
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return 'hb-on';
})()`;

const HB_STOP_JS = `(() => { if (window.__jkHB) window.__jkHB.running = false; return { maxGapMs: Math.round(window.__jkHB?.maxGap ?? -1), frames: window.__jkHB?.totalGaps ?? 0 }; })()`;

async function heapNow(cdp) {
  return await cdp.eval(`performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1`);
}

async function heapPeakSampler(cdp, stopFlag) {
  let peak = 0;
  while (!stopFlag.stopped) {
    const v = await heapNow(cdp).catch(() => -1);
    if (v > peak) peak = v;
    await sleep(400);
  }
  return peak;
}

/* ---------------- 文件服务（供页面 fetch 大字节） ---------------- */

function serveFiles() {
  const server = http.createServer((req, res) => {
    const file = req.url?.includes('pptx') ? PPTX : XLSX;
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Content-Length': statSync(file).size,
    });
    require_stream(file, res);
  });
  function require_stream(file, res) {
    import('node:fs').then(({ createReadStream }) => createReadStream(file).pipe(res));
  }
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* ---------------- CDP 文件注入 ---------------- */

async function setInputFile(cdp, selector, absPath) {
  const mark = await cdp.eval(
    `(() => { const i = document.querySelector('${selector}'); if (!i) return 'no-input'; i.id = 'jkBenchInput'; return 'ok'; })()`,
  );
  if (mark !== 'ok') return mark;
  const { root: docRoot } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: docRoot.nodeId, selector: '#jkBenchInput' });
  if (!nodeId) return 'no-node';
  await cdp.send('DOM.setFileInputFiles', { files: [absPath], nodeId });
  return 'set';
}

async function openTab(cdp, keyword, waitMs) {
  await cdp.eval(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('${keyword}')); if (b) b.click(); })()`);
  await sleep(waitMs);
}

async function main() {
  if (!statSync(XLSX).isFile() || !statSync(PPTX).isFile()) throw new Error('样本缺失，先跑 gen-bigfile.mjs');
  console.log(`样本: xlsx ${mb(XLSX)}MB / pptx ${mb(PPTX)}MB`);

  const server = await serveFiles();
  const fileBase = `http://127.0.0.1:${server.address().port}`;

  const page = await findPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');

  const R = { consoleErrors: [] };
  let failed = false;

  const reload = async () => {
    await cdp.eval(`location.reload()`, true).catch(() => {});
    await sleep(2500);
    await cdp.eval(HEARTBEAT_JS);
  };

  // 就绪
  for (let t = 0; t < 20; t++) {
    if (await cdp.eval(`!!document.querySelector('#root')?.children.length`)) break;
    await sleep(500);
  }
  await reload();

  /* ============ 1. xlsx 解析级（Worker，不经上屏） ============ */
  await openTab(cdp, '表格', 4000);
  R.xlsxParse = await cdp.eval(
    `(async () => {
      if (!window.__jkDebug?.parseInWorker) return { err: 'no-hook' };
      const t0 = performance.now();
      const resp = await fetch('${fileBase}/big-sample.xlsx');
      const bytes = new Uint8Array(await resp.arrayBuffer());
      const fetchMs = Math.round(performance.now() - t0);
      window.__jkHB.maxGap = 0; // 只统计解析期间的冻结
      const p0 = performance.now();
      const model = await window.__jkDebug.parseInWorker('xlsx', bytes);
      const ms = Math.round(performance.now() - p0);
      return { ok: true, fetchMs, parseMs: ms, sheets: model.sheets.length, rows: model.sheets[0].rowCount, cells: Object.keys(model.sheets[0].cells).length };
    })()`,
    true,
  );
  R.xlsxParse.heartbeat = await cdp.eval(HB_STOP_JS);
  R.xlsxParse.heapAfterMB = await heapNow(cdp);
  console.log('xlsx 解析级:', JSON.stringify(R.xlsxParse));
  if (R.xlsxParse.err || !R.xlsxParse.ok) failed = true;

  /* ============ 2. xlsx 端到端（含 Univer 上屏，可能慢） ============ */
  await reload();
  await openTab(cdp, '表格', 4000);
  const t0e = Date.now();
  R.xlsxE2E = { set: await setInputFile(cdp, 'input[accept=".xlsx,.xlsm,.csv"]', XLSX) };
  let xToast = false;
  for (let t = 0; t < 240; t++) { // 最多 4 分钟上屏
    xToast = await cdp.eval(`document.body.textContent.includes('已打开 big-sample.xlsx')`);
    if (xToast) break;
    if (await cdp.eval(`document.body.textContent.includes('打开失败')`)) break;
    await sleep(1000);
  }
  R.xlsxE2E.totalMs = Date.now() - t0e;
  R.xlsxE2E.toastOk = xToast;
  R.xlsxE2E.heartbeat = await cdp.eval(HB_STOP_JS);
  R.xlsxE2E.heapAfterMB = await heapNow(cdp);
  console.log('xlsx 端到端:', JSON.stringify(R.xlsxE2E));
  if (!R.xlsxE2E.toastOk) failed = true;

  /* ============ 3. pptx 解析级 ============ */
  await reload();
  await openTab(cdp, '演示', 2500);
  R.pptxParse = await cdp.eval(
    `(async () => {
      if (!window.__jkSlideDebug?.parseInWorker) return { err: 'no-hook' };
      const resp = await fetch('${fileBase}/big-sample.pptx');
      const bytes = new Uint8Array(await resp.arrayBuffer());
      window.__jkHB.maxGap = 0;
      const p0 = performance.now();
      const model = await window.__jkSlideDebug.parseInWorker('pptx', bytes);
      const ms = Math.round(performance.now() - p0);
      return { ok: true, parseMs: ms, slides: model.slides.length, mediaEntries: Object.keys(model.media ?? {}).length, mediaMB: Math.round(JSON.stringify(Object.keys(model.media ?? {})).length, 0) };
    })()`,
    true,
  );
  R.pptxParse.heartbeat = await cdp.eval(HB_STOP_JS);
  R.pptxParse.heapAfterMB = await heapNow(cdp);
  console.log('pptx 解析级:', JSON.stringify(R.pptxParse));
  if (R.pptxParse.err || !R.pptxParse.ok) failed = true;

  /* ============ 4. pptx 端到端 ============ */
  await reload();
  await openTab(cdp, '演示', 2500);
  const t0p = Date.now();
  R.pptxE2E = { set: await setInputFile(cdp, 'input[accept=".pptx"]', PPTX) };
  let pToast = false;
  for (let t = 0; t < 180; t++) { // 最多 3 分钟
    pToast = await cdp.eval(`document.body.textContent.includes('已打开 big-sample.pptx')`);
    if (pToast) break;
    if (await cdp.eval(`document.body.textContent.includes('打开失败')`)) break;
    await sleep(1000);
  }
  R.pptxE2E.totalMs = Date.now() - t0p;
  R.pptxE2E.toastOk = pToast;
  R.pptxE2E.slideCount = await cdp.eval(`window.__jkSlideDebug?.slideCount?.() ?? -1`);
  R.pptxE2E.heartbeat = await cdp.eval(HB_STOP_JS);
  R.pptxE2E.heapAfterMB = await heapNow(cdp);
  console.log('pptx 端到端:', JSON.stringify(R.pptxE2E));
  if (!R.pptxE2E.toastOk || R.pptxE2E.slideCount !== 40) failed = true;

  /* ============ 汇总 ============ */
  R.consoleErrors = cdp.consoleErrors.filter((e) => !/favicon|GPU|gpu|Autofill|nsresult/.test(e)).slice(0, 8);
  if (R.consoleErrors.length) failed = true;

  console.log('\\n=== #46-C 大文件压测报告 ===');
  console.log(JSON.stringify(R, null, 2));
  console.log(failed ? '❌ 压测未通过' : '✅ 压测通过');

  try { await cdp.send('Browser.close'); } catch {}
  await sleep(800);
  server.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('压测脚本失败:', e.message); process.exit(2); });
