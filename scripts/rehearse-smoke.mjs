/**
 * 演示「排练计时」冒烟验证（WPS 对齐 P0）—— 通过 Chrome DevTools Protocol 自动化。
 *
 * 用法：
 *   1) 启动应用（端口用 9223，避开并行 run 常占的 9222）：
 *        cd apps/desktop && env -u ELECTRON_RUN_AS_NODE \
 *          ./node_modules/.bin/electron . --remote-debugging-port=9223 --jk-debug
 *      （--jk-debug 必带：__jkSlideDebug 仅在带该标志时挂载）
 *   2) node scripts/rehearse-smoke.mjs [--port 9223]
 *
 * 步骤：打开演示模块 → 点「排练计时」→ 断言排练浮层文案 → 翻到第 2 页 → 等约 1.2s →
 * Esc 结算 → 断言确认对话框出现 → 点「保留」→ 断言第 1 页获得 advTm 且使用过的页 ≥500ms →
 * 断言「清除计时」按钮出现且点击后全部清空 → 收集渲染错误 → Browser.close。
 *
 * 注意：脚本结束会 Browser.close 关闭 Electron，随后如需其它冒烟须重新启动应用。
 * Node ≥22（内置 WebSocket）。
 */
import process from 'node:process';

const port = (() => {
  const i = process.argv.indexOf('--port');
  return i >= 0 ? Number(process.argv[i + 1]) : 9223;
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let attempt = 0; attempt < 30; attempt++) {
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
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result?.value;
  }
}

function pickIgnorable(text) {
  const t = String(text);
  return t.includes('favicon') || t.includes('Autofill') || t.includes('nsresult') || t.toLowerCase().includes('gpu');
}

/** 点击文本匹配的按钮（返回是否命中）；q 承载待匹配文案，避免拼接出括号不配平的表达式 */
const clickButton = (text, exact = false) => `(() => {
  const q = ${JSON.stringify(text)};
  const btn = [...document.querySelectorAll('button')].find((b) =>
    ${exact ? 'b.textContent.trim() === q' : 'b.textContent.includes(q)'});
  if (!btn) return false;
  btn.click();
  return true;
})()`;

async function main() {
  const page = await findPage();
  console.log(`目标: ${page.title || '(无标题)'} ${page.url}`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');

  const results = {};
  let failed = false;

  // 0. 应用就绪
  for (let t = 0; t < 20; t++) {
    const ok = await cdp.eval(
      `!!document.querySelector('#root') && document.querySelector('#root').children.length > 0`,
    );
    if (ok) {
      results.appRoot = true;
      break;
    }
    await sleep(500);
  }
  if (!results.appRoot) failed = true;

  // 1. 打开演示模块
  results.slideOpen = await cdp.eval(clickButton('演示'));
  await sleep(3000); // Konva 初始化
  results.konvaCanvas = await cdp.eval(`document.querySelectorAll('canvas').length`);

  // 2. 顶栏存在「排练计时」入口
  results.rehearseBtnExists = await cdp.eval(clickButton('排练计时'));
  await sleep(900);
  // 排练浮层：页脚文案含「本页」「累计」「Esc 结束排练」
  results.footerText = await cdp.eval(
    `(() => {
      const el = [...document.querySelectorAll('div')].find((d) => /本页 .*累计 .*Esc 结束排练/.test(d.textContent ?? ''));
      return el ? el.textContent : null;
    })()`,
  );
  if (!results.footerText) failed = true;

  // 3. 翻到第 2 页（访问 2 页），停留 1.2s
  await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
  await sleep(1200);
  results.rehearsePage2 = await cdp.eval(
    `[...document.querySelectorAll('div')].some((d) => {
      const t = d.textContent ?? '';
      return t.startsWith('2 / ') && t.includes('本页') && t.includes('Esc 结束排练');
    })`,
  );

  // 4. Esc → 结算并弹出确认对话框（项目 Modal，非原生弹窗）
  await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(700);
  results.confirmDialog = await cdp.eval(
    `(() => { const d = document.querySelector('[role="dialog"]'); return !!d && d.textContent.includes('是否保留本次排练时间？'); })()`,
  );
  results.confirmSummary = await cdp.eval(
    `(() => { const d = document.querySelector('[role="dialog"]'); return d ? d.textContent.includes('总用时') && d.textContent.includes('平均每页') : false; })()`,
  );
  if (!results.confirmDialog) failed = true;

  // 5. 点「保留」→ 写回自动换片时间：第 1、2 页均被访问，时长均 ≥500ms
  await cdp.eval(`(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return false;
    const btn = [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === '保留');
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(600);
  results.advanceTimings = await cdp.eval(`JSON.stringify(window.__jkSlideDebug?.advanceTimings?.() ?? null)`);
  results.timingsApplied = (() => {
    try {
      const arr = JSON.parse(results.advanceTimings ?? 'null');
      return Array.isArray(arr) && arr.length > 0 && arr.every((v) => typeof v === 'number' && v >= 500);
    } catch {
      return false;
    }
  })();
  if (!results.timingsApplied) failed = true;

  // 6.「清除计时」按钮出现 → 点击 → 全部清空
  results.clearBtnExists = await cdp.eval(
    `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '清除计时')`,
  );
  if (results.clearBtnExists) {
    await cdp.eval(clickButton('清除计时', true));
    await sleep(500);
  }
  results.afterClear = await cdp.eval(`JSON.stringify(window.__jkSlideDebug?.advanceTimings?.() ?? null)`);
  results.cleared = (() => {
    try {
      const arr = JSON.parse(results.afterClear ?? 'null');
      return Array.isArray(arr) && arr.every((v) => v === null);
    } catch {
      return false;
    }
  })();
  if (!results.clearBtnExists || !results.cleared) failed = true;

  // 7. 收集渲染错误
  const errors = [...cdp.exceptions, ...cdp.consoleErrors].filter((e) => !pickIgnorable(e));
  results.consoleErrors = errors.slice(0, 10);
  if (errors.length > 0) failed = true;

  console.log('=== 排练计时冒烟结果 ===');
  console.log(JSON.stringify(results, null, 2));
  console.log(failed ? '❌ 冒烟未通过' : '✅ 排练计时冒烟通过');

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
