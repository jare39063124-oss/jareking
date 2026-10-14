/**
 * chunk-smoke.mjs —— #46-A 分块编辑端到端验证（真实 Electron + CDP）。
 *
 * 用法：先启动带 --jk-debug 的应用，再 node scripts/chunk-smoke.mjs [--port 9222]
 * 步骤：打开 Writer → 载入合成大文档(2000 段) → 断言进入分块模式且分页条出现 →
 *       断言切片内容正确(第1段/第1800段) → 翻到末段再回首页 → 收集 console 错误。
 */
import process from 'node:process';

const port = (() => {
  const i = process.argv.indexOf('--port');
  return i >= 0 ? Number(process.argv[i + 1]) : 9222;
})();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let a = 0; a < 20; a++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = (await res.json()).filter((t) => t.type === 'page');
      const page = targets.find((t) => !t.url.startsWith('devtools'));
      if (page) return page;
    } catch {
      /* retry */
    }
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
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
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
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result?.value;
  }
}

function pickIgnorable(t) {
  return String(t).includes('favicon') || String(t).includes('Autofill') ||
    String(t).includes('GPU') || String(t).includes('gpu') || String(t).includes('nsresult');
}

async function main() {
  const page = await findPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');

  const results = {};
  let failed = false;
  const fail = (k, v) => { results[k] = v; if (!v) failed = true; };

  // 应用就绪
  for (let t = 0; t < 20; t++) {
    if (await cdp.eval(`!!document.querySelector('#root') && document.querySelector('#root').children.length > 0`)) break;
    await sleep(500);
  }
  await cdp.eval(`location.reload()`, true).catch(() => {});
  await sleep(2500);

  // 打开 Writer 标签
  fail('writerOpen', await cdp.eval(`(() => {
    if (document.querySelector('.ProseMirror')) return 'already';
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('文字'));
    if (!btn) return 'no-button';
    btn.click();
    return 'clicked';
  })()`));
  await sleep(1500);
  fail('proseMirror', await cdp.eval(`!!document.querySelector('.ProseMirror')`));

  // 载入合成大文档触发分块
  await cdp.eval(`window.__jkWriterDebug.loadLargeTest(2000)`);
  await sleep(1200);

  const info = await cdp.eval(`window.__jkWriterDebug.chunkInfo()`);
  results.chunkInfo = info;
  fail('chunkMode', !!info?.chunkMode);
  fail('chunkTotal', info && info.total === 7); // ceil(2000/300) = 7

  // 分页条 DOM 出现且文案正确
  results.pagerText1 = await cdp.eval(
    `(() => { const el = [...document.querySelectorAll('span')].find((s) => /第 1 \\/ 7 段/.test(s.textContent)); return el?.textContent ?? null; })()`,
  );
  fail('pagerShown', !!results.pagerText1);

  // 当前切片(第1段)内容正确
  results.chunk0Text = await cdp.eval(
    `(() => { const t = document.querySelector('.ProseMirror')?.textContent ?? ''; return t.includes('测试段落 0') && !t.includes('测试段落 1800'); })()`,
  );
  fail('chunk0Sliced', !!results.chunk0Text);

  // 翻到末段
  await cdp.eval(`window.__jkWriterDebug.goToChunk(6)`);
  await sleep(800);
  const info2 = await cdp.eval(`window.__jkWriterDebug.chunkInfo()`);
  results.chunkInfo2 = info2;
  fail('navToLast', info2 && info2.chunkIndex === 6);
  results.pagerText7 = await cdp.eval(
    `(() => { const el = [...document.querySelectorAll('span')].find((s) => /第 7 \\/ 7 段/.test(s.textContent)); return el?.textContent ?? null; })()`,
  );
  fail('pagerLastShown', !!results.pagerText7);
  results.chunk6Text = await cdp.eval(
    `(() => { const t = document.querySelector('.ProseMirror')?.textContent ?? ''; return t.includes('测试段落 1800') && !t.includes('测试段落 0'); })()`,
  );
  fail('chunk6Sliced', !!results.chunk6Text);

  // 回到首页
  await cdp.eval(`window.__jkWriterDebug.goToChunk(0)`);
  await sleep(600);
  const info3 = await cdp.eval(`window.__jkWriterDebug.chunkInfo()`);
  fail('backToFirst', info3 && info3.chunkIndex === 0);

  // 控制台错误（排除可忽略项）
  results.consoleErrors = cdp.consoleErrors.filter((t) => !pickIgnorable(t));
  results.exceptions = cdp.exceptions.filter((t) => !pickIgnorable(t));
  fail('noConsoleErrors', results.consoleErrors.length === 0 && results.exceptions.length === 0);

  console.log('CHUNK_SMOKE_RESULT', JSON.stringify(results, null, 2));
  console.log(failed ? 'CHUNK_SMOKE_FAIL' : 'CHUNK_SMOKE_PASS');
  ws.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('CHUNK_SMOKE_ERROR', e.message);
  process.exit(2);
});
