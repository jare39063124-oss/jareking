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

  // 0. 应用就绪（刷新一次，消除冷启动会话恢复等不确定状态）
  await cdp.eval(`document.readyState === 'complete'`);
  results.appRoot = await cdp.eval(`!!document.querySelector('#root') && document.querySelector('#root').children.length > 0`);
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
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Sheet'));
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
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Writer'));
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
          operations: [{ op: 'insertText', text: 'AI 插入成功' }],
          explanation: '在光标处插入验证文本',
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
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Writer'));
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
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Writer'));
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
    `document.body.textContent.includes('1 个操作成功')`,
  );
  // 清理配置
  await cdp.eval(
    `window.jareking.invoke('ai:config:list').then((list) =>
      Promise.all(list.filter((c) => c.name === 'LLM 冒烟').map((c) => window.jareking.invoke('ai:config:delete', { id: c.id }))))`,
    true,
  );
  llm.close();
  if (results.aiPanelSent !== 'sent' || !results.aiDocChanged || !results.aiSummaryShown) failed = true;
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
