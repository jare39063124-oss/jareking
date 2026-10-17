/**
 * sharing-merge-scan.mjs —— 云共享「权限求解 / 版本合并」契约级反证基线（QA 严过关）。
 *
 * 依据：`docs/prd-cloud-sharing.md` v0.3（2026-10-17 定稿，Q5=A / policyCap=effective）。
 *
 * 本脚本不依赖产品源码（契约 `packages/core/src/contracts/sharing.ts` 尚未落地），
 * 而是内置一份**契约级参考模型**（reference model）：严格按 PRD §4.4 伪码 +
 * §4.4.1 RoleCaps/ROLE_ORDER/capabilitiesOf/allowSet/allowSetVia + §4.4.2 buildChain 实现，
 * 用来在「工程实现之前」先把 20 条期望值钉死。工程落地后，把 `resolvePermissions` /
 * `buildChain` 换成产品实现，本脚本的全部断言即可直接复用（见文件末尾 ADAPTER 说明）。
 *
 * 用例映射（PRD §4.4 用例表 1–20）：
 *   #1  team Viewer + team Editor             → Editor（union）            [resolve]
 *   #2  direct Viewer + team Editor           → Editor（union）            [resolve]
 *   #3  同主体 grants(Editor) + denies(edit)  → 无 edit（deny 胜）        [resolve]
 *   #4  父 deny download + 子授 Viewer        → 无 download（Q5=A 不可逆）[resolve][P0]
 *   #5  maxRole=commenter + 文件授 Editor     → Commenter（封顶）          [resolve]
 *   #6  linkSharingEnabled=false + via link   → ∅                        [resolve]
 *   #7  非任何授权主体                         → ∅                        [resolve]
 *   #8  via link 授 Editor                    → commenterCaps（裁剪）     [resolve]
 *   #9  根 owner / 子 commenter / 文件 editor → Commenter（祖先上限）     [resolve][P0]
 *   #10 policyCap.denied=[print,export]       → 无 print/export           [resolve][P0]
 *   #11 via member + chain 含 anyone/link     → ∅（门控）                  [resolve]
 *   #12 非法 role/capability/maxRole          → fail-closed               [resolve]
 *   #13 teamIds 含已解散团队                   → 忽略该主体                [resolve]
 *   #14 幂等 + 不 mutate 入参                  → 相等 / 不变               [resolve]
 *   #15 祖 deny download → 子 Editor → 孙 Owner → 始终无 download          [resolve][P0]
 *   #16 环状 parentId                          → 空链（fail-closed）       [buildChain]
 *   #17 detachedFromParent                     → 断 grants，存 denies/cap  [buildChain]
 *   #18 nodesById 缺父节点                      → 链根终止                 [buildChain]
 *   #19 走 linkPolicy 但 via=member            → linkPolicy 不参与         [resolve]
 *   #20 链接密码未通过 passwordOk=false         → ∅（fail-closed）         [resolve]
 *
 * 追加反证（PRD 未逐条列，但属门禁必过）：
 *   X1 缓存键含 via.id → 不同链接不串权（串权探针）
 *   X2 merge「删改冲突绝不静默覆盖」P0 探针（含结构性冲突矩阵）
 *   X3 纯函数：resolvePermissions / buildChain 不 mutate 入参
 *
 * 用法：node scripts/sharing-merge-scan.mjs
 * 退出码：0 = 全绿；2 = 存在 P0/P1 失败（可用于交付门禁）；1 = 脚本自身异常。
 *
 * ⚠️ 契约偏差（参考实现相对 PRD v0.3 的取值，均已在末尾 DEVIATIONS 打印，需 PM 收敛）：
 *   D1 `passwordOk` 语义：PRD 约束④写 `!== true ⇒ ∅`，§4.4.1/用例 8 又要求 undefined 可放行。
 *      本实现取 **`=== false ⇒ ∅`**（满足用例 8/20 与 §4.4.1）；约束④需修正，否则用例 8 被误判 ∅。
 *   D2 `ShareCapability` 类型漏 `transferOwnership`（§4.4.1 表有、§12.2 类型无）→ 本实现补上。
 *   D3 `linkPolicy.role` 与 `grants[{kind:'link'}]` 双事实源：本实现按伪码**只读 grants**。
 *   D4 `linkPolicy.deny` / `expiresAt` 在伪码中未应用：本实现同样不应用（与伪码一致，属"假安全"待补）。
 *   D5 `buildChain` 断链取 **方案 B**（清空断点以上祖先 grants）；契约无 `detachIndex` 返回位。
 *   D6 「已解散团队」无信息来源：参考 `subjectMatches` 增加可选 ctx（`dissolvedTeams`）。
 *   D7 `ShareRole` 无 `'none'`，但 `ROLE_ORDER` 含 none：参考实现用 rank=-1 / 空能力集表达。
 */
import process from 'node:process';

/* =========================================================================
 * 0. 结果收集
 * ========================================================================= */
const RESULTS = [];
let seq = 0;
function record(o) {
  seq += 1;
  RESULTS.push({ id: `S${String(seq).padStart(2, '0')}`, ...o });
}

function runCase(id, name, expected, fn) {
  try {
    const r = fn();
    record({
      id,
      name,
      expected,
      actual: r.actual,
      pass: !!r.ok,
      severity: r.ok ? undefined : (r.severity ?? 'P1'),
      evidence: r.evidence,
    });
  } catch (e) {
    record({
      id,
      name,
      expected,
      actual: `抛出异常：${e && e.message}`,
      pass: false,
      severity: 'P0',
      evidence: (e && e.stack ? e.stack : String(e)).split('\n').slice(0, 3).join(' ⏎ '),
    });
  }
}

/* =========================================================================
 * 1. 契约级参考模型（PRD v0.3 §4.4 / §4.4.1 / §4.4.2）
 * ========================================================================= */

/** 严格度全序（PRD §4.4.1：owner > admin > editor > commenter > viewer > none） */
const ROLE_ORDER = ['none', 'viewer', 'commenter', 'editor', 'admin', 'owner'];

/** 11 项能力（D2：补 PRD 类型里漏掉的 transferOwnership） */
const CAPS = [
  'open', 'download', 'export', 'print', 'comment',
  'edit', 'saveAs', 'delete', 'share', 'viewHistory', 'transferOwnership',
];

/** RoleCaps（PRD §4.4.1），单一事实源 */
const ROLE_CAPS = {
  owner: [...CAPS],
  admin: ['open', 'download', 'export', 'print', 'comment', 'edit', 'saveAs', 'delete', 'share', 'viewHistory'],
  editor: ['open', 'download', 'export', 'print', 'comment', 'edit', 'saveAs', 'viewHistory'],
  commenter: ['open', 'download', 'export', 'print', 'comment', 'viewHistory'],
  viewer: ['open', 'download', 'export', 'print', 'viewHistory'],
  none: [],
};

const roleRank = (role) => ROLE_ORDER.indexOf(role);

/** role → 能力集合；非法 role → ∅（fail-closed） */
function capabilitiesOf(role) {
  const caps = Object.prototype.hasOwnProperty.call(ROLE_CAPS, role) ? ROLE_CAPS[role] : [];
  return new Set(caps);
}

/** 上限角色展开：⋃ capabilitiesOf(r)，对所有 r ≤ maxRole；非法 maxRole → ∅（fail-closed） */
function allowSet(maxRole) {
  if (!Object.prototype.hasOwnProperty.call(ROLE_CAPS, maxRole)) return new Set();
  const limit = roleRank(maxRole);
  const out = new Set();
  for (const r of ROLE_ORDER) {
    if (roleRank(r) <= limit) for (const c of ROLE_CAPS[r]) out.add(c);
  }
  return out;
}

/**
 * 访问通路裁剪（PRD §4.4.1）。
 * D1：本实现取 `passwordOk === false ⇒ ∅`；undefined（无密码链接）放行。
 */
function allowSetVia(via) {
  if (!via || typeof via !== 'object') return new Set();
  if (via.kind === 'member') return new Set(CAPS);
  if (via.kind === 'link') {
    if (via.passwordOk === false) return new Set();
    return capabilitiesOf('commenter');
  }
  return new Set();
}

/**
 * 主体匹配（PRD §4.4.1 注释）。
 * - user：id 相等
 * - team：user.teamIds 含该 id 且未被解散
 * - link：仅 via.kind==='link' 且 id 相等（"具体链接"才授权）
 * - anyone：仅 via.kind==='link'
 * D6：已解散团队无契约字段，参考实现用 ctx.dissolvedTeams 注入。
 */
function subjectMatches(user, via, subject, ctx = {}) {
  if (!subject || typeof subject !== 'object') return false;
  const dissolved = ctx.dissolvedTeams ?? new Set();
  switch (subject.kind) {
    case 'user':
      return subject.id === user.id;
    case 'team':
      return Array.isArray(user.teamIds) && user.teamIds.includes(subject.id) && !dissolved.has(subject.id);
    case 'link':
      return via.kind === 'link' && via.id === subject.id;
    case 'anyone':
      return via.kind === 'link';
    default:
      return false;
  }
}

const intersect = (a, b) => new Set([...a].filter((x) => b.has(x)));
const diff = (a, b) => new Set([...a].filter((x) => !b.has(x)));
const unionInto = (a, b) => { for (const x of b) a.add(x); return a; };

/**
 * 参考实现：effective permission 求解（PRD §4.4，v0.3 结构）。
 *   granted(全链并集) ∩ allowed(全链 maxRole 交集) − denied(全链并集，含 policyCap.denied)
 *   ∩ allowSetVia(via)
 *
 * 关键（P0）：
 *  - policyCap 是 **effective 值**（调用方/buildChain 已按 §2.2 min 过），故循环内逐级求交即正确。
 *  - denied 先累积、最后统一作差 → deny 不可逆（Q5=A）。
 */
function resolvePermissions(user, chain, via, ctx = {}) {
  let granted = new Set();
  const denied = new Set();
  let allowed = new Set(CAPS);

  for (const node of chain ?? []) {
    const cap = node.policyCap ?? {};
    // ④ 链接通路：任一节点关闭链接共享 → 直接 ∅
    if (via.kind === 'link' && cap.linkSharingEnabled === false) return new Set();

    for (const g of node.grants ?? []) {
      if (subjectMatches(user, via, g.subject, ctx)) unionInto(granted, capabilitiesOf(g.role));
    }
    for (const d of node.denies ?? []) {
      if (subjectMatches(user, via, d.subject, ctx) && CAPS.includes(d.capability)) {
        denied.add(d.capability);
      }
    }
    // ② 组织强制禁项（逐级累积）
    for (const c of cap.denied ?? []) if (CAPS.includes(c)) denied.add(c);
    // ① 祖先上限逐级求交
    allowed = intersect(allowed, allowSet(cap.maxRole));
  }

  let caps = intersect(granted, allowed);
  caps = diff(caps, denied);
  caps = intersect(caps, allowSetVia(via));
  return caps;
}

/**
 * 参考实现：buildChain（PRD §4.4.2）。
 *  - 环检测 → 返回 []（fail-closed，不死循环）
 *  - 缺失父节点 → 链根终止
 *  - detachedFromParent → **方案 B**：清空断点以上祖先的 grants；denies/policyCap 保留
 *  - 纯函数：深拷贝，不 mutate 输入
 */
function cloneNode(n) {
  return {
    ...n,
    grants: (n.grants ?? []).map((g) => ({ subject: { ...g.subject }, role: g.role })),
    denies: (n.denies ?? []).map((d) => ({ subject: { ...d.subject }, capability: d.capability })),
    policyCap: {
      ...(n.policyCap ?? {}),
      denied: [...(n.policyCap?.denied ?? [])],
    },
  };
}

function buildChain(nodesById, fileId) {
  const upward = [];
  const seen = new Set();
  let cur = fileId;

  while (cur != null) {
    if (seen.has(cur)) return []; // ④ 环 → fail-closed
    seen.add(cur);
    const node = nodesById.get?.(cur) ?? nodesById[cur];
    if (!node) break; // 缺失节点 → 链根终止
    upward.push(node);
    cur = node.parentId;
    if (upward.length > 10000) return []; // 防御性上限
  }

  const chain = upward.reverse().map(cloneNode); // 根 → 目标

  // 断链：取最靠近目标的（最深）断点
  let detachIndex = -1;
  for (let i = 0; i < chain.length; i++) {
    if (chain[i].detachedFromParent === true) detachIndex = i;
  }
  if (detachIndex > 0) {
    // 清空「断点以上」祖先的 grants；断点节点自身保留
    for (let i = 0; i < detachIndex; i++) chain[i].grants = [];
  }
  return chain;
}

/* -------------------------- 缓存键（X1 串权探针） -------------------------- */

/** PRD §4.4 约定 7：文件id + 用户id + via.kind + via.id + passwordOk + 策略版本号 */
function cacheKey(fileId, userId, via, policyVersion) {
  const linkId = via.kind === 'link' ? via.id : '';
  const pw = via.kind === 'link' ? String(via.passwordOk) : '';
  return `${fileId}|${userId}|${via.kind}|${linkId}|${pw}|${policyVersion}`;
}

/* =========================================================================
 * 2. 参考实现：版本合并冲突分类（PRD §7.5）
 *
 * 输入为"变更集"（base → 侧）：{ unitKey, kind:'add'|'modify'|'delete', value? }
 * 分类口径：
 *   - 不同 unitKey（不同段落/单元格/工作表/页/形状）→ auto
 *   - 同 unitKey 双方都 modify 且值不同 → conflict
 *   - **一方 delete、另一方 modify → conflict（P0：绝不自动）**
 *   - 双方都 delete → auto（结果同为删除）
 *   - 双方都 add 且值不同 → conflict；值相同 → auto（去重）
 *   - 结构性单元（styles/numbering/table-structure/master-theme）双方任改 → conflict
 * 返回 { mode:'auto'|'conflict', merged?: Map, conflicts?: [] }
 * ========================================================================= */

const STRUCTURAL_PREFIX = ['styles', 'numbering', 'table-structure', 'master-theme'];

function isStructural(key) {
  return STRUCTURAL_PREFIX.some((p) => String(key).startsWith(p)) ||
    String(key).startsWith('styles:') || String(key).startsWith('numbering:') ||
    String(key).startsWith('table:') || String(key).startsWith('master:');
}

function toMap(changes) {
  const m = new Map();
  for (const c of changes ?? []) m.set(c.unitKey, c);
  return m;
}

function classifyMerge(base, mineChanges, theirsChanges) {
  const mine = toMap(mineChanges);
  const theirs = toMap(theirsChanges);
  const keys = new Set([...mine.keys(), ...theirs.keys()]);
  const conflicts = [];
  const merged = new Map(base instanceof Map ? base : new Map());

  for (const key of keys) {
    const m = mine.get(key);
    const t = theirs.get(key);
    const structural = isStructural(key);

    if (structural && m && t) {
      conflicts.push({ key, reason: 'structural-both-changed' });
      continue;
    }
    if (!m && t) { merged.set(key, t.value); continue; }
    if (m && !t) { merged.set(key, m.value); continue; }

    // 双方都命中
    if (m.kind === 'delete' && t.kind === 'delete') { merged.delete(key); continue; }
    if (m.kind === 'delete' || t.kind === 'delete') {
      // ★ P0：删改冲突 → 必须人工，绝不自动
      conflicts.push({ key, reason: 'delete-vs-modify' });
      continue;
    }
    if (m.kind === 'add' && t.kind === 'add') {
      if (m.value !== t.value) { conflicts.push({ key, reason: 'add-vs-add-different' }); }
      else { merged.set(key, m.value); }
      continue;
    }
    // 双方 modify
    if (m.value !== t.value) { conflicts.push({ key, reason: 'modify-vs-modify' }); }
    else { merged.set(key, m.value); }
  }

  if (conflicts.length) {
    // P0 不变式：冲突态绝不产出 merged 结果（防静默覆盖）
    return { mode: 'conflict', conflicts, merged: undefined };
  }
  return { mode: 'auto', merged, conflicts: [] };
}

/* =========================================================================
 * 3. 构造工具
 * ========================================================================= */

const ALL = new Set(CAPS);
const eqSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const setToArr = (s) => [...s].sort();

const node = (id, parentId, opts = {}) => ({
  id,
  parentId,
  grants: opts.grants ?? [],
  denies: opts.denies ?? [],
  policyCap: {
    maxRole: opts.maxRole ?? 'owner',
    denied: opts.denied ?? [],
    linkSharingEnabled: opts.linkSharingEnabled ?? true,
  },
  detachedFromParent: opts.detachedFromParent,
  linkPolicy: opts.linkPolicy,
});

const grant = (subject, role) => ({ subject, role });
const deny = (subject, capability) => ({ subject, capability });
const U = (id) => ({ kind: 'user', id });
const T = (id) => ({ kind: 'team', id });
const L = (id) => ({ kind: 'link', id });
const ANYONE = { kind: 'anyone' };
const MEMBER = { kind: 'member' };
const linkVia = (id, passwordOk) => (passwordOk === undefined ? { kind: 'link', id } : { kind: 'link', id, passwordOk });

/* =========================================================================
 * 4. 用例 1–20
 * ========================================================================= */

function runCases() {
  const user = (id = 'u1', teamIds = []) => ({ id, teamIds });
  const setUser = user('u1', ['t-view', 't-edit']);

  // #1 team Viewer + team Editor → Editor
  runCase('#1', 'team Viewer + team Editor → Editor（union）', 'result === capabilitiesOf(editor)', () => {
    const chain = [
      node('root', null),
      node('f', 'root', { grants: [grant(T('t-view'), 'viewer'), grant(T('t-edit'), 'editor')] }),
    ];
    const r = resolvePermissions(setUser, chain, MEMBER);
    const want = capabilitiesOf('editor');
    return { ok: eqSet(r, want), actual: `result=${setToArr(r).join(',')}`, severity: 'P0' };
  });

  // #2 direct Viewer + team Editor → Editor
  runCase('#2', 'direct Viewer + team Editor → Editor（union）', 'result === capabilitiesOf(editor)', () => {
    const chain = [node('root', null), node('f', 'root', { grants: [grant(U('u1'), 'viewer'), grant(T('t-edit'), 'editor')] })];
    const r = resolvePermissions(setUser, chain, MEMBER);
    return { ok: eqSet(r, capabilitiesOf('editor')), actual: `result=${setToArr(r).join(',')}`, severity: 'P0' };
  });

  // #3 同主体 grants(Editor) + denies(edit) → 无 edit
  runCase('#3', '同主体 grants(Editor) + denies(edit) → 无 edit（deny 胜）', 'result 不含 edit', () => {
    const chain = [node('root', null), node('f', 'root', { grants: [grant(U('u1'), 'editor')], denies: [deny(U('u1'), 'edit')] })];
    const r = resolvePermissions(setUser, chain, MEMBER);
    const ok = !r.has('edit') && r.has('open') && r.has('saveAs');
    return { ok, actual: `result=${setToArr(r).join(',')} 含 edit=${r.has('edit')}`, severity: 'P0' };
  });

  // #4 ★ 父 deny download + 子授 Viewer → 无 download（Q5=A）
  runCase('#4', '★ 父 deny download + 子授 Viewer → 无 download（Q5=A 不可逆）', 'download 不在；open/print/export 在', () => {
    const chain = [
      node('root', null, { denies: [deny(U('u1'), 'download')] }),
      node('f', 'root', { grants: [grant(U('u1'), 'viewer')] }),
    ];
    const r = resolvePermissions(setUser, chain, MEMBER);
    const ok = !r.has('download') && r.has('open') && r.has('print') && r.has('export');
    return { ok, actual: `含 download=${r.has('download')} result=${setToArr(r).join(',')}`, severity: 'P0', evidence: 'deny 被后续 grant 回弹即为越权' };
  });

  // #5 maxRole=commenter + 文件授 Editor → Commenter
  runCase('#5', 'maxRole=commenter + 文件授 Editor → Commenter（封顶）', 'result === capabilitiesOf(commenter)', () => {
    const chain = [node('root', null, { maxRole: 'commenter' }), node('f', 'root', { grants: [grant(U('u1'), 'editor')] })];
    const r = resolvePermissions(setUser, chain, MEMBER);
    return { ok: eqSet(r, capabilitiesOf('commenter')), actual: `result=${setToArr(r).join(',')}`, severity: 'P0' };
  });

  // #6 linkSharingEnabled=false + via link → ∅  （注：成员 via 不受影响）
  runCase('#6', 'linkSharingEnabled=false + via link → ∅', '空集；同条件 via member 仍可得授权', () => {
    const chain = [
      node('root', null, { linkSharingEnabled: false }),
      node('f', 'root', { grants: [grant(ANYONE, 'viewer'), grant(U('u1'), 'viewer')] }),
    ];
    const rLink = resolvePermissions(setUser, chain, linkVia('lk1'));
    const rMember = resolvePermissions(setUser, chain, MEMBER);
    const ok = rLink.size === 0 && rMember.size > 0;
    return { ok, actual: `link=${rLink.size} member=${rMember.size}`, severity: 'P0' };
  });

  // #7 非任何授权主体 → ∅
  runCase('#7', '非任何授权主体 → ∅', '空集', () => {
    const chain = [node('root', null), node('f', 'root', { grants: [grant(U('other'), 'owner')] })];
    const r = resolvePermissions(setUser, chain, MEMBER);
    return { ok: r.size === 0, actual: `size=${r.size}`, severity: 'P0' };
  });

  // #8 via link 授 Editor → commenterCaps
  runCase('#8', 'via link 授 Editor → commenterCaps（裁剪）', 'result === capabilitiesOf(commenter)', () => {
    const chain = [node('root', null), node('f', 'root', { grants: [grant(L('lk1'), 'editor')] })];
    const r = resolvePermissions(setUser, chain, linkVia('lk1'));
    return { ok: eqSet(r, capabilitiesOf('commenter')), actual: `result=${setToArr(r).join(',')}`, severity: 'P0' };
  });

  // #9 ★ 根 owner / 子 commenter / 文件 editor → Commenter（祖先上限不可突破）
  runCase('#9', '★ 祖先多层上限：root owner / child commenter / file editor → Commenter', 'result === capabilitiesOf(commenter)（不论文件节点 maxRole 多宽）', () => {
    const chain = [
      node('root', null, { maxRole: 'owner' }),
      node('child', 'root', { maxRole: 'commenter' }),
      node('f', 'child', { maxRole: 'owner', grants: [grant(U('u1'), 'editor')] }),
    ];
    const r = resolvePermissions(setUser, chain, MEMBER);
    return { ok: eqSet(r, capabilitiesOf('commenter')), actual: `result=${setToArr(r).join(',')}`, severity: 'P0', evidence: '更深层 grant 不得回弹突破祖先上限' };
  });

  // #10 ★ 组织 policyCap.denied=[print,export] + 文件 editor → 无 print/export
  runCase('#10', '★ policyCap.denied=[print,export] + 文件授 editor → 无 print/export', 'print/export 不在；edit 仍在（未被误删）', () => {
    const chain = [
      node('root', null, { denied: ['print', 'export'] }),
      node('f', 'root', { grants: [grant(U('u1'), 'editor')] }),
    ];
    const r = resolvePermissions(setUser, chain, MEMBER);
    const ok = !r.has('print') && !r.has('export') && r.has('edit');
    return { ok, actual: `print=${r.has('print')} export=${r.has('export')} edit=${r.has('edit')}`, severity: 'P0', evidence: '组织强制禁项被后续 grant 回弹即为越权' };
  });

  // #11 via member + chain 含 anyone / link → ∅（门控）
  runCase('#11', 'via member + chain 含 anyone/link 授权 → ∅（门控）', '空集', () => {
    const chain = [node('root', null), node('f', 'root', { grants: [grant(ANYONE, 'editor'), grant(L('lk1'), 'editor')] })];
    const r = resolvePermissions(setUser, chain, MEMBER);
    return { ok: r.size === 0, actual: `size=${r.size}`, severity: 'P0' };
  });

  // #12 非法 role / capability / maxRole → fail-closed
  runCase('#12', '非法 role / capability / maxRole → fail-closed', '不抛异常；非法 maxRole ⇒ ∅；非法 grant/cap 被忽略', () => {
    const chain = [
      node('root', null, { maxRole: 'superuser' }), // 非法 maxRole
      node('f', 'root', { grants: [grant(U('u1'), 'wizard'), grant(U('u1'), 'viewer')], denies: [deny(U('u1'), 'nuke')] }),
    ];
    const r = resolvePermissions(setUser, chain, MEMBER);
    const ok = r.size === 0; // 非法 maxRole → allowSet ∅ → 整体 ∅
    return { ok, actual: `size=${r.size}`, severity: 'P0', evidence: '非法 maxRole 必须整体收敛为 ∅（fail-closed）' };
  });

  // #12b 仅非法 grant.role（maxRole 合法）→ 忽略该条，不授予
  runCase('#12b', '仅非法 grant.role（maxRole 合法）→ 忽略该条', 'size=0（不得因非法 role 默认放行）', () => {
    const chain = [node('root', null, { maxRole: 'owner' }), node('f', 'root', { grants: [grant(U('u1'), 'wizard')] })];
    const r = resolvePermissions(setUser, chain, MEMBER);
    return { ok: r.size === 0, actual: `size=${r.size}`, severity: 'P0' };
  });

  // #13 teamIds 含已解散团队 → 忽略
  runCase('#13', 'teamIds 含已解散团队 → 该主体忽略', '解散团队授权不生效；正常团队授权生效', () => {
    const u = { id: 'u1', teamIds: ['t-dead', 't-live'] };
    const chain = [node('root', null), node('f', 'root', { grants: [grant(T('t-dead'), 'owner'), grant(T('t-live'), 'viewer')] })];
    const r = resolvePermissions(u, chain, MEMBER, { dissolvedTeams: new Set(['t-dead']) });
    const ok = !r.has('edit') && r.has('open') && r.size === capabilitiesOf('viewer').size;
    return { ok, actual: `result=${setToArr(r).join(',')}`, severity: 'P0', evidence: '解散团队必须视为空主体（不放行）' };
  });

  // #14 幂等 + 纯度
  runCase('#14', '幂等 + 不 mutate 入参', '两次结果相等；入参深比较不变', () => {
    const chain = [
      node('root', null, { denies: [deny(U('u1'), 'download')] }),
      node('f', 'root', { grants: [grant(U('u1'), 'editor')] }),
    ];
    const snapshot = JSON.stringify(chain);
    const r1 = resolvePermissions(setUser, chain, MEMBER);
    const r2 = resolvePermissions(setUser, chain, MEMBER);
    const ok = eqSet(r1, r2) && JSON.stringify(chain) === snapshot;
    return { ok, actual: `相等=${eqSet(r1, r2)} 入参未变=${JSON.stringify(chain) === snapshot}`, severity: 'P0' };
  });

  // #15 ★ 跨层不可逆：祖 deny download → 子 Editor → 孙 Owner
  runCase('#15', '★ 不可逆回归：祖 deny download → 子 Editor → 孙 Owner，download 始终不在', 'download 不在结果中', () => {
    const chain = [
      node('root', null, { denies: [deny(U('u1'), 'download')] }),
      node('mid', 'root', { grants: [grant(U('u1'), 'editor')] }),
      node('leaf', 'mid', { grants: [grant(U('u1'), 'owner')] }),
    ];
    const r = resolvePermissions(setUser, chain, MEMBER);
    const ok = !r.has('download') && r.has('edit') && r.has('transferOwnership');
    return { ok, actual: `含 download=${r.has('download')} 含 transferOwnership=${r.has('transferOwnership')}`, severity: 'P0', evidence: '"逐级先并集再差集"的实现会让 download 回弹 → 此用例即为该回潮的防线' };
  });

  // #16 环状 parentId → 空链
  runCase('#16', '环状 parentId → 空链（fail-closed，不死循环）', 'buildChain 返回 []', () => {
    const map = new Map([
      ['a', node('a', 'c')],
      ['b', node('b', 'a')],
      ['c', node('c', 'b')],
    ]);
    const t0 = Date.now();
    const chain = buildChain(map, 'a');
    const ok = Array.isArray(chain) && chain.length === 0 && Date.now() - t0 < 1000;
    return { ok, actual: `len=${chain.length} 耗时=${Date.now() - t0}ms`, severity: 'P0' };
  });

  // #17 detachedFromParent → 只断 grants，denies/policyCap 仍生效
  runCase('#17', '断链：祖先 grants 不入链；祖先 denies 与 policyCap 仍生效', '祖先节点 grants=[]、denies 非空、policyCap.maxRole 保留；断点节点自身 grants 保留', () => {
    const map = new Map([
      ['root', node('root', null, { maxRole: 'commenter', denies: [deny(U('u1'), 'download')], grants: [grant(U('u1'), 'owner')] })],
      ['mid', node('mid', 'root', { detachedFromParent: true, grants: [grant(U('u1'), 'editor')] })],
      ['f', node('f', 'mid', { grants: [grant(U('u1'), 'editor')] })],
    ]);
    const chain = buildChain(map, 'f');
    const root = chain.find((n) => n.id === 'root');
    const mid = chain.find((n) => n.id === 'mid');
    const structureOk =
      chain.length === 3 &&
      root && root.grants.length === 0 && root.denies.length > 0 && root.policyCap.maxRole === 'commenter' &&
      mid && mid.grants.length === 1;
    const r = resolvePermissions(setUser, chain, MEMBER);
    // 断链后：mid/f 的 editor 授权仍在，但 root 的 maxRole=commenter 仍封顶；
    // root 的 deny download 仍生效 → 期望 = commenterCaps − {download}（5 项）
    const semanticsOk =
      !r.has('download') &&
      !r.has('edit') &&
      r.has('open') && r.has('comment') &&
      r.size === 5;
    return {
      ok: !!structureOk && semanticsOk,
      actual: `len=${chain.length} root.grants=${root?.grants.length} root.denies=${root?.denies.length} root.maxRole=${root?.policyCap.maxRole} mid.grants=${mid?.grants.length} resolve=${setToArr(r).join(',')}`,
      severity: 'P0',
      evidence: '断链若连 denies/policyCap 一起丢 → detach 即可绕过组织强制禁令（越权）',
    };
  });

  // #18 缺失父节点 → 链根终止
  runCase('#18', 'nodesById 缺失父节点 → 链根终止', '返回链以缺失处为根，不报错', () => {
    const map = new Map([['f', node('f', 'ghost')]]);
    const chain = buildChain(map, 'f');
    return { ok: chain.length === 1 && chain[0].id === 'f', actual: `len=${chain.length} ids=${chain.map((n) => n.id).join(',')}`, severity: 'P0' };
  });

  // #18b 缺失目标节点
  runCase('#18b', 'nodesById 缺失目标节点 → []', '空链', () => {
    const chain = buildChain(new Map(), 'nope');
    return { ok: chain.length === 0, actual: `len=${chain.length}`, severity: 'P0' };
  });

  // #19 走 linkPolicy 但 via member → linkPolicy 不参与
  runCase('#19', 'linkPolicy 存在但 via=member → linkPolicy 不参与', '空集（成员不能因链接配置获权）', () => {
    const chain = [
      node('root', null),
      node('f', 'root', { linkPolicy: { scope: 'anyone', role: 'editor', deny: [], password: 'x' } }),
    ];
    const r = resolvePermissions(setUser, chain, MEMBER);
    return { ok: r.size === 0, actual: `size=${r.size}`, severity: 'P0' };
  });

  // #20 链接密码未通过 → ∅
  runCase('#20', '链接密码未通过（passwordOk=false）→ ∅', '空集', () => {
    const chain = [node('root', null), node('f', 'root', { grants: [grant(L('lk1'), 'editor')] })];
    const r = resolvePermissions(setUser, chain, linkVia('lk1', false));
    return { ok: r.size === 0, actual: `size=${r.size}`, severity: 'P0' };
  });

  // #20b 密码通过 → 正常按 commenter 裁剪
  runCase('#20b', '链接密码通过（passwordOk=true）→ commenterCaps', 'result === capabilitiesOf(commenter)', () => {
    const chain = [node('root', null), node('f', 'root', { grants: [grant(L('lk1'), 'editor')] })];
    const r = resolvePermissions(setUser, chain, linkVia('lk1', true));
    return { ok: eqSet(r, capabilitiesOf('commenter')), actual: `result=${setToArr(r).join(',')}`, severity: 'P0' };
  });
}

/* =========================================================================
 * 5. 追加反证：缓存串权 / 合并 P0 / 纯函数
 * ========================================================================= */

function runExtras() {
  // X1 缓存键含 via.id：不同链接不得串权
  runCase('X1', '缓存键含 via.id → 不同链接不串权', '两条链接 key 不同；解析结果分别正确', () => {
    const u = { id: 'u1', teamIds: [] };
    const chainA = [node('root', null), node('f', 'root', { grants: [grant(L('lkA'), 'editor')] })];
    const chainB = [node('root', null), node('f', 'root', { grants: [grant(L('lkB'), 'viewer')] })];
    const viaA = linkVia('lkA');
    const viaB = linkVia('lkB');
    const kA = cacheKey('f', 'u1', viaA, 1);
    const kB = cacheKey('f', 'u1', viaB, 1);
    const rA = resolvePermissions(u, chainA, viaA);
    const rB = resolvePermissions(u, chainB, viaB);
    const ok = kA !== kB && eqSet(rA, capabilitiesOf('commenter')) && eqSet(rB, capabilitiesOf('viewer'));
    return {
      ok,
      actual: `kA===kB? ${kA === kB} | rA=${setToArr(rA).join(',')} | rB=${setToArr(rB).join(',')}`,
      severity: 'P0',
      evidence: '键缺 via.id 会把 A 链接结果串给 B 链接（缓存串权）',
    };
  });

  // X2 merge：删改冲突绝不静默覆盖（P0）
  runCase('X2', '★ merge：删改冲突绝不静默覆盖（P0）', 'mode=conflict 且 merged===undefined', () => {
    const res = classifyMerge(new Map(), [{ unitKey: 'p:4', kind: 'delete' }], [{ unitKey: 'p:4', kind: 'modify', value: '对方的修改' }]);
    const ok = res.mode === 'conflict' && res.merged === undefined && res.conflicts.some((c) => c.reason === 'delete-vs-modify');
    return {
      ok,
      actual: `mode=${res.mode} merged=${res.merged === undefined ? 'undefined' : '有'} conflicts=${res.conflicts.map((c) => c.reason).join(',')}`,
      severity: 'P0',
      evidence: '删改冲突若返回 auto/merged，即为「静默覆盖」P0 事故',
    };
  });

  // X2b 自动合并正例：不同段落 → auto 且两边都在
  runCase('X2b', 'merge 自动正例：不同段落 → auto 且两边内容都在', 'mode=auto；merged 含 mine 与 theirs 的改动', () => {
    const res = classifyMerge(
      new Map([['p:1', 'base1'], ['p:2', 'base2']]),
      [{ unitKey: 'p:1', kind: 'modify', value: '我的修改' }],
      [{ unitKey: 'p:2', kind: 'modify', value: '对方修改' }],
    );
    const ok = res.mode === 'auto' && res.merged.get('p:1') === '我的修改' && res.merged.get('p:2') === '对方修改';
    return { ok, actual: `mode=${res.mode} p1=${res.merged?.get('p:1')} p2=${res.merged?.get('p:2')}`, severity: 'P0' };
  });

  // X2c 同段落双向修改 → conflict
  runCase('X2c', 'merge：同段落双向修改 → conflict', 'mode=conflict', () => {
    const res = classifyMerge(new Map(), [{ unitKey: 'p:1', kind: 'modify', value: 'A' }], [{ unitKey: 'p:1', kind: 'modify', value: 'B' }]);
    return { ok: res.mode === 'conflict' && res.merged === undefined, actual: `mode=${res.mode}`, severity: 'P0' };
  });

  // X2d 结构性冲突矩阵：styles/numbering/table 结构/母版主题
  runCase('X2d', 'merge：样式/编号/表格结构/母版主题 双向改 → 全部 conflict', '四类结构性单元均不得自动合并', () => {
    const pairs = [
      ['styles:paragraph', 'styles:paragraph'],
      ['numbering:1', 'numbering:1'],
      ['table:cols', 'table:cols'],
      ['master:theme', 'master:theme'],
    ];
    const bad = [];
    for (const [k1, k2] of pairs) {
      const res = classifyMerge(new Map(), [{ unitKey: k1, kind: 'modify', value: 'A' }], [{ unitKey: k2, kind: 'modify', value: 'B' }]);
      if (res.mode !== 'conflict' || res.merged !== undefined) bad.push(k1);
    }
    return { ok: bad.length === 0, actual: bad.length ? `未判冲突：${bad.join(',')}` : '四类均 conflict', severity: 'P0' };
  });

  // X2e 双方同删 → auto，不报冲突（防过度保守）
  runCase('X2e', 'merge：双方同删 → auto（不误报冲突）', 'mode=auto 且 merged 不含该键', () => {
    const res = classifyMerge(new Map([['p:9', 'x']]), [{ unitKey: 'p:9', kind: 'delete' }], [{ unitKey: 'p:9', kind: 'delete' }]);
    const ok = res.mode === 'auto' && !res.merged.has('p:9');
    return { ok, actual: `mode=${res.mode} has=${res.merged?.has('p:9')}`, severity: 'P1' };
  });

  // X2f 双方 add 不同内容 → conflict
  runCase('X2f', 'merge：双方 add 同键不同内容 → conflict', 'mode=conflict', () => {
    const res = classifyMerge(new Map(), [{ unitKey: 'cell:B2', kind: 'add', value: 1 }], [{ unitKey: 'cell:B2', kind: 'add', value: 2 }]);
    return { ok: res.mode === 'conflict', actual: `mode=${res.mode}`, severity: 'P1' };
  });

  // X3 buildChain 纯度：不 mutate 输入
  runCase('X3', 'buildChain 纯度：不 mutate nodesById', '返回后原节点 grants/denies 不变', () => {
    const n1 = node('root', null, { grants: [grant(U('u1'), 'owner')], denies: [deny(U('u1'), 'download')] });
    const n2 = node('f', 'root', { detachedFromParent: true, grants: [grant(U('u1'), 'editor')] });
    const map = new Map([['root', n1], ['f', n2]]);
    const snap = JSON.stringify([n1, n2]);
    buildChain(map, 'f');
    return { ok: JSON.stringify([n1, n2]) === snap, actual: `入参未变=${JSON.stringify([n1, n2]) === snap}`, severity: 'P0' };
  });

  // X4 allowSet 单调性守卫（防未来 RoleCaps 漂移让档位语义静默变化）
  runCase('X4', 'RoleCaps 单调性守卫（∀ 高角色 ⊇ 低角色）', '严格单调，无逆序能力', () => {
    const bad = [];
    for (let i = 1; i < ROLE_ORDER.length; i++) {
      const lower = capabilitiesOf(ROLE_ORDER[i - 1]);
      const higher = capabilitiesOf(ROLE_ORDER[i]);
      for (const c of lower) if (!higher.has(c)) bad.push(`${ROLE_ORDER[i]} 缺 ${c}`);
    }
    return { ok: bad.length === 0, actual: bad.length ? bad.join('; ') : '严格单调', severity: 'P1' };
  });
}

/* =========================================================================
 * 5b. 突变控制（mutation control）—— 证明断言"有牙齿"而非空转
 *
 * 若把算法换成 **v0.2 的逐级写法**（每节点：并集 grants → 减 denies → 截断 cap），
 * 用例 4/9/10/15 必须**失败**。若突变体也能通过，说明断言形同虚设（测试自身 P0）。
 * ========================================================================= */

/** 故意写坏的 v0.2 风格实现：逐级先并集再差集（会允许更深层 grant 回弹） */
function resolveV02Mutant(user, chain, via, ctx = {}) {
  let caps = new Set();
  for (const n of chain ?? []) {
    for (const g of n.grants ?? []) if (subjectMatches(user, via, g.subject, ctx)) unionInto(caps, capabilitiesOf(g.role));
    for (const d of n.denies ?? []) if (subjectMatches(user, via, d.subject, ctx) && CAPS.includes(d.capability)) caps.delete(d.capability);
    caps = intersect(caps, allowSet(n.policyCap?.maxRole));   // 在循环内截断（v0.2 的做法）
    for (const c of n.policyCap?.denied ?? []) caps.delete(c);
  }
  return intersect(caps, allowSetVia(via));
}

/** 故意写坏的合并分类：把「删改冲突」当自动保留修改（静默覆盖） */
function classifyMergeBuggy(mineChanges, theirsChanges) {
  const mine = toMap(mineChanges);
  const theirs = toMap(theirsChanges);
  const merged = new Map();
  for (const key of new Set([...mine.keys(), ...theirs.keys()])) {
    const m = mine.get(key);
    const t = theirs.get(key);
    if (!m) { merged.set(key, t.value); continue; }
    if (!t) { merged.set(key, m.value); continue; }
    if (m.kind === 'delete' && t.kind === 'delete') { merged.delete(key); continue; }
    // ★ 缺陷：删改冲突时静默采用修改方（覆盖删除）
    if (m.kind === 'delete') { merged.set(key, t.value); continue; }
    if (t.kind === 'delete') { merged.set(key, m.value); continue; }
    merged.set(key, m.value); // 双向修改也静默取 mine
  }
  return { mode: 'auto', conflicts: [], merged };
}

function runMutationControl() {
  const u = { id: 'u1', teamIds: [] };

  runCase('MUT1', '突变控制：v0.2 逐级写法必须被用例 4/9/10/15 抓住', '四个 P0 用例在突变体上全部失败', () => {
    // 4：父 deny download + 子 viewer
    const c4 = [
      node('root', null, { denies: [deny(U('u1'), 'download')] }),
      node('f', 'root', { grants: [grant(U('u1'), 'viewer')] }),
    ];
    const m4 = resolveV02Mutant(u, c4, MEMBER);
    const c4Caught = m4.has('download'); // 突变体把 download 回弹 → 用例 4 失败

    // 9：root owner / child commenter / file editor
    const c9 = [
      node('root', null, { maxRole: 'owner' }),
      node('child', 'root', { maxRole: 'commenter' }),
      node('f', 'child', { maxRole: 'owner', grants: [grant(U('u1'), 'editor')] }),
    ];
    const m9 = resolveV02Mutant(u, c9, MEMBER);
    const c9Caught = !eqSet(m9, capabilitiesOf('commenter'));

    // 10：org denied print/export + file editor
    const c10 = [
      node('root', null, { denied: ['print', 'export'] }),
      node('f', 'root', { grants: [grant(U('u1'), 'editor')] }),
    ];
    const m10 = resolveV02Mutant(u, c10, MEMBER);
    const c10Caught = m10.has('print') || m10.has('export');

    // 15：祖 deny download → 子 editor → 孙 owner
    const c15 = [
      node('root', null, { denies: [deny(U('u1'), 'download')] }),
      node('mid', 'root', { grants: [grant(U('u1'), 'editor')] }),
      node('leaf', 'mid', { grants: [grant(U('u1'), 'owner')] }),
    ];
    const m15 = resolveV02Mutant(u, c15, MEMBER);
    const c15Caught = m15.has('download');

    const all = [c4Caught, c9Caught, c10Caught, c15Caught];
    return {
      ok: all.every(Boolean),
      actual: `突变体被抓：用例4=${c4Caught} 用例9=${c9Caught} 用例10=${c10Caught} 用例15=${c15Caught}`,
      severity: 'P0',
      evidence: '任一为 false ⇒ 对应断言无法区分正确/错误实现（空转）',
    };
  });

  runCase('MUT2', '突变控制：静默覆盖的合并实现必须被 X2 抓住', 'X2 断言在"删改冲突→自动覆盖"突变体上必须失败', () => {
    const buggy = classifyMergeBuggy([{ unitKey: 'p:4', kind: 'delete' }], [{ unitKey: 'p:4', kind: 'modify', value: '对方修改' }]);
    const x2Catch = buggy.mode === 'conflict' && buggy.merged === undefined; // 对突变体应为 false
    const silentlyOverwrote = buggy.mode === 'auto' && buggy.merged !== undefined && buggy.merged.get('p:4') === '对方修改';
    return {
      ok: !x2Catch && silentlyOverwrote,
      actual: `突变体 mode=${buggy.mode} 静默覆盖=${silentlyOverwrote} X2能抓住=${x2Catch}`,
      severity: 'P0',
      evidence: '若 X2 对"删改冲突自动覆盖"仍判通过，则 P0 探针失效',
    };
  });
}

/* =========================================================================
 * 6. 契约偏差（参考实现相对 PRD v0.3 的取值）
 * ========================================================================= */

const DEVIATIONS = [
  ['D1', 'passwordOk 语义冲突', 'PRD 约束④写 `!== true ⇒ ∅`；§4.4.1 与用例 8 要求 undefined 放行。参考实现取 `=== false ⇒ ∅`。', '约束④ 需改为 `=== false`，或把 passwordOk 改必需 boolean（无密码链接填 true）。否则用例 8 会被误判 ∅。'],
  ['D2', 'ShareCapability 类型漏 transferOwnership', '§4.4.1 表 11 项，§12.2 类型仅 10 项。参考实现补上该能力。', '契约类型必须补 `transferOwnership`，否则 typecheck 必红。'],
  ['D3', 'linkPolicy.role 与 grants[{kind:link}] 双事实源', '参考实现按 §4.4 伪码只读 grants，不读 linkPolicy.role。', '钉死单一来源：建议 linkPolicy.role 为准，并在算法中补 `granted |= capabilitiesOf(linkPolicy.role)`。'],
  ['D4', 'linkPolicy.deny / expiresAt 未应用', '伪码与参考实现均未应用（与 PRD 一致）。', '若 v2 不做则从契约移除；要做则 `denied |= linkPolicy.deny` + 过期 ⇒ ∅。'],
  ['D5', 'buildChain 方案 A 无返回位', '参考实现取方案 B（清空断点以上祖先 grants）；契约签名 `ShareNode[]` 无处放 detachIndex。', '在契约注释写死选 B（推荐）或把返回改为 `{chain, detachIndex?}`。'],
  ['D6', '已解散团队无信息来源', '参考 `subjectMatches` 增加可选 ctx.dissolvedTeams。', '契约需补：user.activeTeamIds 或 ctx.dissolvedTeams。'],
  ['D7', 'ShareRole 无 none 但 ROLE_ORDER 含 none', '参考实现用 rank=-1 / 空能力集表达。', "统一：要么 ShareRole 加 'none'，要么删除 ROLE_ORDER 里的 none。"],
];

/* =========================================================================
 * 7. 输出
 * ========================================================================= */

function main() {
  runCases();
  runExtras();
  runMutationControl();

  const pass = RESULTS.filter((r) => r.pass).length;
  const fail = RESULTS.length - pass;
  const p0 = RESULTS.filter((r) => !r.pass && r.severity === 'P0').length;
  const p1 = RESULTS.filter((r) => !r.pass && r.severity === 'P1').length;

  console.log('=== 云共享权限/合并 契约级反证基线（PRD v0.3）===');
  console.log(`环境：${process.platform} / Node ${process.version}`);
  console.log('参考模型：内置（scripts/sharing-merge-scan.mjs），非产品源码\n');

  for (const r of RESULTS) {
    const badge = r.pass ? '✅' : `❌ ${r.severity}`;
    console.log(`${badge} ${r.id} ${r.name}`);
    if (!r.pass) {
      console.log(`    期望：${r.expected}`);
      console.log(`    实际：${r.actual}`);
      if (r.evidence) console.log(`    证据：${r.evidence}`);
    }
  }

  console.log(`\n小计：共 ${RESULTS.length} 项 —— ✅ ${pass} / ❌ ${fail}（P0=${p0}，P1=${p1}）`);

  console.log('\n--- 契约偏差（参考实现 ←→ PRD v0.3，需产品收敛）---');
  for (const [id, title, impl, need] of DEVIATIONS) {
    console.log(`[${id}] ${title}`);
    console.log(`    参考实现：${impl}`);
    console.log(`    需契约：${need}`);
  }

  console.log('\n--- ADAPTER（工程落地后如何复用）---');
  console.log('1) 把本文件 `resolvePermissions` / `buildChain` / `subjectMatches` 的 import 换成');
  console.log('   `../packages/core/dist/contracts/sharing.js`（或 src 直连）；');
  console.log('2) 删除本文件的参考实现段（§1），其余断言与构造工具原样保留；');
  console.log('3) 用例 1–20 的期望值无需改动；X1–X4 为门禁追加项。');

  console.log(fail === 0 ? '\n✅ 基线全绿（契约可实现且无越权）' : `\n❌ 基线失败（P0=${p0}，P1=${p1}）`);
  process.exit(fail === 0 ? 0 : 2);
}

main();
