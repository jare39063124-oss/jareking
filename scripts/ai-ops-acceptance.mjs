/**
 * T4.9 Phase 验收：20 条预置指令（10 文档 + 10 表格）自动化执行 + 撤销抽验。
 *
 * 前置：electron . --remote-debugging-port=9222 --jk-debug（新构建）
 * 用法：node scripts/ai-ops-acceptance.mjs
 *
 * 方法：mock LLM（127.0.0.1 随机端口）按指令关键词返回确定性 ops 计划
 * （只匹配【用户指令】段，避免多轮历史关键词串台）；断言一律轮询等待
 * （Univer/TipTap 命令应用是异步的，固定 sleep 有竞态）。
 */
import process from 'node:process';
import http from 'node:http';

const port = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
          this.consoleErrors.push(args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
        }
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push('[exception] ' + (msg.params.exceptionDetails?.exception?.description ?? '').slice(0, 200));
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

/* ---------------- mock LLM ---------------- */

const WRITER_PLANS = [
  { key: '验收一', ops: [{ op: 'insertText', text: '验收一文本' }], explanation: '插入验收一文本' },
  { key: '验收二标题', ops: [{ op: 'insertParagraph', text: '验收二标题', heading: 1 }], explanation: '插入一级标题' },
  { key: '验收三段落', ops: [{ op: 'insertParagraph', text: '验收三段落内容' }], explanation: '插入段落' },
  { key: '验收四表格', ops: [{ op: 'insertTable', rows: 2, cols: 3 }], explanation: '插入 2×3 表格' },
  { key: '验收五分隔线', ops: [{ op: 'insertHorizontalRule' }], explanation: '插入分隔线' },
  { key: '验收六红字', ops: [{ op: 'setColor', color: '#FF0000' }, { op: 'insertText', text: '验收六红字' }], explanation: '插入红色文字' },
  { key: '验收七', ops: [{ op: 'setFormat', mark: 'bold', value: true }, { op: 'insertText', text: '验收七粗体' }], explanation: '插入加粗文字' },
  { key: '铺垫撤销八', ops: [{ op: 'insertText', text: ' 撤销目标八' }], explanation: '插入铺垫文本' },
  { key: '撤销上一步', ops: [{ op: 'undo' }], explanation: '撤销上一步' },
  { key: '重做', ops: [{ op: 'redo' }], explanation: '重做' },
  { key: '验收十千分符', ops: [{ op: 'insertText', text: '验收十 1234567' }, { op: 'formatNumbers', scope: 'all' }], explanation: '插入数字并加千分符' },
];

const SHEET_PLANS = [
  { key: '表格验收一', ops: [{ op: 'setValue', target: 'A1', value: '表格验收一' }], explanation: 'A1 写入' },
  { key: '表格验收二', ops: [{ op: 'setValue', target: 'A2', value: 100 }], explanation: 'A2 写入' },
  { key: '表格验收三', ops: [{ op: 'setValue', target: 'A3', value: 200 }], explanation: 'A3 写入' },
  { key: '表格验收四', ops: [{ op: 'setValues', startCell: 'B1', values: [['x', 'y'], ['1', '2']] }], explanation: 'B1:C2 矩阵' },
  { key: '表格验收五', ops: [{ op: 'setFormula', target: 'D1', formula: 'SUM(A2:A3)' }], explanation: 'D1 求和公式' },
  { key: '表格验收六', ops: [{ op: 'setValue', target: 'E1', value: '合计' }, { op: 'setFormula', target: 'F1', formula: 'SUM(A2:A3)' }], explanation: 'E1/F1 组合' },
  { key: '表格验收七', ops: [{ op: 'setValue', target: 'B5', value: '表格验收七' }], explanation: 'B5 写入' },
  { key: '表格验收八', ops: [{ op: 'setValues', startCell: 'C5', values: [[1, 2], [3, 4]] }], explanation: 'C5:D6 矩阵' },
  { key: '表格验收九问答', ops: [], explanation: 'A2+A3=300（数据问答，直接回答不写表格）' },
  { key: '表格验收十', ops: [{ op: 'setValue', target: 'G1', value: '表格验收十' }], explanation: 'G1 写入' },
];

function startMockLlm() {
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith('/chat/completions')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let plan = { operations: [], explanation: '（未匹配指令）' };
        try {
          const j = JSON.parse(body);
          // 只匹配【用户指令】段：多轮对话后文档节选/历史里会出现旧关键词，全文匹配会串台
          const userMsg = j.messages?.map((m) => String(m.content)).join('\n') ?? '';
          const instructionPart = userMsg.split('【用户指令】').pop() ?? userMsg;
          const all = [...WRITER_PLANS, ...SHEET_PLANS];
          // 最长 key 优先：「表格验收一」含子串「验收一」，短 key 抢先会串台
          const hits = all.filter((p) => instructionPart.includes(p.key)).sort((a, b) => b.key.length - a.key.length);
          const hit = hits[0];
          console.error(`[mock] hit=${hit?.key ?? 'NONE'} instr="${instructionPart.replace(/\n/g, ' ').slice(-40)}"`);
          if (hit) plan = { operations: hit.ops, explanation: hit.explanation };
        } catch {
          /* 容错 */
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(plan) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 50, completion_tokens: 20 },
        }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const mock = await startMockLlm();
  const mockBase = `http://127.0.0.1:${mock.address().port}/v1`;

  const page = await findPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');

  for (let t = 0; t < 20; t++) {
    if (await cdp.eval(`!!document.querySelector('#root')?.children.length`)) break;
    await sleep(500);
  }
  await cdp.eval(`location.reload()`, true).catch(() => {});
  await sleep(2500);

  // 干净环境：清历史对话（防上次强杀残留占位消息干扰等待条件）+ 清全部 AI 配置
  await cdp.eval(`(() => { try { localStorage.removeItem('jk-ai-chat-v1'); } catch {} })()`);
  await cdp.eval(
    `(async () => {
      const list = await window.jareking.invoke('ai:config:list');
      await Promise.all(list.map((c) => window.jareking.invoke('ai:config:delete', { id: c.id })));
      return list.length;
    })()`,
    true,
  );
  await cdp.eval(`location.reload()`, true).catch(() => {});
  await sleep(2500);

  await cdp.eval(
    `(async () => {
      await window.jareking.invoke('ai:config:save', {
        name: 'T49验收', kind: 'openai-compatible', baseUrl: '${mockBase}',
        model: 'acceptance', apiKey: 'sk-t49', enabled: true,
      });
      return 'ok';
    })()`,
    true,
  );
  await cdp.eval(`location.reload()`, true).catch(() => {});
  await sleep(2500);

  const results = [];
  const record = (name, pass, note) => {
    results.push({ name, pass });
    console.log(`${pass ? '✅' : '❌'} ${name}${!pass && note ? ' — ' + note : ''}`);
  };
  /** 轮询直到断言为真或超时（返回最终值） */
  const waitUntil = async (exprFn, timeout = 9000, step = 300) => {
    const t0 = Date.now();
    let v = await exprFn();
    while (!v && Date.now() - t0 < timeout) {
      await sleep(step);
      v = await exprFn();
    }
    return v;
  };

  /* ============ Writer 10 条 ============ */
  await cdp.eval(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('文字')); if (b) b.click(); })()`);
  await sleep(2000);
  // AI 面板默认收起（uiStore.aiPanelOpen 默认 false）→ 必须先展开，面板内的指令输入框才在 DOM，
  // 否则 sendPanel 恒返回 'no-input'，Writer 全部用例假失败（与 gui-smoke 同款展开动作）。
  await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find(
      (b) => (b.getAttribute('aria-label') || '').includes('展开 AI 助手面板'),
    );
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(600);

  const sendPanel = async (instruction) => {
    // 用持久化消息计数等待（user+assistant 各一条），不受历史消息文本干扰
    const msgCount = () => cdp.eval(`(() => { try { return JSON.parse(localStorage.getItem('jk-ai-chat-v1') || '[]').length; } catch { return -1; } })()`);
    const before = await msgCount();
    const ok = await cdp.eval(`(() => {
      const input = document.querySelector('input[placeholder="输入指令，回车发送"]');
      if (!input) return 'no-input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(instruction)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return 'sent';
    })()`);
    if (ok !== 'sent') return ok;
    // 等 user+assistant 两条落库（assistant 从「正在规划…」更新为最终摘要）
    await waitUntil(async () => (await msgCount()) >= before + 2, 15000);
    await sleep(300);
    return 'done';
  };

  const wText = () => cdp.eval(`window.__jkWriterDebug?.text?.() ?? ''`);
  const wHtml = () => cdp.eval(`window.__jkWriterDebug?.html?.() ?? ''`);
  const waitText = (needle, expect = true) =>
    waitUntil(async () => (String(await wText()).toLowerCase().includes(needle.toLowerCase()) === expect ? true : false));
  const waitHtml = (needle, expect = true) =>
    waitUntil(async () => (String(await wHtml()).toLowerCase().includes(needle.toLowerCase()) === expect ? true : false));
  /** 失败诊断：dump AI 面板最后一条 assistant 消息 / Sheet aiNote / toast */
  const dumpCtx = async (tag) => {
    const panel = await cdp.eval(
      `(() => { const els = [...document.querySelectorAll('aside .whitespace-pre-wrap')]; return els.slice(-2).map((e) => e.textContent.slice(0, 120)).join(' | '); })()`,
    );
    const note = await cdp.eval(
      `(() => { const s = [...document.querySelectorAll('span')].map((x) => x.textContent).find((t) => t && (t.includes('失败') || t.includes('已执行') || t.includes('AI 规划'))); return s?.slice(0, 120) ?? ''; })()`,
    );
    console.log(`   [dump:${tag}] panel="${panel}" note="${note}"`);
  };
  const undoLast = async () => {
    const toastBefore = await cdp.eval(`document.body.textContent.length`);
    await cdp.eval(`(() => { const btns = [...document.querySelectorAll('button')].filter((b) => b.textContent.includes('撤销本次')); const b = btns[btns.length - 1]; if (b) b.click(); })()`);
    await sleep(500);
    const toastText = await cdp.eval(
      `(() => { const els = [...document.querySelectorAll('div')].filter((d) => d.className.includes('fixed') && d.className.includes('bottom')); return els.map((e) => e.textContent).join('|').slice(0, 150); })()`,
    );
    void toastBefore;
    if (toastText) console.log(`   [undo-toast] ${toastText}`);
  };

  // 1 insertText
  await sendPanel('插入验收一文本');
  record('W1 insertText', await waitText('验收一文本'));
  await undoLast();
  record('W1 撤销', await waitText('验收一文本', false));
  await sendPanel('插入验收一文本'); // 补现场
  await waitText('验收一文本');

  // 2 insertParagraph heading
  await sendPanel('插入验收二标题');
  record('W2 insertParagraph(h1)', (await waitText('验收二标题')) && (await waitHtml('<h1')));
  // 3 insertParagraph
  await sendPanel('插入验收三段落');
  record('W3 insertParagraph', await waitText('验收三段落内容'));
  // 4 insertTable
  await sendPanel('插入验收四表格');
  record('W4 insertTable', await waitHtml('<table'));
  const tableCount = () => cdp.eval(`(() => { const h = window.__jkWriterDebug?.html?.() ?? ''; return (h.match(/<table/g) || []).length; })()`);
  const beforeUndo = { count: await tableCount(), len: String(await wHtml()).length };
  await undoLast();
  const afterUndo = { count: await tableCount(), len: String(await wHtml()).length };
  // 撤销语义 = 恢复到执行前状态：table 计数应回到执行前（sample 自带 1 个，不能用「无 table」断言）
  const w4undo = afterUndo.count === beforeUndo.count - 1;
  if (!w4undo) await dumpCtx('W4撤销');
  record('W4 撤销', w4undo);
  await sendPanel('插入验收四表格'); // 补现场
  await waitHtml('<table');
  // 5 hr
  await sendPanel('插入验收五分隔线');
  record('W5 insertHorizontalRule', await waitHtml('<hr'));
  // 6 setColor（TipTap 将 #FF0000 规范化输出为 rgb(255, 0, 0)，两种形式都认）
  await sendPanel('插入验收六红字');
  const w6 =
    (await waitText('验收六红字')) &&
    (await waitUntil(async () => /#ff0000|255,\s*0,\s*0/i.test(String(await wHtml()))));
  record('W6 setColor', w6);
  // 7 setFormat bold
  await sendPanel('插入验收七粗体');
  record('W7 setFormat bold', (await waitText('验收七粗体')) && (await waitHtml('<strong')));
  // 8 undo op（铺垫经 AI 插入，确保进入 ProseMirror history）
  await sendPanel('铺垫撤销八文本');
  await waitText('撤销目标八');
  await sendPanel('撤销上一步');
  record('W8 undo op', await waitText('撤销目标八', false));
  // 9 redo op
  await sendPanel('重做');
  record('W9 redo op', await waitText('撤销目标八'));
  // 10 formatNumbers
  await sendPanel('验收十千分符');
  record('W10 formatNumbers', await waitText('1,234,567'));
  await undoLast();
  record('W10 撤销', await waitText('1,234,567', false));

  /* ============ Sheet 10 条 ============ */
  await cdp.eval(`location.reload()`, true).catch(() => {});
  await sleep(2500);
  await cdp.eval(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('表格')); if (b) b.click(); })()`);
  // 等 Univer 就绪
  for (let t = 0; t < 20; t++) {
    const st = await cdp.eval(`(() => { const i = document.querySelector('input[placeholder="AI：如「在D2算B列合计」"]'); return i ? (i.disabled ? 'disabled' : 'ready') : 'no-input'; })()`);
    if (st === 'ready') break;
    await sleep(1000);
  }
  // 等 demo 工作簿真实就绪（快照可取且非空）
  await waitUntil(async () => {
    const s = String(await cdp.eval(`(async () => JSON.stringify(await window.__jkDebug?.snapshot?.() ?? ''))()`, true));
    return s.length > 50;
  }, 15000);
  await sleep(1000);

  const sheetSnapStr = async () => String(await cdp.eval(`(async () => JSON.stringify(await window.__jkDebug?.snapshot?.() ?? ''))()`, true));
  const waitSnap = (needle, expect = true) =>
    waitUntil(async () => (String(await sheetSnapStr()).includes(needle) === expect ? true : false));
  const sheetUndo = async () => {
    await cdp.eval(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('↩ 撤销')); if (b) b.click(); })()`);
    await sleep(1500);
  };
  const runSheet = async (instruction) => {
    await cdp.eval(`window.__jkDebug?.runSheetAi?.(${JSON.stringify(instruction)})`);
    // 等 AI note 出现结果（已执行/失败/（无操作）），留足余量
    await sleep(2500);
  };
  /** 带重试的执行+断言：偶发时序竞态（mock 请求/Univer 应用）重试一次即可恢复 */
  const runSheetAssert = async (name, instruction, needle) => {
    await runSheet(instruction);
    let ok = await waitSnap(needle);
    let note = '';
    if (!ok) {
      const diag = await sheetSnapStr();
      const aiNoteText = await cdp.eval(
        `(() => { const s = [...document.querySelectorAll('span')].map((x) => x.textContent).find((t) => t && (t.includes('失败') || t.includes('✅') || t.includes('AI 规划') || t.includes('跳过') || t.includes('写入'))); return s?.slice(0, 150) ?? '(无note)'; })()`,
      );
      note = `retry (snapLen=${diag.length} aiNote="${aiNoteText}")`;
      if (!ok && needle === '表格验收一') {
        console.log(`   [dump:S1-snap] ${diag.slice(0, 900)}`);
      }
      await runSheet(instruction);
      ok = await waitSnap(needle);
    }
    record(name, ok, ok ? '' : note);
    return ok;
  };
  /** 失败断言（撤销后期望消失）：同样允许重试等待 */
  const runSheetAssertAbsence = async (name, needle) => {
    const ok = await waitSnap(needle, false);
    record(name, ok);
    return ok;
  };

  await runSheetAssert('S1 setValue', '表格验收一写入', '表格验收一');
  await sheetUndo();
  await runSheetAssertAbsence('S1 撤销', '表格验收一');
  await runSheetAssert('S1 现场恢复', '表格验收一写入', '表格验收一'); // 恢复现场（不占名额外）
  results.pop(); // 现场恢复不计入统计
  await runSheetAssert('S2 setValue 数字', '表格验收二写入', ':100');
  await runSheetAssert('S3 setValue 数字', '表格验收三写入', ':200');
  await runSheetAssert('S4 setValues 字符串', '表格验收四矩阵', '"x"');
  await runSheetAssert('S5 setFormula', '表格验收五公式', 'SUM(A2:A3)');
  await runSheetAssert('S6 组合 ops', '表格验收六组合', '合计');
  await runSheetAssert('S7 setValue', '表格验收七写入', '表格验收七');
  await runSheetAssert('S8 setValues 数字', '表格验收八矩阵', ':4');
  await runSheet('表格验收九问答，A2 和 A3 的和是多少');
  record('S9 数据问答', await waitUntil(async () => cdp.eval(`document.body.textContent.includes('A2+A3=300')`)));
  await runSheetAssert('S10 setValue', '表格验收十写入', '表格验收十');

  // 清理配置
  await cdp.eval(
    `window.jareking.invoke('ai:config:list').then((list) =>
      Promise.all(list.filter((c) => c.name === 'T49验收').map((c) => window.jareking.invoke('ai:config:delete', { id: c.id }))))`,
    true,
  );
  mock.close();

  /* ============ 汇总 ============ */
  const passed = results.filter((r) => r.pass).length;
  const rate = Math.round((passed / results.length) * 100);
  const errors = cdp.consoleErrors.filter((e) => !/favicon|GPU|gpu|Autofill|nsresult|PermissionPoint/.test(e));
  console.log(`\n=== T4.9 验收结果：${passed}/${results.length}（${rate}%）===`);
  if (errors.length) console.log('控制台错误:', errors.slice(0, 5));
  console.log(rate >= 90 ? '✅ T4.9 验收通过（≥90%）' : '❌ T4.9 验收未达标');

  try { await cdp.send('Browser.close'); } catch {}
  await sleep(800);
  process.exit(rate >= 90 ? 0 : 1);
}

main().catch((e) => { console.error('验收脚本失败:', e.message); process.exit(2); });
