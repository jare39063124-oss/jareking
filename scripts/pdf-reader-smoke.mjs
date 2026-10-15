/**
 * pdf-reader-smoke.mjs —— PDF 阅读器 + 中文水印 定向 GUI 验证（QA 严过关，独立脚本）。
 *
 * 背景：本轮新增「PDF 阅读器」与「中文水印 UI」，gui-smoke.mjs 仅覆盖到 PDF 工具箱入口，
 * 未覆盖阅读器渲染/翻页/缩放与中文水印实际产出。本脚本作为**独立定向验证**补齐，
 * **不改动 gui-smoke.mjs 的既有断言**（隔离约束）。
 *
 * 前置：应用已启动并开启调试端口
 *   cd apps/desktop && env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . \
 *     --remote-debugging-port=9222 --jk-debug
 * 用法：node scripts/pdf-reader-smoke.mjs [--port 9222]
 *
 * 覆盖：
 *  ① PDF 阅读器：经 Ribbon「PDF 工具 → 打开PDF」选择自造 PDF（CDP 拦截文件选择器注入真实磁盘路径）
 *     → 断言：渲染出 <canvas>、页码显示总页数、点「下一页」页码前进、点「放大」缩放模式切换生效；
 *  ② 中文水印：Ribbon「PDF 工具 → 添加水印」打开工具箱水印面板 → 输入中文 → 选目标 PDF → 开始处理
 *     → 运行时捕获产出的 Blob → 断言产出合法 PDF（`%PDF-` 头、字节数>0）。
 *
 * 说明：以「拦截 URL.createObjectURL」的方式捕获产物字节，规避 Electron 原生「另存为」对话框
 *   （CDP 无法自动确认），从而在无人工介入下确定性地校验产出的 PDF 字节。
 * 退出码：0 = 全部通过；1 = 有断言失败；2 = 脚本/环境错误。
 */
import process from 'node:process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const portArgIdx = process.argv.indexOf('--port');
const port = portArgIdx >= 0 ? Number(process.argv[portArgIdx + 1]) : 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 1×1 透明 PNG（与 adversarial-audit.mjs 同源，纯数据层可嵌入） */
const PNG_1x1 = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
);

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
    this.consoleAll = [];
    this.logs = [];
    this.exceptions = [];
    /** 被拦截的文件选择器（backendNodeId 队列） */
    this.choosers = [];
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
        const line = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
        this.consoleAll.push(`${msg.params.type}: ${line.slice(0, 200)}`);
        if (msg.params.type === 'error') this.consoleErrors.push(line);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(
          msg.params.exceptionDetails?.exception?.description ?? 'unknown',
        );
      }
      if (msg.method === 'Log.entryAdded') {
        this.logs.push(`${msg.params.entry.level}: ${msg.params.entry.text}`.slice(0, 240));
      }
      if (msg.method === 'Page.fileChooserOpened') {
        this.choosers.push(msg.params.backendNodeId);
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

  async eval(expression, awaitPromise = false, userGesture = false) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    }
    return r.result?.value;
  }

  /**
   * 触发一次文件选择：点按钮（点击后弹出文件选择器）→ 等拦截事件 → 用给定路径填充输入框。
   * 注意：Chromium 只允许在**用户激活（user activation）**下用脚本触发 <input type=file>.click()，
   * 故此处 Runtime.evaluate 必须带 userGesture:true，否则文件选择器不会打开、拦截事件不会触发。
   * @param {string} clickExpr 触发 <input type=file>.click() 的页面表达式（应返回是否找到按钮）
   * @param {string} filePath 要注入的真实磁盘路径
   */
  async chooseFile(clickExpr, filePath) {
    const before = this.choosers.length;
    const clicked = await this.eval(clickExpr, false, true);
    if (!clicked) throw new Error(`未找到触发文件选择的按钮：${clickExpr}`);
    let backendNodeId;
    for (let t = 0; t < 30; t++) {
      if (this.choosers.length > before) {
        backendNodeId = this.choosers[this.choosers.length - 1];
        break;
      }
      await sleep(200);
    }
    if (backendNodeId === undefined) throw new Error('未捕获到文件选择器事件（fileChooserOpened）');
    await this.send('DOM.setFileInputFiles', { files: [filePath], backendNodeId });
  }
}

function pickIgnorable(text) {
  const t = String(text);
  return t.includes('favicon') || t.includes('Autofill') || t.includes('nsresult') || /gpu/i.test(t);
}

/** 通用轮询：返回首个 truthy 的求值结果 */
async function poll(cdp, expr, tries = 30, gap = 400) {
  for (let i = 0; i < tries; i++) {
    const v = await cdp.eval(expr);
    if (v) return v;
    await sleep(gap);
  }
  return null;
}

async function main() {
  // 自造 3 页 PDF（阅读器翻页断言用）与 1 页 PDF（水印用）
  const pdfMod = await import(new URL('../packages/pdf/dist/index.js', import.meta.url).href);
  const dir = path.join(os.tmpdir(), 'jareking-pdf-reader-smoke');
  await fs.mkdir(dir, { recursive: true });
  const threePage = await pdfMod.imagesToPdf([
    { bytes: PNG_1x1, type: 'png' },
    { bytes: PNG_1x1, type: 'png' },
    { bytes: PNG_1x1, type: 'png' },
  ]);
  const samplePdf = path.join(dir, 'sample-3page.pdf');
  await fs.writeFile(samplePdf, threePage);
  console.log(`自造 PDF：${samplePdf}（${threePage.length} 字节，3 页）`);

  const page = await findPage();
  console.log(`目标: ${page.title || '(无标题)'} ${page.url}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Log.enable');

  const results = {};
  let failed = false;

  // 回首页空状态（消除上一次 GUI 冒烟遗留的标签页/弹窗）
  await cdp.eval(`location.reload()`, true).catch(() => {});
  await sleep(2500);
  await cdp.eval(
    `(async () => { const l = await window.jareking.invoke('ai:config:list'); await Promise.all(l.map((c)=>window.jareking.invoke('ai:config:delete',{id:c.id}))); return true; })()`,
    true,
  ).catch(() => {});

  /* =========================================================== ① PDF 阅读器 */
  await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });

  // 切到 Ribbon「PDF 工具」标签页，点「打开PDF」→ 拦截文件选择器注入路径
  results.pdfRibbonTabClick = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('button')].find((x)=>x.textContent.trim()==='PDF 工具');
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(800);
  await cdp.chooseFile(
    `(() => { const b=[...document.querySelectorAll('button')].find((x)=>x.textContent.trim()==='打开PDF'); if(b) b.click(); return !!b; })()`,
    samplePdf,
  );

  // 阅读器就绪：出现「共 N 页」状态
  results.readerNumPages = await poll(
    cdp,
    `(() => {
       const bar = document.querySelector('input[aria-label="页码"]');
       if (bar) { const t = bar.parentElement ? bar.parentElement.textContent : ''; const m = t.match(/\\/\\s*(\\d+)\\s*页/); if (m) return Number(m[1]); }
       return 0;
     })()`,
    50,
    400,
  );
  results.readerDiag = await cdp.eval(`(() => ({
    hasToolbar: !![...document.querySelectorAll('button')].find((b)=>b.getAttribute('aria-label')==='打开 PDF'),
    pageInputExists: !!document.querySelector('input[aria-label="页码"]'),
    placeholder: document.body.textContent.includes('尚未打开 PDF'),
    loading: document.body.textContent.includes('正在加载 PDF'),
    gong: (document.body.innerText.match(/共[^\\n]{0,14}/g)||[]),
    statusLine: (() => { const el=[...document.querySelectorAll('span')].find((s)=>/共\\s*\\d+\\s*页/.test(s.textContent)); return el && el.parentElement ? el.parentElement.innerText.replace(/\\n/g,' | ') : null; })(),
    canvases: document.querySelectorAll('canvas').length,
    textLayers: document.querySelectorAll('.jk-pdf-text-layer').length,
    bodyTail: document.body.innerText.slice(-300).replace(/\\n/g,' | '),
  }))()`);
  results.dbgFileRead = await cdp.eval(
    `(async () => {
       const bytes = await window.jareking.invoke('doc:read-file', { path: ${JSON.stringify(samplePdf)} });
       if (!bytes) return { ok:false };
       const u = new Uint8Array(bytes);
       return { ok:true, len:u.length, head:String.fromCharCode(...u.slice(0,5)) };
     })()`,
    true,
  );
  results.readerCanvas = await cdp.eval(`document.querySelectorAll('canvas').length`);
  results.readerCanvasSized = await cdp.eval(
    `(() => { const c=document.querySelector('canvas'); return !!c && c.width>0 && c.height>0; })()`,
  );
  results.readerLogs = cdp.logs.slice(-12);
  results.readerConsoleAll = cdp.consoleAll.slice(-12);
  results.readerOpenFailed = await cdp.eval(
    `document.body.textContent.includes('未能读取文件路径') || document.body.textContent.includes('打开失败')`,
  );

  // 翻页：点「下一页」→ 页码输入框变 2
  results.pageBefore = await cdp.eval(`document.querySelector('input[aria-label="页码"]')?.value ?? null`);
  await cdp.eval(
    `(() => { const b=[...document.querySelectorAll('button')].find((x)=>x.getAttribute('aria-label')==='下一页'); if(b) b.click(); return !!b; })()`,
  );
  await sleep(600);
  results.pageAfter = await cdp.eval(`document.querySelector('input[aria-label="页码"]')?.value ?? null`);

  // 缩放：默认「适应宽度」为按下态；点「放大」→ fit 切自由缩放 → 适应宽度取消按下
  results.fitWidthBefore = await cdp.eval(
    `[...document.querySelectorAll('button')].find((x)=>x.getAttribute('aria-label')==='适应宽度')?.getAttribute('aria-pressed') ?? null`,
  );
  await cdp.eval(
    `(() => { const b=[...document.querySelectorAll('button')].find((x)=>x.getAttribute('aria-label')==='放大'); if(b) b.click(); return !!b; })()`,
  );
  await sleep(500);
  results.fitWidthAfter = await cdp.eval(
    `[...document.querySelectorAll('button')].find((x)=>x.getAttribute('aria-label')==='适应宽度')?.getAttribute('aria-pressed') ?? null`,
  );
  results.zoomLabel = await cdp.eval(
    `[...document.querySelectorAll('span')].map((s)=>s.textContent).find((t)=>/^\\d+%$/.test(t)) ?? null`,
  );

  results.readerOk =
    results.readerNumPages === 3 &&
    results.readerCanvas >= 1 &&
    results.readerCanvasSized === true &&
    !results.readerOpenFailed &&
    results.pageBefore === '1' &&
    results.pageAfter === '2' &&
    results.fitWidthBefore === 'true' &&
    results.fitWidthAfter === 'false' &&
    typeof results.zoomLabel === 'string';
  if (!results.readerOk) failed = true;

  /* =========================================================== ② 中文水印 */
  // 关闭可能的弹窗/回首页
  await cdp.eval(`(() => { const x=document.querySelector('[role="dialog"] button[aria-label], [role="dialog"] .lucide-x'); return true; })()`);
  await cdp.eval(`location.reload()`, true).catch(() => {});
  await sleep(2500);
  await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });

  // 打开 Ribbon「PDF 工具 → 添加水印」
  await cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find((x)=>x.textContent.trim()==='PDF 工具'); if(b) b.click(); return !!b; })()`);
  await sleep(400);
  results.watermarkPanelOpen = await cdp.eval(`(() => {
    const b=[...document.querySelectorAll('button')].find((x)=>x.textContent.trim()==='添加水印');
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(600);
  results.watermarkDialogVisible = await poll(
    cdp,
    `document.body.textContent.includes('水印文字') && document.querySelector('[role="dialog"]') ? true : false`,
  );

  // 输入中文水印文案
  await cdp.eval(`(() => {
    const d=document.querySelector('[role="dialog"]');
    if(!d) return false;
    const input=[...d.querySelectorAll('input')].find((i)=>i.placeholder && i.placeholder.includes('机密'));
    if(!input) return false;
    const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    setter.call(input,'机密');
    input.dispatchEvent(new Event('input',{bubbles:true}));
    return true;
  })()`);
  await sleep(400);
  results.watermarkCjkHint = await cdp.eval(`document.body.textContent.includes('位图水印')`);

  // 选目标 PDF：水印面板「选择文件」→ 拦截注入 1 页 PDF
  const onePagePdf = path.join(dir, 'sample-1page.pdf');
  await fs.writeFile(onePagePdf, await pdfMod.imagesToPdf([{ bytes: PNG_1x1, type: 'png' }]));
  await cdp.chooseFile(
    `(() => { const d=document.querySelector('[role="dialog"]'); if(!d) return false; const b=[...d.querySelectorAll('button')].find((x)=>x.textContent.trim()==='选择文件'); if(b) b.click(); return !!b; })()`,
    onePagePdf,
  );
  await sleep(400);
  results.watermarkTargetChosen = await cdp.eval(
    `(() => { const d=document.querySelector('[role="dialog"]'); return !!d && d.textContent.includes('sample-1page.pdf'); })()`,
  );

  // 运行时捕获产出 Blob（拦截 URL.createObjectURL），规避原生「另存为」对话框
  await cdp.eval(`(() => {
    if (window.__jkSmokePatched) return true;
    window.__jkSmokeLastBlob = null;
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (b) { try { window.__jkSmokeLastBlob = b; } catch {} return orig(b); };
    window.__jkSmokePatched = true;
    return true;
  })()`);

  // 点「开始处理」
  results.watermarkRunClicked = await cdp.eval(`(() => {
    const d=document.querySelector('[role="dialog"]');
    if(!d) return false;
    const b=[...d.querySelectorAll('button')].find((x)=>x.textContent.trim()==='开始处理');
    if(b) b.click();
    return !!b;
  })()`);

  // 等 note 出现（成功或失败），再读取捕获的 Blob 头
  results.watermarkNote = await poll(
    cdp,
    `(() => { const t=document.body.textContent; const m=t.match(/[✅❌][^\\n]{0,60}/); return m ? m[0] : null; })()`,
    30,
    400,
  );
  const captured = await cdp.eval(
    `(async () => {
      const b = window.__jkSmokeLastBlob;
      if (!b) return null;
      const u = new Uint8Array(await b.arrayBuffer());
      return { size: u.length, head: String.fromCharCode(...u.slice(0, 5)) };
    })()`,
    true,
  );
  results.watermarkBytes = captured;
  results.watermarkOk =
    !!captured && captured.size > 0 && captured.head === '%PDF-' && results.watermarkTargetChosen === true;
  if (!results.watermarkOk) failed = true;

  /* =========================================================== 控制台错误 */
  // 重置采集基线：仅关注本脚本操作后的错误（前面的 reload 噪声已排除）
  const errors = [...cdp.exceptions, ...cdp.consoleErrors].filter((e) => !pickIgnorable(e));
  results.consoleErrors = errors.slice(0, 10);
  if (errors.length > 0) failed = true;

  console.log('=== PDF 阅读器 + 中文水印 定向验证结果 ===');
  console.log(JSON.stringify(results, null, 2));
  console.log(failed ? '❌ 定向验证未通过' : '✅ 定向验证通过');

  try {
    await cdp.send('Browser.close');
  } catch {
    /* 忽略 */
  }
  await sleep(500);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('定向验证脚本失败:', e.message);
  process.exit(2);
});
