/**
 * pdf-export-smoke —— 「导出 PDF」统一入口（Electron 打印管线）真实端到端冒烟。
 *
 * 与 scripts/gui-smoke.mjs 同源的 CDP 自动化方式（Node ≥22 内置 WebSocket），
 * 但**不修改** gui-smoke 的既有断言，只覆盖本次交付的打印管线功能：
 *
 *   1) 依次打开 文字 / 表格 / 演示 三个模块，调用各自的 pdfProbe 调试钩子，
 *      断言返回 { size, head } 且 head === '%PDF-'、size > 1500；
 *   2) 在同一页面上下文直接调用 pdf:export-html IPC 打印一份最小 HTML，
 *      从返回字节里解析 PDF 的 /MediaBox，反证纸张单位（微米 or 英寸）：
 *      A4 纵向期望约 '0 0 595.x 841.x'（pt）；横向期望宽高互换约 '842 595'；
 *      若得到 '612 792'（Letter，说明 pageSize 判定为非法回落默认）或明显异常，
 *      即为源码单位 Bug；
 *   3) 收集控制台错误 / 未捕获异常（口径同 gui-smoke）。
 *
 * 用法：
 *   1) 启动应用（必须带 --jk-debug，否则调试钩子不挂载）：
 *        cd apps/desktop && env -u ELECTRON_RUN_AS_NODE \
 *          ./node_modules/.bin/electron . --remote-debugging-port=9222 --jk-debug
 *   2) node scripts/pdf-export-smoke.mjs [--port 9222]
 *
 * 退出码：0 通过；1 断言失败；2 脚本/连接失败。
 */
import process from 'node:process';

const port = (() => {
  const i = process.argv.indexOf('--port');
  return i >= 0 ? Number(process.argv[i + 1]) : 9222;
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询查找 Electron 主窗口页面目标 */
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

  /** 轮询等待表达式返回真值（超时返回最后一次结果） */
  async waitFor(expression, { timeoutMs = 20000, intervalMs = 800 } = {}) {
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

/** 三个模块：空状态按钮文案 + 调试钩子全局名（探针 pdfProbe 由编辑器在 --jk-debug 下挂载）。
 *  `ready`：除钩子挂载外，再等「内容就绪」的条件表达式——Writer 的示例文档是异步
 *  fetch+parse 加载的，钩子会先于正文挂载，若过早探针会导出空白页（~950B）。 */
const MODULES = [
  {
    name: 'Writer',
    buttonText: '文字',
    hook: '__jkWriterDebug',
    ready: `(window.__jkWriterDebug?.text?.()?.length ?? 0) > 0`,
  },
  { name: 'Sheet', buttonText: '表格', hook: '__jkDebug', ready: 'true' },
  { name: 'Slide', buttonText: '演示', hook: '__jkSlideDebug', ready: 'true' },
];

/**
 * 最小校验 HTML：`@page` 尺寸与 buildPrintDocument 一致（横向时宽高互换），
 * 以便在实现选择 `preferCSSPageSize` 时也能得到正确朝向。
 */
function minHtml(landscape) {
  const size = landscape ? '297mm 210mm' : '210mm 297mm';
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    `<style>@page{size:${size};margin:15mm}</style></head>` +
    '<body><p>A4 尺寸校验</p></body></html>'
  );
}

/** 在页面上下文调用 pdf:export-html IPC 并解析 PDF 的 /MediaBox（分块拼接避免大数组爆栈） */
function mediaBoxExpression(landscape) {
  return `(async () => {
    const bytes = await window.jareking.invoke(window.jareking.IPC.PDF_EXPORT_HTML, {
      html: ${JSON.stringify(minHtml(landscape))},
      pageSize: 'A4', landscape: ${landscape ? 'true' : 'false'}, marginMm: 15,
    });
    const arr = Array.from(bytes);
    let latin = '';
    for (let i = 0; i < arr.length; i += 8192) {
      latin += String.fromCharCode.apply(null, arr.slice(i, i + 8192));
    }
    const mb = /MediaBox\\s*\\[([^\\]]*)\\]/.exec(latin);
    return {
      size: arr.length,
      head: String.fromCharCode(...arr.slice(0, 5)),
      mediaBox: mb ? mb[1].trim().replace(/\\s+/g, ' ') : null,
    };
  })()`;
}

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

  const results = { probes: {}, mediaBox: {}, consoleErrors: [] };
  let failed = false;

  // 应用就绪
  const appReady = await cdp.waitFor(
    `!!document.querySelector('#root') && document.querySelector('#root').children.length > 0`,
  );
  if (!appReady) {
    console.log('❌ 应用根节点未就绪');
    process.exit(2);
  }

  // 1. 三个模块探针
  for (const mod of MODULES) {
    await cdp.eval('location.reload()', true).catch(() => {});
    await sleep(2500);

    const clicked = await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(mod.buttonText)}));
      if (!btn) return 'no-button';
      btn.click();
      return 'clicked';
    })()`);

    const hookReady = await cdp.waitFor(
      `typeof window[${JSON.stringify(mod.hook)}]?.pdfProbe === 'function' && (${mod.ready})`,
    );

    let probe = null;
    let probeError = null;
    if (hookReady) {
      // 探针内部经 IPC 调 printToPDF；失败时记录错误而非中断（便于逐模块定位）
      try {
        probe = await cdp.eval(`window[${JSON.stringify(mod.hook)}].pdfProbe()`, true);
      } catch (e) {
        probeError = e.message;
      }
    }
    results.probes[mod.name] = {
      clicked,
      hookReady: !!hookReady,
      ...(probe ?? {}),
      ...(probeError ? { error: probeError } : {}),
    };
    if (probeError) console.log(`[${mod.name}] probe error: ${probeError}`);

    const headOk = probe && probe.head === '%PDF-';
    const sizeOk = probe && probe.size > 1500;
    console.log(
      `[${mod.name}] clicked=${clicked} hookReady=${!!hookReady} size=${probe?.size} head=${JSON.stringify(probe?.head)} ${headOk && sizeOk ? '✅' : '❌'}`,
    );
    if (!headOk || !sizeOk) failed = true;
  }

  // 2. 纸张尺寸反证：A4 纵向 + 横向 MediaBox
  async function runMediaBox(landscape) {
    try {
      return await cdp.eval(mediaBoxExpression(landscape), true);
    } catch (e) {
      return { error: e.message };
    }
  }
  results.mediaBox.portrait = await runMediaBox(false);
  results.mediaBox.landscape = await runMediaBox(true);
  console.log('A4 纵向 MediaBox:', JSON.stringify(results.mediaBox.portrait));
  console.log('A4 横向 MediaBox:', JSON.stringify(results.mediaBox.landscape));

  // 纸张尺寸判定：纵向期望约 '0 0 595.x 841.x'；横向期望宽高互换约 '842 595'
  const pt = (v) => (typeof v === 'string' ? v.split(/\s+/).map(Number) : null);
  const p = results.mediaBox.portrait?.mediaBox ? pt(results.mediaBox.portrait.mediaBox) : null;
  const l = results.mediaBox.landscape?.mediaBox ? pt(results.mediaBox.landscape.mediaBox) : null;
  const near = (a, b, tol = 2) => typeof a === 'number' && Math.abs(a - b) <= tol;
  const portraitOk = !!p && near(p[2], 595) && near(p[3], 841);
  const landscapeOk = !!l && near(l[2], 842) && near(l[3], 595);
  console.log(
    `纸张判定: 纵向A4=${portraitOk ? '✅' : '❌'} 横向A4=${landscapeOk ? '✅' : '❌'}`,
  );
  if (!portraitOk || !landscapeOk) failed = true;

  // 3. 控制台错误
  const errors = [...cdp.exceptions, ...cdp.consoleErrors].filter((e) => !pickIgnorable(e));
  results.consoleErrors = errors.slice(0, 10);
  if (errors.length > 0) failed = true;

  console.log('=== 导出 PDF 冒烟结果 ===');
  console.log(JSON.stringify(results, null, 2));
  console.log(failed ? '❌ 冒烟未通过' : '✅ 导出 PDF 冒烟通过');

  // 注意：Browser.close 后浏览器即关闭、CDP 连接断开，send 不会返回结果。
  // 用 Promise.race 兜底超时，避免 await 悬挂导致未走到 process.exit（进程会以 0 自然退出，掩盖失败）。
  try {
    await Promise.race([cdp.send('Browser.close'), sleep(1000)]);
  } catch {
    /* 忽略 */
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('冒烟脚本失败:', e.message);
  process.exit(2);
});
