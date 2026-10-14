/**
 * #46-C Worker 解析端到端冒烟——验证「主线程 → Web Worker → 模型上屏」全链路。
 *
 * 前置：应用已构建并以下述命令启动（与 gui-smoke 相同）：
 *   cd apps/desktop && env -u ELECTRON_RUN_AS_NODE \
 *     ./node_modules/.bin/electron . --remote-debugging-port=9222 --jk-debug
 * 用法：node scripts/worker-smoke.mjs [--port 9222]
 *
 * 步骤：
 *  1) 用已构建的 @jareking/sheet / @jareking/presentation dist 生成真实 xlsx(含值) 与 pptx(3 页)
 *  2) CDP 打开「表格」标签 → 给 input[accept=".xlsx"] 设置文件 → 断言 Univer 快照含测试值
 *  3) reload → 打开「演示」标签 → 给 input[accept=".pptx"] 设置文件 → 断言页数 = 3（默认为 2，可区分）
 *  4) 收集渲染层 console/异常，0 错误才算通过（worker 内崩溃会以异常或 toast 失败暴露）
 */
import process from 'node:process';
import path from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { exportXlsx } from '../packages/sheet/dist/index.js';
import { exportPptx } from '../packages/presentation/dist/index.js';

const port = (() => {
  const i = process.argv.indexOf('--port');
  return i >= 0 ? Number(process.argv[i + 1]) : 9222;
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
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
        this.exceptions.push(msg.params.exceptionDetails?.exception?.description ?? 'unknown');
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
}

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

/** 经 DOM.setFileInputFiles 给选择器命中的 input 塞文件并触发 change */
async function setInputFile(cdp, selector, absPath) {
  const mark = await cdp.eval(
    `(() => { const i = document.querySelector('${selector}'); if (!i) return 'no-input'; i.id = 'jkSmokeFileInput'; return 'ok'; })()`,
  );
  if (mark !== 'ok') return mark;
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: '#jkSmokeFileInput',
  });
  if (!nodeId) return 'no-node';
  await cdp.send('DOM.setFileInputFiles', { files: [absPath], nodeId });
  // 兜底：即使 CDP 未派发 change，手动补发（重复触发解析同一文件无副作用）
  await cdp.eval(
    `document.getElementById('jkSmokeFileInput')?.dispatchEvent(new Event('change', { bubbles: true }))`,
  );
  return 'set';
}

async function main() {
  // ---- 1. 生成测试文件（走真实导出器，保证是合法 OOXML 包） ----
  const outDir = path.resolve('output');
  mkdirSync(outDir, { recursive: true });
  const xlsxPath = path.join(outDir, 'worker-smoke.xlsx');
  const pptxPath = path.join(outDir, 'worker-smoke.pptx');

  const xlsxBytes = await exportXlsx({
    sheets: [
      {
        name: '冒烟',
        rowCount: 5,
        colCount: 3,
        cells: {
          '0,0': { value: 'WorkerOK' },
          '1,1': { value: 42 },
        },
        merges: [],
      },
    ],
    activeSheetIndex: 0,
  });
  writeFileSync(xlsxPath, xlsxBytes);

  const textPage = (t) => ({
    shapes: [
      {
        type: 'text',
        x: 1000000,
        y: 1000000,
        w: 5000000,
        h: 1000000,
        paragraphs: [{ runs: [{ text: t, fontSize: 32 }] }],
        geom: 'rect',
      },
    ],
  });
  const pptxBytes = await exportPptx({
    slides: [textPage('P1'), textPage('P2'), textPage('P3')],
    slideWidth: 9144000,
    slideHeight: 6858000,
  });
  writeFileSync(pptxPath, pptxBytes);
  console.log(`测试文件已生成: ${xlsxPath} / ${pptxPath}`);

  // ---- 2. 连接 CDP ----
  const page = await findPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');

  const results = {};
  let failed = false;

  // 应用就绪
  let ready = false;
  for (let t = 0; t < 20; t++) {
    ready = await cdp.eval(
      `!!document.querySelector('#root') && document.querySelector('#root').children.length > 0`,
    );
    if (ready) break;
    await sleep(500);
  }
  if (!ready) throw new Error('应用未挂载');
  await cdp.eval(`location.reload()`, true).catch(() => {});
  await sleep(2500);

  // ---- 3. Sheet：xlsx → Worker 解析 → Univer 上屏 ----
  await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('表格'));
    if (btn) btn.click();
  })()`);
  await sleep(4000); // Univer 初始化
  results.xlsxSet = await setInputFile(cdp, 'input[accept=".xlsx,.xlsm,.csv"]', xlsxPath);
  // 等 worker 解析 + toast（解析走 Worker，主线程保持响应；给足裕量）
  let toastOk = false;
  let snapHasValue = false;
  for (let t = 0; t < 20; t++) {
    toastOk = await cdp.eval(`document.body.textContent.includes('已打开 worker-smoke.xlsx')`);
    snapHasValue = await cdp.eval(
      `(async () => {
        if (!window.__jkDebug?.snapshot) return false;
        const snap = await window.__jkDebug.snapshot();
        return JSON.stringify(snap).includes('WorkerOK') && JSON.stringify(snap).includes(':42');
      })()`,
      true,
    );
    if (toastOk && snapHasValue) break;
    await sleep(500);
  }
  results.sheetToast = toastOk;
  results.sheetValue = snapHasValue;
  if (results.xlsxSet !== 'set' || !toastOk || !snapHasValue) failed = true;

  // ---- 4. PPT：pptx → Worker 解析 → 页数上屏 ----
  await cdp.eval(`location.reload()`, true).catch(() => {});
  await sleep(2500);
  await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('演示'));
    if (btn) btn.click();
  })()`);
  await sleep(2500); // Konva 初始化
  results.pptxSet = await setInputFile(cdp, 'input[accept=".pptx"]', pptxPath);
  let pptToast = false;
  let slideCount = -1;
  for (let t = 0; t < 20; t++) {
    pptToast = await cdp.eval(`document.body.textContent.includes('已打开 worker-smoke.pptx')`);
    slideCount = await cdp.eval(`window.__jkSlideDebug?.slideCount?.() ?? -1`);
    if (pptToast && slideCount === 3) break;
    await sleep(500);
  }
  results.pptToast = pptToast;
  results.pptSlideCount = slideCount;
  if (results.pptxSet !== 'set' || !pptToast || slideCount !== 3) failed = true;

  // ---- 5. 控制台/异常 ----
  const errors = [...cdp.exceptions, ...cdp.consoleErrors].filter((e) => !pickIgnorable(e));
  results.consoleErrors = errors.slice(0, 10);
  if (errors.length > 0) failed = true;

  console.log('=== Worker 冒烟结果 ===');
  console.log(JSON.stringify(results, null, 2));
  console.log(failed ? '❌ Worker 冒烟未通过' : '✅ Worker 冒烟通过');

  try {
    await cdp.send('Browser.close');
  } catch {
    /* 忽略 */
  }
  await sleep(800);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('冒烟脚本失败:', e.message);
  process.exit(2);
});
