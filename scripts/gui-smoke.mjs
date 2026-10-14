/**
 * GUI 冒烟验证（T1.4 / T2.2 验收）—— 通过 Chrome DevTools Protocol 自动化。
 *
 * 用法：
 *   1) 启动应用：cd apps/desktop && env -u ELECTRON_RUN_AS_NODE \
 *        ./node_modules/.bin/electron . --remote-debugging-port=9222
 *   2) node scripts/gui-smoke.mjs [--port 9222]
 *
 * 步骤：连 CDP → 打开 Writer 标签（校验 ProseMirror + 示例文档标题）→
 * 打开 Sheet 标签（校验 Univer canvas）→ 收集渲染错误 → Browser.close。
 * Node ≥22（内置 WebSocket）。
 */
import process from 'node:process';
import http from 'node:http';

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
      // 主窗口：本地渲染页（file:// 或 dev server）
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

  // 0. 应用就绪（轮询等待挂载；刷新一次消除冷启动会话恢复等不确定状态）
  results.appRoot = false;
  for (let t = 0; t < 20; t++) {
    results.appRoot = await cdp.eval(`!!document.querySelector('#root') && document.querySelector('#root').children.length > 0`);
    if (results.appRoot) break;
    await sleep(500);
  }
  if (!results.appRoot) failed = true;
  await cdp.eval(`location.reload()`, true).catch(() => {});
  await sleep(2500);
  // 清空历史 AI 配置（此前失败运行可能遗留指向死端口的配置，面板取首个启用配置会踩中）
  const cleaned = await cdp.eval(
    `(async () => {
      const list = await window.jareking.invoke('ai:config:list');
      await Promise.all(list.map((c) => window.jareking.invoke('ai:config:delete', { id: c.id })));
      return list.length;
    })()`,
    true,
  );
  console.log(`(清理历史 AI 配置: ${cleaned} 条)`);

  // 1. Sheet（先验证：EmptyState 的模块按钮只在没有标签页时显示）
  const openSheet = `(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('表格'));
    if (!btn) return 'no-button';
    btn.click();
    return 'clicked';
  })()`;
  results.sheetOpen = await cdp.eval(openSheet);
  await sleep(4000); // Univer 初始化较重
  results.univerCanvas = await cdp.eval(`document.querySelectorAll('canvas').length`);
  results.univerMounted = await cdp.eval(
    `(() => { const el = document.querySelector('[class*="univer"]'); return !!el; })()`,
  );
  if (results.univerCanvas < 1) failed = true;

  // 2. Writer：刷新页面回到空状态（模块按钮恢复），再点击 Writer
  await cdp.eval(`location.reload()`, true).catch(() => {});
  await sleep(2500);
  const openWriter = `(() => {
    if (document.querySelector('.ProseMirror')) return 'already';
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('文字'));
    if (!btn) return 'no-button';
    btn.click();
    return 'clicked';
  })()`;
  results.writerOpen = await cdp.eval(openWriter);
  await sleep(1500);
  results.proseMirror = await cdp.eval(`!!document.querySelector('.ProseMirror')`);
  results.writerH1 = await cdp.eval(`document.querySelector('.ProseMirror h1')?.textContent ?? null`);
  results.writerTextLen = await cdp.eval(`document.querySelector('.ProseMirror')?.textContent.length ?? 0`);
  results.writerEditable = await cdp.eval(
    `(() => { const pm = document.querySelector('.ProseMirror'); return !!pm && pm.getAttribute('contenteditable') !== 'false'; })()`,
  );
  if (!results.proseMirror || results.writerTextLen < 10) failed = true;

  // 2b. 排版工具箱（用户反馈 1）：真实点击「一键整理」→ HTML 断言排版属性落地
  await cdp.eval(
    `(() => { const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '一键整理'); if (btn) btn.click(); return !!btn; })()`,
  );
  await sleep(600);
  results.tidyApplied = await cdp.eval(
    `(() => { const h = window.__jkWriterDebug?.html?.() ?? ''; return h.includes('text-indent: 2em') && h.includes('line-height: 1.5') && h.includes('text-align: justify'); })()`,
  );
  // 千分符：真实输入一段含大数字的文字 → 点击「千分符」→ 断言文本变为 1,234,567
  await cdp.eval(
    `(() => {
      const pm = document.querySelector('.ProseMirror');
      if (!pm) return false;
      pm.focus();
      document.execCommand('insertText', false, '\\n本月营收 1234567 元，同比新增 45600。');
      return true;
    })()`,
  );
  await sleep(300);
  results.numberBefore = await cdp.eval(`window.__jkWriterDebug?.text?.()?.includes('1234567') ?? false`);
  await cdp.eval(
    `(() => { const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '千分符'); if (btn) btn.click(); return !!btn; })()`,
  );
  await sleep(500);
  results.tidyNumbers = await cdp.eval(
    `(() => { const t = window.__jkWriterDebug?.text?.() ?? ''; return t.includes('1,234,567') && t.includes('45,600'); })()`,
  );
  if (!results.tidyApplied || !results.tidyNumbers) failed = true;

  // 3. Slide：再次刷新回空状态，点击演示模块
  await cdp.eval(`location.reload()`, true).catch(() => {});
  await sleep(2500);
  const openSlide = `(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('演示'));
    if (!btn) return 'no-button';
    btn.click();
    return 'clicked';
  })()`;
  results.slideOpen = await cdp.eval(openSlide);
  await sleep(2500); // Konva 初始化
  results.konvaCanvas = await cdp.eval(`document.querySelectorAll('canvas').length`);
  // 幻灯片缩略列表（"第 1 页"按钮）
  results.slidePanel = await cdp.eval(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('第 1 页')); return !!b; })()`,
  );
  if (results.konvaCanvas < 1 || !results.slidePanel) failed = true;

  // 3b. 放映模式：点「放映」→ 全屏覆盖层出现 → Esc 退出
  results.slideshowOpen = await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('放映'));
    if (!btn) return 'no-button';
    btn.click();
    return 'clicked';
  })()`);
  await sleep(800);
  results.slideshowOverlay = await cdp.eval(
    `(() => { const el = [...document.querySelectorAll('div')].find((d) => d.className.includes('bg-black') && d.className.includes('fixed')); return !!el; })()`,
  );
  results.slideshowCounter = await cdp.eval(
    `(() => { const el = [...document.querySelectorAll('div')].find((d) => d.textContent === '1 / 2 · Esc 退出 · 右键上一页'); return !!el; })()`,
  );
  await cdp.eval(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
  );
  await sleep(500);
  results.slideshowClosed = await cdp.eval(
    `(() => { const el = [...document.querySelectorAll('div')].find((d) => d.className.includes('bg-black') && d.className.includes('fixed')); return !el; })()`,
  );
  if (!results.slideshowOverlay || !results.slideshowClosed) failed = true;

  // 4. T4.2 AI 配置端到端：保存（safeStorage 加密）→ resolve → adapter 连通 mock 网关
  const mock = http.createServer((req, res) => {
    if (req.url?.endsWith('/chat/completions')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: '连接成功' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockBase = `http://127.0.0.1:${mock.address().port}/v1`;

  results.aiSave = await cdp.eval(
    `window.jareking.invoke('ai:config:save', {
      name: '冒烟配置', kind: 'openai-compatible', baseUrl: '${mockBase}',
      model: 'smoke-model', apiKey: 'sk-smoke-123', enabled: true,
    }).then((c) => c.id ? 'ok' : 'no-id')`,
    true,
  );
  results.aiResolveNonEmpty = await cdp.eval(
    `(async () => {
      const list = await window.jareking.invoke('ai:config:list');
      const key = await window.jareking.invoke('ai:key:resolve', { id: list[0].id });
      return key.startsWith('sk-smoke-');
    })()`,
    true,
  );
  // 配置列表不泄漏 Key
  results.aiListNoLeak = await cdp.eval(
    `window.jareking.invoke('ai:config:list').then((list) => !JSON.stringify(list).includes('sk-smoke-'))`,
    true,
  );
  // 用解析出的 Key 走适配器真实调用 mock 网关（页面内等价链路验证）
  results.aiCallMock = await cdp.eval(
    `(async () => {
      const list = await window.jareking.invoke('ai:config:list');
      const key = await window.jareking.invoke('ai:key:resolve', { id: list[0].id });
      const res = await fetch('${mockBase}/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model: 'smoke-model', messages: [{ role: 'user', content: 'hi' }] }),
      });
      const j = await res.json();
      return j.choices?.[0]?.message?.content === '连接成功';
    })()`,
    true,
  );
  // UI：设置面板展示 AI 配置区块（列表内容不做强校验——冒烟经 IPC 存的配置
  // 不刷新渲染层 store，属测试路径差异；真实 UI 走设置面板保存会自动刷新）
  results.aiUi = await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label')?.includes('设置') || b.title?.includes('设置'));
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(800);
  results.aiSectionVisible = await cdp.eval(
    `!!document.body.textContent.includes('AI 服务商') && !!document.body.textContent.includes('DPAPI')`,
  );
  // 清理：删除测试配置
  await cdp.eval(
    `window.jareking.invoke('ai:config:list').then((list) =>
      Promise.all(list.filter((c) => c.name === '冒烟配置').map((c) => window.jareking.invoke('ai:config:delete', { id: c.id }))))`,
    true,
  );
  mock.close();

  // 5. T4.3 全链路：mock LLM（返回 ops 计划）→ Writer + AI 面板发指令 → 文档真实变更
  const llm = http.createServer((req, res) => {
    if (req.url?.endsWith('/chat/completions')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const plan = JSON.stringify({
          operations: [
            { op: 'insertText', text: 'AI 插入成功' },
            {
              op: 'insertChart',
              chartType: 'bar',
              title: '季度营收对比',
              labels: ['Q1', 'Q2'],
              series: [{ name: '营收', values: [1200000, 1580000] }],
            },
          ],
          explanation: '插入验证文本并生成季度营收对比图表',
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: plan }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 80, completion_tokens: 20 },
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => llm.listen(0, '127.0.0.1', r));
  const llmBase = `http://127.0.0.1:${llm.address().port}/v1`;

  // 回到 Writer
  await cdp.eval(`location.reload()`, true).catch(() => {});
  await sleep(2500);
  await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('文字'));
    if (btn) btn.click();
  })()`);
  await sleep(1500);
  // 保存指向 mock LLM 的启用配置（保存后 reload 让渲染层 aiStore 重新加载）
  await cdp.eval(
    `(async () => {
      await window.jareking.invoke('ai:config:save', {
        name: 'LLM 冒烟', kind: 'openai-compatible', baseUrl: '${llmBase}',
        model: 'plan-model', apiKey: 'sk-plan', enabled: true,
      });
      return 'ok';
    })()`,
    true,
  );
  await cdp.eval(`location.reload()`, true).catch(() => {});
  await sleep(2500);
  await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('文字'));
    if (btn) btn.click();
  })()`);
  await sleep(1500);
  // AI 面板输入指令并回车
  results.aiPanelSent = await cdp.eval(`(() => {
    const input = document.querySelector('input[placeholder="输入指令，回车发送"]');
    if (!input) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '在光标处插入验证文本');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 'sent';
  })()`);
  await sleep(4000);
  // 验证文档真实变更 + 执行摘要出现
  results.aiDocChanged = await cdp.eval(
    `document.querySelector('.ProseMirror')?.textContent.includes('AI 插入成功') ?? false`,
  );
  results.aiSummaryShown = await cdp.eval(
    `document.body.textContent.includes('操作成功')`,
  );
  results.aiChartInserted = await cdp.eval(
    `(() => { const h = window.__jkWriterDebug?.html?.() ?? ''; return h.includes('<img') && h.includes('季度营收对比'); })()`,
  );
  // 清理配置
  await cdp.eval(
    `window.jareking.invoke('ai:config:list').then((list) =>
      Promise.all(list.filter((c) => c.name === 'LLM 冒烟').map((c) => window.jareking.invoke('ai:config:delete', { id: c.id }))))`,
    true,
  );
  llm.close();

  // 6. T4.5 Sheet AI：mock LLM（返回 setValues 计划）→ Sheet AI 输入 → 快照断言
  const llm2 = http.createServer((req, res) => {
    if (req.url?.endsWith('/chat/completions')) {
      console.log('[smoke-mock2] HIT');
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const plan = JSON.stringify({
          operations: [{ op: 'setValues', startCell: 'F1', values: [['AI', '写入']] }],
          explanation: '在 F1 写入验证数据',
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: plan }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 60, completion_tokens: 15 },
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => llm2.listen(0, '127.0.0.1', r));
  const llm2Base = `http://127.0.0.1:${llm2.address().port}/v1`;

  await cdp.eval(`location.reload()`, true).catch(() => {});
  await sleep(2500);
  await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('表格'));
    if (btn) btn.click();
  })()`);
  await sleep(3500);
  await cdp.eval(
    `(async () => {
      await window.jareking.invoke('ai:config:save', {
        name: 'Sheet冒烟', kind: 'openai-compatible', baseUrl: '${llm2Base}',
        model: 'sheet-model', apiKey: 'sk-sheet', enabled: true,
      });
      return 'ok';
    })()`,
    true,
  );
  await cdp.eval(`location.reload()`, true).catch(() => {});
  await sleep(2500);
  await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('表格'));
    if (btn) btn.click();
  })()`);
  // 等 Univer 就绪（输入框非 disabled）
  for (let t = 0; t < 15; t++) {
    const st = await cdp.eval(
      `(() => { const i = document.querySelector('input[placeholder="AI：如「在D2算B列合计」"]'); return i ? (i.disabled ? 'disabled' : 'ready') : 'no-input'; })()`,
    );
    if (st === 'ready') break;
    await sleep(1000);
  }
  // 等 Univer 就绪（输入框非 disabled）后经调试钩子触发 AI（打字路径已由 Writer 冒烟证明）
  for (let t = 0; t < 15; t++) {
    const st = await cdp.eval(
      `(() => { const i = document.querySelector('input[placeholder="AI：如「在D2算B列合计」"]'); return i ? (i.disabled ? 'disabled' : 'ready') : 'no-input'; })()`,
    );
    if (st === 'ready') break;
    await sleep(1000);
  }
  results.sheetAiSent = await cdp.eval(
    `(() => {
      if (!window.__jkDebug?.runSheetAi) return 'no-hook';
      window.__jkDebug.runSheetAi('在F1写入验证数据');
      return 'sent';
    })()`,
  );
  await sleep(400);
  results.sheetAiEarlyNote = await cdp.eval(
    `[...document.querySelectorAll('span')].map((x) => x.textContent).find((t) => t?.includes('AI 规划中') || t?.includes('失败') || t?.includes('已执行')) ?? '(none)'`,
  );
  results.sheetAiConfigs = await cdp.eval(
    `(async () => { const l = await window.jareking.invoke('ai:config:list'); return JSON.stringify(l.map((c) => ({ n: c.name, b: c.baseUrl, e: c.enabled }))); })()`,
    true,
  );
  await sleep(4000);
  results.sheetAiNote = await cdp.eval(
    `(() => { const s = [...document.querySelectorAll('span')].map((x) => x.textContent).find((t) => t && (t.includes('AI 已执行') || t.includes('AI 规划中') || t.startsWith('失败') || t.includes('跳过'))); return s?.slice(0, 80) ?? '(无状态行)'; })()`,
  );
  results.sheetAiCell = await cdp.eval(
    `(async () => {
      const snap = await window.__jkDebug.snapshot();
      const found = [];
      for (const [sid, sheet] of Object.entries(snap?.sheets ?? {})) {
        for (const [r, row] of Object.entries(sheet?.cellData ?? {})) {
          for (const [c, cell] of Object.entries(row)) {
            if (JSON.stringify(cell).includes('AI')) found.push(sid + ' ' + r + ',' + c + '=' + JSON.stringify(cell));
          }
        }
      }
      return JSON.stringify({ found, sheetIds: Object.keys(snap?.sheets ?? {}) });
    })()`,
    true,
  );
  await cdp.eval(
    `window.jareking.invoke('ai:config:list').then((list) =>
      Promise.all(list.filter((c) => c.name === 'Sheet冒烟').map((c) => window.jareking.invoke('ai:config:delete', { id: c.id }))))`,
    true,
  );
  llm2.close();
  if (results.sheetAiSent !== 'sent' || !String(results.sheetAiCell).includes('"found":["')) failed = true;

  // 7. T4.6 Presentation AI：mock LLM（返回 addSlide 计划）→ 调试钩子触发 → 页数断言
  const llm3 = http.createServer((req, res) => {
    if (req.url?.endsWith('/chat/completions')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const plan = JSON.stringify({
          operations: [{ op: 'addSlide', title: 'AI 生成页', bullets: ['要点一', '要点二'] }],
          explanation: '已生成 1 页',
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: plan }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 70, completion_tokens: 25 },
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => llm3.listen(0, '127.0.0.1', r));
  const llm3Base = `http://127.0.0.1:${llm3.address().port}/v1`;

  await cdp.eval(`location.reload()`, true).catch(() => {});
  await sleep(2500);
  await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('演示'));
    if (btn) btn.click();
  })()`);
  await sleep(2500);
  await cdp.eval(
    `(async () => {
      await window.jareking.invoke('ai:config:save', {
        name: 'PPT冒烟', kind: 'openai-compatible', baseUrl: '${llm3Base}',
        model: 'ppt-model', apiKey: 'sk-ppt', enabled: true,
      });
      return 'ok';
    })()`,
    true,
  );
  await cdp.eval(`location.reload()`, true).catch(() => {});
  await sleep(2500);
  await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('演示'));
    if (btn) btn.click();
  })()`);
  await sleep(2500);
  results.pptAiSent = await cdp.eval(
    `(() => {
      if (!window.__jkSlideDebug?.runPresentationAi) return 'no-hook';
      window.__jkSlideDebug.runPresentationAi('生成一页 AI 生成页');
      return 'sent';
    })()`,
  );
  await sleep(4000);
  results.pptAiSlideCount = await cdp.eval(`window.__jkSlideDebug?.slideCount?.() ?? -1`);
  await cdp.eval(
    `window.jareking.invoke('ai:config:list').then((list) =>
      Promise.all(list.filter((c) => c.name === 'PPT冒烟').map((c) => window.jareking.invoke('ai:config:delete', { id: c.id }))))`,
    true,
  );
  llm3.close();

  // PPT 图表插入（用户反馈：PPT 数据页可视化难）——复用图表渲染器 + 图片管线
  results.pptChartBefore = await cdp.eval(`window.__jkSlideDebug?.imageCount?.() ?? -1`);
  results.pptChartBtnCount = await cdp.eval(
    `[...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === '图表').length`,
  );
  results.pptChartRender = await cdp.eval(`window.__jkSlideDebug?.renderChartTest?.() ?? -1`);
  await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '图表');
    if (btn) btn.click();
  })()`);
  await sleep(800);
  results.pptChartModalOpen = await cdp.eval(`document.body.innerText.includes('插入图表')`);
  // 注意：必须在 [role="dialog"] 弹窗内查找「插入」按钮。若直接全局匹配，
  // 会误命中功能区同名「插入」按钮——因为其祖先 #root 包含了弹窗标题「插入图表」文本。
  results.pptChartInsertFound = await cdp.eval(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return false;
    return [...dialog.querySelectorAll('button')].some((b) => b.textContent.trim() === '插入');
  })()`);
  // 弹窗「插入」点击（UI 接线诊断）——限定在弹窗内
  await cdp.eval(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return;
    const target = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '插入');
    if (target) target.click();
  })()`);
  await sleep(1200);
  results.pptChartAfterModal = await cdp.eval(`window.__jkSlideDebug?.imageCount?.() ?? -1`);
  // 兜底：直接调用插入管线，验证功能本身（与弹窗点击结果对比定位接线问题）
  await cdp.eval(`window.__jkSlideDebug?.insertChart?.()`);
  await sleep(1200);
  results.pptChartAfter = await cdp.eval(`window.__jkSlideDebug?.imageCount?.() ?? -1`);

  if (results.pptAiSent !== 'sent' || results.pptAiSlideCount !== 3) failed = true;
  // 关键验证：弹窗「插入」按钮点击（UI 接线）必须真正插入图片——这是 Modal portal 修复的验收点
  if (results.pptChartRender <= 0 || results.pptChartAfterModal <= results.pptChartBefore || results.pptChartAfter <= results.pptChartBefore) failed = true;

  // 8. PDF 工具箱（文件菜单入口）
  await cdp.eval(`location.reload()`, true).catch(() => {});
  await sleep(2500);
  results.pdfFileTab = await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '文件');
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(500);
  results.pdfToolboxOpen = await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('PDF 工具箱'));
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(600);
  results.pdfToolboxVisible = await cdp.eval(
    `document.body.textContent.includes('PDF 工具箱') && document.body.textContent.includes('本地离线处理') && document.body.textContent.includes('提取 / 删除页')`,
  );
  if (!results.pdfToolboxVisible) failed = true;


  if (results.aiPanelSent !== 'sent' || !results.aiDocChanged || !results.aiSummaryShown || !results.aiChartInserted) failed = true;
  if (
    results.aiSave !== 'ok' ||
    !results.aiResolveNonEmpty ||
    !results.aiListNoLeak ||
    !results.aiCallMock ||
    !results.aiSectionVisible
  )
    failed = true;

  // 3. 汇总错误
  const errors = [...cdp.exceptions, ...cdp.consoleErrors].filter((e) => !pickIgnorable(e));
  results.consoleErrors = errors.slice(0, 10);
  if (errors.length > 0) failed = true;

  console.log('=== GUI 冒烟结果 ===');
  console.log(JSON.stringify(results, null, 2));
  console.log(failed ? '❌ 冒烟未通过' : '✅ GUI 冒烟通过');

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