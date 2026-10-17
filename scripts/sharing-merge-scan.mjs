/**
 * sharing-merge-scan.mjs —— 云共享「权限求解 / 版本合并」契约级反证基线（QA 严过关）。
 *
 * 依据：`docs/prd-cloud-sharing.md` **v0.4（2026-10-17 契约定稿，924 行）**。
 * 本版按 v0.4 的 **D1–D7** 定稿口径重写参考模型，并把用例表扩到 **29 条**。
 *
 * 本脚本不依赖产品源码（契约 `packages/core/src/contracts/sharing.ts` 尚未落地），
 * 而是内置一份**契约级参考模型**（reference model）：严格按 PRD §4.4 伪码 +
 * §4.4.1 RoleCaps/ROLE_ORDER/capabilitiesOf/allowSet/allowSetVia + §4.4.2 buildChain 实现，
 * 用来在「工程实现之前」把期望值钉死。工程落地后，把 `resolvePermissions` /
 * `buildChain` / `resolveAccess` 换成产品实现，本脚本的全部断言即可直接复用（见 ADAPTER）。
 *
 * ─── v0.4 对齐点（D1–D7）─────────────────────────────────────────────────
 *   D1 `passwordOk` **必需 boolean**，全文统一 `!== true ⇒ ∅`（不用 `!== false 放行`）。
 *   D2 `ShareCapability` 补为 **11 项**（含 transferOwnership）。
 *   D3 **删除 `linkPolicy.role`**；授权唯一入口 = `grants`（`{kind:'link';id}` / `{kind:'anyone'}`）；
 *      `linkPolicy` 只承载约束（scope/password/expiresAt/deny）。
 *   D4 `denied |= linkPolicy.deny`；`expiresAt !== undefined && ctx.now >= expiresAt ⇒ ∅`；
 *      `scope='anyone'` 按 Q11 强制注入 `deny=[download,export,print]`。
 *   D5 `buildChain` **方案 B**（清空断点以上祖先 grants，denies/policyCap 保留）；
 *      **多重 detach 取最深断点**，断点节点自身 grants 保留。
 *   D6 `ResolveContext { now, activeTeamIds }` 为 resolver 第 4 必需入参（纯函数不读系统时钟）；
 *      有效团队 = `user.teamIds ∩ ctx.activeTeamIds`。
 *   D7 `ShareRole`（可授予 5 档）/ `ShareRoleLevel = ShareRole | 'none'`；
 *      **`capabilitiesOf('none') === ∅` 显式实现**。
 *
 * ─── 用例映射（PRD §4.4 用例表 1–29）──────────────────────────────────────
 *   #1  team Viewer + team Editor                    → Editor（union）              [resolve]
 *   #2  direct Viewer + team Editor                  → Editor（union）              [resolve]
 *   #3  同主体 grants(Editor) + denies(edit)         → 无 edit（deny 胜）          [resolve]
 *   #4  父 deny download + 子授 Viewer               → 无 download（Q5=A 不可逆）  [resolve][P0]
 *   #5  maxRole=commenter + 文件授 Editor            → Commenter（封顶）           [resolve]
 *   #6  linkSharingEnabled=false + via link          → ∅                          [resolve]
 *   #7  非任何授权主体                                → ∅                          [resolve]
 *   #8  via link + passwordOk:true，链接授 Editor    → commenterCaps（裁剪）       [resolve]
 *   #9  根 owner / 子 commenter / 文件 editor        → Commenter（祖先上限）       [resolve][P0]
 *   #10 policyCap.denied=[print,export] + 授 editor  → 无 print/export            [resolve][P0]
 *   #11 via member + chain 含 anyone/link            → ∅（门控）                   [resolve]
 *   #12 非法 role / maxRole / capability（3 断言）   → fail-closed                [resolve]
 *   #13 teamIds 含不在 activeTeamIds 的团队           → 忽略该主体（D6）           [resolve]
 *   #14 幂等 + 不 mutate 入参                         → 相等 / 不变                [resolve]
 *   #15 祖 deny download → 子 Editor → 孙 Owner      → 始终无 download            [resolve][P0]
 *   #16 环状 parentId                                 → 空链（fail-closed）        [buildChain]
 *   #17 detachedFromParent                            → 断 grants，存 denies/cap    [buildChain]
 *   #18 nodesById 缺父节点                             → 链根终止                   [buildChain]
 *   #19 有 linkPolicy 但 via=member                   → linkPolicy 不参与           [resolve]
 *   #20 链接密码未通过 passwordOk:false                → ∅（fail-closed）           [resolve]
 *   #21 成员(Editor) 经公网链接(仅 Viewer) 进入        → editorCaps（两通路并集）    [resolveAccess]
 *   #22 无授权成员经 Viewer 链接进入                   → viewerCaps                 [resolveAccess]
 *   #23 成员经链接进入 + 组织 denied=[download]        → 并集也无 download          [resolveAccess]
 *   #24 单调性守卫 + capabilitiesOf('none')===∅        → 严格单调 / ∅               [RoleCaps]
 *   #25 断链节点的 policyCap 是 effective 值           → 保留组织上限               [buildChain]
 *   #26 链接 expiresAt = ctx.now（已过期）             → ∅                          [resolve]
 *   #27 linkPolicy.deny=['download']                   → commenterCaps − download   [resolve]
 *   #28 scope='anyone' + 授 commenter                  → 再减 download/export/print [resolve]
 *   #29 链上两处 detachedFromParent                    → 取最深断点                 [buildChain]
 *
 * ─── 追加反证（PRD 未逐条列，但属门禁必过）────────────────────────────────
 *   X1 缓存键含 via.id → 不同链接不串权（缓存串权探针）
 *   X2 merge「删改冲突绝不静默覆盖」P0 探针（含结构性冲突矩阵）
 *   X3 纯函数：buildChain 不 mutate 入参
 *   X4 allowSet 单调性 + none 档守卫
 *   X5 **D1 回归防线**：`passwordOk` 缺失（undefined）⇒ ∅（非 `=== false` 放行）
 *
 * ─── 突变控制（证明断言"有牙齿"，非空转）────────────────────────────────
 *   MUT1 v0.2「逐级并集→差集→截断」坏算法 → 用例 4/9/10/15 必须全部被抓
 *   MUT2 merge 静默取修改方            → X2 必须失败
 *   MUT3 linkPolicy 只声明不应用（假安全）→ 用例 26/27/28 必须全部被抓
 *   MUT4 `passwordOk !== false 放行` 旧口径 → X5 必须失败
 *
 * 用法：node scripts/sharing-merge-scan.mjs
 * 退出码：0 = 全绿；2 = 存在 P0/P1 失败（交付门禁用）；1 = 脚本自身异常。
 * 门禁自检：`SHARING_SCAN_FORCE_FAIL=1 node scripts/sharing-merge-scan.mjs` 必返回 2。
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
 * 1. 契约级参考模型（PRD v0.4 §4.4 / §4.4.1 / §4.4.2）
 * ========================================================================= */

/** D7：严格度全序（PRD §4.4.1：owner > admin > editor > commenter > viewer > none） */
const ROLE_ORDER = ['none', 'viewer', 'commenter', 'editor', 'admin', 'owner'];

/** D2：11 项能力（含 transferOwnership） */
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
const hasRole = (role) => Object.prototype.hasOwnProperty.call(ROLE_CAPS, role);

/** D7：role → 能力集合；`capabilitiesOf('none') === ∅` 显式成立；非法 role → ∅（fail-closed） */
function capabilitiesOf(role) {
  if (!hasRole(role)) return new Set();
  return new Set(ROLE_CAPS[role]);
}

/** 上限角色展开：⋃ capabilitiesOf(r)，对所有 r ≤ maxRole；非法 maxRole → ∅（fail-closed） */
function allowSet(maxRole) {
  if (!hasRole(maxRole)) return new Set();
  const limit = roleRank(maxRole);
  const out = new Set();
  for (const r of ROLE_ORDER) {
    if (roleRank(r) <= limit) for (const c of ROLE_CAPS[r]) out.add(c);
  }
  return out;
}

/**
 * D1：访问通路裁剪。
 *   member → 全集；
 *   link   → `passwordOk !== true ⇒ ∅`（必需 boolean，无密码链接由调用方显式填 true）；
 *            否则 capabilitiesOf('commenter')（链接一律 ≤ Commenter）。
 */
function allowSetVia(via) {
  if (!via || typeof via !== 'object') return new Set();
  if (via.kind === 'member') return new Set(CAPS);
  if (via.kind === 'link') {
    if (via.passwordOk !== true) return new Set();
    return capabilitiesOf('commenter');
  }
  return new Set();
}

/**
 * 主体匹配（PRD §4.4.1）。
 * - user：id 相等
 * - team：**仅在有效团队集合内**（D6：`user.teamIds ∩ ctx.activeTeamIds`，已解散团队不匹配）
 * - link：仅 `via.kind==='link'` 且 id 相等（"具体链接"才授权）
 * - anyone：仅 `via.kind==='link'`
 */
function subjectMatches(user, via, subject, teams) {
  if (!subject || typeof subject !== 'object') return false;
  const teamSet = teams instanceof Set ? teams : new Set(teams ?? []);
  switch (subject.kind) {
    case 'user':
      return subject.id === user?.id;
    case 'team':
      return teamSet.has(subject.id);
    case 'link':
      return via?.kind === 'link' && via.id === subject.id;
    case 'anyone':
      return via?.kind === 'link';
    default:
      return false;
  }
}

const intersect = (a, b) => new Set([...a].filter((x) => b.has(x)));
const diff = (a, b) => new Set([...a].filter((x) => !b.has(x)));
const unionInto = (a, b) => { for (const x of b) a.add(x); return a; };
const unionOf = (a, b) => { const o = new Set(a); for (const x of b) o.add(x); return o; };

/** 把任意输入收敛成合法能力列表；非法项忽略（fail-closed，绝不抛） */
function toCaps(v) {
  return Array.isArray(v) ? v.filter((c) => CAPS.includes(c)) : [];
}

/**
 * D4：链接约束是否作用于本节点。
 * 注：D3 删除 `linkPolicy.role` 后 `linkPolicy` **没有 link 身份字段**（见报告 R9），
 *     故参考模型取"节点带 linkPolicy 且本次为链接访问 ⇒ 作用于该访问"（约束沿链累积、fail-closed）。
 *     单链接场景与 PRD 用例 26/27/28 完全等价。
 */
function linkApplies(node, via) {
  return via?.kind === 'link' && node?.linkPolicy != null && typeof node.linkPolicy === 'object';
}

/**
 * D6：求解上下文（必需）。纯函数**不读系统时钟**，`now` 一律由调用方注入。
 * @param {{now:number, activeTeamIds:string[]}} ctx
 */
function makeCtx(now, activeTeamIds) {
  return { now, activeTeamIds: [...(activeTeamIds ?? [])] };
}

/**
 * 参考实现：effective permission 求解（PRD §4.4 v0.4）。
 *   granted(全链并集) ∩ allowed(全链 maxRole 交集) − denied(全链并集，含 cap.denied 与 linkPolicy.deny)
 *   ∩ allowSetVia(via)
 *
 * 关键（P0）：
 *  - policyCap 是 **effective 值**（buildChain/ACL 写入时已按 §2.2 min 过）。
 *  - denied 先累积、最后统一作差 → deny 不可逆（Q5=A）。
 */
function resolvePermissions(user, chain, via, ctx) {
  if (!via || typeof via !== 'object' || !ctx || typeof ctx !== 'object') return new Set();
  if (typeof ctx.now !== 'number' || !Array.isArray(ctx.activeTeamIds)) return new Set(); // D6 fail-closed

  // D6：有效团队 = user.teamIds ∩ ctx.activeTeamIds
  const teams = new Set((user?.teamIds ?? []).filter((id) => ctx.activeTeamIds.includes(id)));

  let granted = new Set();
  const denied = new Set();
  let allowed = new Set(CAPS);

  for (const node of chain ?? []) {
    const cap = node?.policyCap ?? {};

    // ④ 链接通路：任一节点关闭链接共享 → 直接 ∅
    if (via.kind === 'link' && cap.linkSharingEnabled === false) return new Set();

    // ⑥ D4：链接约束（过期 / deny / 公网强制禁项）
    if (linkApplies(node, via)) {
      const lp = node.linkPolicy;
      if (lp.expiresAt !== undefined && ctx.now >= lp.expiresAt) return new Set(); // 过期 ⇒ fail-closed
      for (const c of toCaps(lp.deny)) denied.add(c);
      if (lp.scope === 'anyone') {
        for (const c of ['download', 'export', 'print']) denied.add(c); // Q11=B
      }
    }

    // 授权唯一入口 = grants（D3：不读 linkPolicy.role）
    for (const g of node?.grants ?? []) {
      if (subjectMatches(user, via, g?.subject, teams)) unionInto(granted, capabilitiesOf(g?.role));
    }
    // 显式拒绝（能力粒度）
    for (const d of node?.denies ?? []) {
      if (subjectMatches(user, via, d?.subject, teams) && CAPS.includes(d?.capability)) denied.add(d.capability);
    }
    // ② 组织强制禁项（实际应用）
    for (const c of toCaps(cap.denied)) denied.add(c);
    // ① 全链 maxRole 逐级求交（双重保险）
    allowed = intersect(allowed, allowSet(cap.maxRole));
  }

  let caps = intersect(granted, allowed);
  caps = diff(caps, denied);            // ③ deny 不可逆（Q5=A）
  caps = intersect(caps, allowSetVia(via)); // ③ 链接通路裁剪（passwordOk !== true ⇒ ∅）
  return caps;
}

/**
 * 访问入口（PRD §4.4 关键约定 #8）：已登录成员经链接进入 → resolve(member) ∪ resolve(link)。
 * 两条通路各自独立 fail-closed 与不可逆 deny，并集不会把被禁能力加回来。
 */
function resolveAccess(user, chain, entry, ctx) {
  if (!entry || typeof entry !== 'object') return new Set();
  if (entry.kind === 'link') {
    const linkVia = { kind: 'link', id: entry.id, passwordOk: entry.passwordOk };
    const linkCaps = resolvePermissions(user, chain, linkVia, ctx);
    if (entry.isAuthenticatedMember === true) {
      const memberCaps = resolvePermissions(user, chain, { kind: 'member' }, ctx);
      return unionOf(memberCaps, linkCaps);
    }
    return linkCaps;
  }
  if (entry.kind === 'member') return resolvePermissions(user, chain, { kind: 'member' }, ctx);
  return new Set();
}

/**
 * 参考实现：buildChain（PRD §4.4.2，**D5 方案 B**）。
 *  ① 环检测 → 返回 []（fail-closed，不死循环）
 *  ② detach → **清空断点以上祖先的 grants**；`denies` 与 `policyCap` 一律保留
 *     **多重 detach 取最深（最靠近目标）断点**，断点节点自身 grants 保留
 *  ③ 顺序：根 → 目标
 *  ④ 缺失父节点 → 链根终止
 *  ⑤ **计算 effective policyCap**（§2.2 三级 min：maxRole 取最严、denied 取并集、
 *     linkSharingEnabled 取 AND）—— 在断链**之前**按完整祖先路径算，故 detach 不丢组织上限
 *  纯函数：返回深拷贝，不 mutate 入参
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
    linkPolicy: n.linkPolicy ? { ...n.linkPolicy, deny: [...(n.linkPolicy.deny ?? [])] } : undefined,
  };
}

function buildChain(nodesById, fileId) {
  const lookup = (id) => (nodesById instanceof Map ? nodesById.get(id) : nodesById?.[id]);
  const upward = [];
  const seen = new Set();
  let cur = fileId;

  while (cur != null) {
    if (seen.has(cur)) return []; // ① 环 → fail-closed
    seen.add(cur);
    const raw = lookup(cur);
    if (!raw) break; // ④ 缺失节点 → 链根终止
    upward.push(raw);
    cur = raw.parentId ?? null;
    if (upward.length > 10000) return []; // 防御性上限
  }

  const chain = upward.reverse().map(cloneNode); // ③ 根 → 目标

  // ⑤ effective policyCap（用完整祖先路径；detach 不清上限）
  let accMax = 'owner';
  const accDenied = new Set();
  let accLink = true;
  for (const n of chain) {
    const raw = n.policyCap ?? {};
    if (!hasRole(raw.maxRole)) accMax = 'none';            // 非法 maxRole → 收敛为 none
    else if (!hasRole(accMax) || roleRank(raw.maxRole) < roleRank(accMax)) accMax = raw.maxRole;
    for (const c of toCaps(raw.denied)) accDenied.add(c);
    if (raw.linkSharingEnabled === false) accLink = false;
  }
  for (const n of chain) {
    n.policyCap = { maxRole: accMax, denied: [...accDenied], linkSharingEnabled: accLink };
  }

  // ② 方案 B：取最深断点，清空其**祖先**的 grants（断点节点自身保留；denies/cap 不动）
  let detachIndex = -1;
  for (let i = 0; i < chain.length; i++) if (chain[i].detachedFromParent === true) detachIndex = i;
  if (detachIndex > 0) {
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
    linkSharingEnabled: opts.linkSharingEnabled !== false,
  },
  detachedFromParent: opts.detachedFromParent,
  ...(opts.linkPolicy ? { linkPolicy: opts.linkPolicy } : {}),
});

const grant = (subject, role) => ({ subject, role });
const deny = (subject, capability) => ({ subject, capability });
const U = (id) => ({ kind: 'user', id });
const T = (id) => ({ kind: 'team', id });
const L = (id) => ({ kind: 'link', id });
const ANYONE = { kind: 'anyone' };
const MEMBER = { kind: 'member' };
/** D1：passwordOk 必需；无密码链接由调用方显式填 true */
const linkVia = (id, passwordOk = true) => ({ kind: 'link', id, passwordOk });

/** 全局 ctx（覆盖本文件用到的全部团队 id） */
const ALL_TEAMS = ['t-view', 't-edit', 't-live'];
const CTX = makeCtx(1_000_000, ALL_TEAMS);

/* =========================================================================
 * 4. 用例 1–29
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
    const r = resolvePermissions(setUser, chain, MEMBER, CTX);
    return { ok: eqSet(r, capabilitiesOf('editor')), actual: `result=${setToArr(r).join(',')}`, severity: 'P0' };
  });

  // #2 direct Viewer + team Editor → Editor
  runCase('#2', 'direct Viewer + team Editor → Editor（union）', 'result === capabilitiesOf(editor)', () => {
    const chain = [node('root', null), node('f', 'root', { grants: [grant(U('u1'), 'viewer'), grant(T('t-edit'), 'editor')] })];
    const r = resolvePermissions(setUser, chain, MEMBER, CTX);
    return { ok: eqSet(r, capabilitiesOf('editor')), actual: `result=${setToArr(r).join(',')}`, severity: 'P0' };
  });

  // #3 同主体 grants(Editor) + denies(edit) → 无 edit
  runCase('#3', '同主体 grants(Editor) + denies(edit) → 无 edit（deny 胜）', 'result 不含 edit，且 open/saveAs 仍在', () => {
    const chain = [node('root', null), node('f', 'root', { grants: [grant(U('u1'), 'editor')], denies: [deny(U('u1'), 'edit')] })];
    const r = resolvePermissions(setUser, chain, MEMBER, CTX);
    const ok = !r.has('edit') && r.has('open') && r.has('saveAs');
    return { ok, actual: `result=${setToArr(r).join(',')} 含 edit=${r.has('edit')}`, severity: 'P0' };
  });

  // #4 ★ 父 deny download + 子授 Viewer → 无 download（Q5=A）
  runCase('#4', '★ 父 deny download + 子授 Viewer → 无 download（Q5=A 不可逆）', 'download 不在；open/print/export 在', () => {
    const chain = [
      node('root', null, { denies: [deny(U('u1'), 'download')] }),
      node('f', 'root', { grants: [grant(U('u1'), 'viewer')] }),
    ];
    const r = resolvePermissions(setUser, chain, MEMBER, CTX);
    const ok = !r.has('download') && r.has('open') && r.has('print') && r.has('export');
    return { ok, actual: `含 download=${r.has('download')} result=${setToArr(r).join(',')}`, severity: 'P0', evidence: 'deny 被后续 grant 回弹即为越权' };
  });

  // #5 maxRole=commenter + 文件授 Editor → Commenter
  runCase('#5', 'maxRole=commenter + 文件授 Editor → Commenter（封顶）', 'result === capabilitiesOf(commenter)', () => {
    const chain = [node('root', null, { maxRole: 'commenter' }), node('f', 'root', { grants: [grant(U('u1'), 'editor')] })];
    const r = resolvePermissions(setUser, chain, MEMBER, CTX);
    return { ok: eqSet(r, capabilitiesOf('commenter')), actual: `result=${setToArr(r).join(',')}`, severity: 'P0' };
  });

  // #6 linkSharingEnabled=false + via link → ∅（成员 via 不受影响）
  runCase('#6', 'linkSharingEnabled=false + via link → ∅', '空集；同条件 via member 仍可得授权', () => {
    const chain = [
      node('root', null, { linkSharingEnabled: false }),
      node('f', 'root', { grants: [grant(ANYONE, 'viewer'), grant(U('u1'), 'viewer')] }),
    ];
    const rLink = resolvePermissions(setUser, chain, linkVia('lk1'), CTX);
    const rMember = resolvePermissions(setUser, chain, MEMBER, CTX);
    const ok = rLink.size === 0 && rMember.size > 0;
    return { ok, actual: `link=${rLink.size} member=${rMember.size}`, severity: 'P0' };
  });

  // #7 非任何授权主体 → ∅
  runCase('#7', '非任何授权主体 → ∅', '空集', () => {
    const chain = [node('root', null), node('f', 'root', { grants: [grant(U('other'), 'owner')] })];
    const r = resolvePermissions(setUser, chain, MEMBER, CTX);
    return { ok: r.size === 0, actual: `size=${r.size}`, severity: 'P0' };
  });

  // #8 D1：via link + passwordOk:true，链接授 Editor → commenterCaps
  runCase('#8', 'D1：via link + passwordOk:true，链接授 Editor → commenterCaps（裁剪）', 'result === capabilitiesOf(commenter)', () => {
    const chain = [node('root', null), node('f', 'root', { grants: [grant(L('lk1'), 'editor')] })];
    const r = resolvePermissions(setUser, chain, linkVia('lk1', true), CTX);
    return { ok: eqSet(r, capabilitiesOf('commenter')), actual: `result=${setToArr(r).join(',')}`, severity: 'P0' };
  });

  // #9 ★ 根 owner / 子 commenter / 文件 editor → Commenter
  runCase('#9', '★ 祖先多层上限：root owner / child commenter / file editor → Commenter', 'result === capabilitiesOf(commenter)', () => {
    const chain = [
      node('root', null, { maxRole: 'owner' }),
      node('child', 'root', { maxRole: 'commenter' }),
      node('f', 'child', { maxRole: 'owner', grants: [grant(U('u1'), 'editor')] }),
    ];
    const r = resolvePermissions(setUser, chain, MEMBER, CTX);
    return { ok: eqSet(r, capabilitiesOf('commenter')), actual: `result=${setToArr(r).join(',')}`, severity: 'P0', evidence: '更深层 grant 不得回弹突破祖先上限' };
  });

  // #10 ★ 组织 policyCap.denied=[print,export] + 文件 editor → 无 print/export
  runCase('#10', '★ policyCap.denied=[print,export] + 文件授 editor → 无 print/export', 'print/export 不在；edit 仍在', () => {
    const chain = [
      node('root', null, { denied: ['print', 'export'] }),
      node('f', 'root', { grants: [grant(U('u1'), 'editor')], denied: [] }),
    ];
    const r = resolvePermissions(setUser, chain, MEMBER, CTX);
    const ok = !r.has('print') && !r.has('export') && r.has('edit');
    return { ok, actual: `print=${r.has('print')} export=${r.has('export')} edit=${r.has('edit')}`, severity: 'P0', evidence: '组织强制禁项被后续 grant 回弹即为越权' };
  });

  // #11 via member + chain 含 anyone / link → ∅（门控）
  runCase('#11', 'via member + chain 含 anyone/link 授权 → ∅（门控）', '空集', () => {
    const chain = [node('root', null), node('f', 'root', { grants: [grant(ANYONE, 'editor'), grant(L('lk1'), 'editor')] })];
    const r = resolvePermissions(setUser, chain, MEMBER, CTX);
    return { ok: r.size === 0, actual: `size=${r.size}`, severity: 'P0' };
  });

  // #12 三条独立断言：非法 grant.role / 非法 maxRole / 非法 deny.capability
  runCase('#12', '非法 role / maxRole / capability（3 条独立断言）→ fail-closed，均不抛异常', '①忽略非法授权 ②整体 ∅ ③忽略非法拒绝', () => {
    // ① 非法 grant.role → 忽略该条，合法授权照常
    const c1 = [node('root', null), node('f', 'root', { grants: [grant(U('u1'), 'wizard'), grant(U('u1'), 'viewer')] })];
    const r1 = resolvePermissions(setUser, c1, MEMBER, CTX);
    const a1 = eqSet(r1, capabilitiesOf('viewer'));

    // ② 非法 maxRole → allowSet ∅ ⇒ 整体 ∅
    const c2 = [node('root', null, { maxRole: 'superuser' }), node('f', 'root', { grants: [grant(U('u1'), 'editor')] })];
    const r2 = resolvePermissions(setUser, c2, MEMBER, CTX);
    const a2 = r2.size === 0;

    // ③ 非法 deny.capability → 忽略该条拒绝
    const c3 = [node('root', null), node('f', 'root', { grants: [grant(U('u1'), 'editor')], denies: [deny(U('u1'), 'nuke')] })];
    const r3 = resolvePermissions(setUser, c3, MEMBER, CTX);
    const a3 = eqSet(r3, capabilitiesOf('editor'));

    return {
      ok: a1 && a2 && a3,
      actual: `①=${a1}（size=${r1.size}）②=${a2}（size=${r2.size}）③=${a3}（size=${r3.size}）`,
      severity: 'P0',
      evidence: '①③须"忽略该条"而非整体失败；②非法 maxRole 必须整体收敛为 ∅（fail-closed）',
    };
  });

  // #12b 仅非法 grant.role（maxRole 合法）→ 忽略该条
  runCase('#12b', '仅非法 grant.role（maxRole 合法）→ 忽略该条，不放行', 'size=0', () => {
    const chain = [node('root', null, { maxRole: 'owner' }), node('f', 'root', { grants: [grant(U('u1'), 'wizard')] })];
    const r = resolvePermissions(setUser, chain, MEMBER, CTX);
    return { ok: r.size === 0, actual: `size=${r.size}`, severity: 'P0' };
  });

  // #13 D6：teamIds 含不在 activeTeamIds 的团队 → 视为不匹配
  runCase('#13', 'D6：teamIds 含不在 ctx.activeTeamIds 的团队（已解散）→ 该主体忽略', '解散团队授权不生效；有效团队授权生效', () => {
    const u = { id: 'u1', teamIds: ['t-dead', 't-live'] };
    const chain = [node('root', null), node('f', 'root', { grants: [grant(T('t-dead'), 'owner'), grant(T('t-live'), 'viewer')] })];
    const ctx = makeCtx(1_000_000, ['t-live']); // t-dead 不在活跃集
    const r = resolvePermissions(u, chain, MEMBER, ctx);
    const ok = !r.has('edit') && r.has('open') && eqSet(r, capabilitiesOf('viewer'));
    return { ok, actual: `result=${setToArr(r).join(',')}`, severity: 'P0', evidence: '解散团队必须视为空主体（fail-closed，不放行）' };
  });

  // #14 幂等 + 纯度（含 ctx 不被 mutate）
  runCase('#14', '幂等 + 不 mutate 入参（chain / ctx）', '两次结果相等；入参深比较不变', () => {
    const chain = [
      node('root', null, { denies: [deny(U('u1'), 'download')] }),
      node('f', 'root', { grants: [grant(U('u1'), 'editor')] }),
    ];
    const ctx = makeCtx(1_000_000, ALL_TEAMS);
    const snap = JSON.stringify([chain, ctx]);
    const r1 = resolvePermissions(setUser, chain, MEMBER, ctx);
    const r2 = resolvePermissions(setUser, chain, MEMBER, ctx);
    const unchanged = JSON.stringify([chain, ctx]) === snap;
    return { ok: eqSet(r1, r2) && unchanged, actual: `相等=${eqSet(r1, r2)} 入参未变=${unchanged}`, severity: 'P0' };
  });

  // #15 ★ 跨层不可逆：祖 deny download → 子 Editor → 孙 Owner
  runCase('#15', '★ 不可逆回归：祖 deny download → 子 Editor → 孙 Owner，download 始终不在', 'download 不在；edit 与 transferOwnership 在', () => {
    const chain = [
      node('root', null, { denies: [deny(U('u1'), 'download')] }),
      node('mid', 'root', { grants: [grant(U('u1'), 'editor')] }),
      node('leaf', 'mid', { grants: [grant(U('u1'), 'owner')] }),
    ];
    const r = resolvePermissions(setUser, chain, MEMBER, CTX);
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
    const elapsed = Date.now() - t0;
    const ok = Array.isArray(chain) && chain.length === 0 && elapsed < 1000;
    return { ok, actual: `len=${chain.length} 未超时=${elapsed < 1000}`, severity: 'P0' };
  });

  // #17 D5：断链只断 grants，denies/policyCap 仍生效
  runCase('#17', 'D5 断链：祖先 grants 清空；祖先 denies 与 policyCap 保留；断点节点 grants 保留', 'root.grants=0 且 denies/maxRole 在；mid.grants 保留；resolve 无 download 无 edit', () => {
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
    const r = resolvePermissions(setUser, chain, MEMBER, CTX);
    // 断链后 mid/f 的 editor 授权仍在，但 root maxRole=commenter 仍封顶；
    // root deny download 仍生效 → 期望 = commenterCaps − {download}（5 项）
    const semanticsOk = !r.has('download') && !r.has('edit') && r.has('open') && r.has('comment') && r.size === 5;
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

  // #19 有 linkPolicy 但 via member → linkPolicy 不参与（且无 role 字段也能跑）
  runCase('#19', '有 linkPolicy 但 via=member → linkPolicy 不参与（D3：linkPolicy 无 role）', '空集（成员不能因链接配置获权）', () => {
    const chain = [
      node('root', null),
      node('f', 'root', { linkPolicy: { scope: 'anyone', deny: [], password: 'x' } }),
    ];
    const hasRoleField = chain[1].linkPolicy.role !== undefined;
    const r = resolvePermissions(setUser, chain, MEMBER, CTX);
    return { ok: r.size === 0 && !hasRoleField, actual: `size=${r.size} linkPolicy 含 role=${hasRoleField}`, severity: 'P0' };
  });

  // #20 passwordOk=false → ∅
  runCase('#20', 'D1：链接密码未通过（passwordOk:false）→ ∅', '空集', () => {
    const chain = [node('root', null), node('f', 'root', { grants: [grant(L('lk1'), 'viewer')] })];
    const r = resolvePermissions(setUser, chain, linkVia('lk1', false), CTX);
    return { ok: r.size === 0, actual: `size=${r.size}`, severity: 'P0' };
  });

  // #20b 密码通过 → 按 commenter 裁剪
  runCase('#20b', '链接密码通过（passwordOk:true）→ commenterCaps', 'result === capabilitiesOf(commenter)', () => {
    const chain = [node('root', null), node('f', 'root', { grants: [grant(L('lk1'), 'editor')] })];
    const r = resolvePermissions(setUser, chain, linkVia('lk1', true), CTX);
    return { ok: eqSet(r, capabilitiesOf('commenter')), actual: `result=${setToArr(r).join(',')}`, severity: 'P0' };
  });

  // #21 已登录成员（团队 Editor）经公网链接（链接仅 Viewer）→ editorCaps
  runCase('#21', '成员(团队 Editor) 经公网链接(仅 Viewer) 进入 → editorCaps（两通路并集）', 'result === capabilitiesOf(editor)', () => {
    const chain = [
      node('root', null),
      node('f', 'root', {
        grants: [grant(T('t-edit'), 'editor'), grant(ANYONE, 'viewer')],
        linkPolicy: { scope: 'anyone', deny: [] },
      }),
    ];
    const r = resolveAccess(setUser, chain, { isAuthenticatedMember: true, kind: 'link', id: 'lk-pub', passwordOk: true }, CTX);
    return {
      ok: eqSet(r, capabilitiesOf('editor')),
      actual: `result=${setToArr(r).join(',')}`,
      severity: 'P0',
      evidence: '成员不被链接降权；download/export/print 由成员通路提供（Q11 仅约束链接通路，见报告观察项 O1）',
    };
  });

  // #22 无授权成员经 Viewer 链接进入 → viewerCaps
  runCase('#22', '无授权成员经 Viewer 链接进入 → viewerCaps（并集另一半）', 'result === capabilitiesOf(viewer)', () => {
    const chain = [
      node('root', null),
      node('f', 'root', { grants: [grant(L('lk1'), 'viewer')], linkPolicy: { scope: 'invited', deny: [] } }),
    ];
    const r = resolveAccess(setUser, chain, { isAuthenticatedMember: true, kind: 'link', id: 'lk1', passwordOk: true }, CTX);
    return { ok: eqSet(r, capabilitiesOf('viewer')), actual: `result=${setToArr(r).join(',')}`, severity: 'P0' };
  });

  // #23 成员经链接进入 + 组织 denied=[download] → 并集也无 download
  runCase('#23', '成员经链接进入 + 组织 denied=[download] → 并集也无 download', 'editorCaps 减 download', () => {
    const chain = [
      node('root', null, { denied: ['download'] }),
      node('f', 'root', { grants: [grant(T('t-edit'), 'editor'), grant(L('lk1'), 'viewer')], linkPolicy: { scope: 'invited', deny: [] } }),
    ];
    const r = resolveAccess(setUser, chain, { isAuthenticatedMember: true, kind: 'link', id: 'lk1', passwordOk: true }, CTX);
    const want = diff(capabilitiesOf('editor'), new Set(['download']));
    return { ok: eqSet(r, want) && !r.has('download'), actual: `含 download=${r.has('download')} result=${setToArr(r).join(',')}`, severity: 'P0' };
  });

  // #24 单调性守卫 + capabilitiesOf('none') === ∅
  runCase('#24', 'RoleCaps 单调性守卫 + capabilitiesOf(none)===∅', '∀ r1>r2: caps(r1) ⊇ caps(r2)；caps(none)=∅；allowSet(none)=∅', () => {
    const bad = [];
    for (let i = 1; i < ROLE_ORDER.length; i++) {
      const lower = capabilitiesOf(ROLE_ORDER[i - 1]);
      const higher = capabilitiesOf(ROLE_ORDER[i]);
      for (const c of lower) if (!higher.has(c)) bad.push(`${ROLE_ORDER[i]} 缺 ${c}`);
    }
    const noneEmpty = capabilitiesOf('none').size === 0 && allowSet('none').size === 0;
    const capCount = CAPS.length === 11;
    return {
      ok: bad.length === 0 && noneEmpty && capCount,
      actual: bad.length ? `非单调：${bad.join('; ')}` : `严格单调；none=∅ ${noneEmpty}；能力数=${CAPS.length}`,
      severity: 'P0',
      evidence: '把 none 当 viewer 是最典型越权写法；能力数须为 11（D2）',
    };
  });

  // #25 断链节点的 policyCap 是 effective 值（保留组织上限）
  runCase('#25', '断链节点的 policyCap 是 effective 值（含组织上限，非 raw）', 'f.policyCap.maxRole=commenter 且 denied 含 export；root.grants 被清空', () => {
    const map = new Map([
      ['root', node('root', null, { maxRole: 'commenter', denied: ['export'], grants: [grant(U('u1'), 'owner')] })],
      ['mid', node('mid', 'root', { detachedFromParent: true, grants: [grant(U('u1'), 'editor')] })],
      ['f', node('f', 'mid', { maxRole: 'owner', grants: [grant(U('u1'), 'editor')] })],
    ]);
    const chain = buildChain(map, 'f');
    const root = chain.find((n) => n.id === 'root');
    const f = chain.find((n) => n.id === 'f');
    const ok = f?.policyCap?.maxRole === 'commenter' && (f?.policyCap?.denied ?? []).includes('export') &&
      root?.grants.length === 0;
    return {
      ok,
      actual: `f.maxRole=${f?.policyCap?.maxRole} f.denied=${(f?.policyCap?.denied ?? []).join(',')} root.grants=${root?.grants.length}`,
      severity: 'P0',
      evidence: '若节点存 raw（owner）→ detach 后组织上限丢失，深层 grant 即可回弹（P0）',
    };
  });

  // #26 链接过期 → ∅（D4）
  runCase('#26', 'D4：链接 expiresAt = ctx.now（已过期）→ ∅', '空集（fail-closed）', () => {
    const chain = [
      node('root', null),
      node('f', 'root', { grants: [grant(L('lk1'), 'editor')], linkPolicy: { scope: 'invited', deny: [], expiresAt: 1000 } }),
    ];
    const ctx = makeCtx(1000, ALL_TEAMS);
    const r = resolvePermissions(setUser, chain, linkVia('lk1', true), ctx);
    return { ok: r.size === 0, actual: `size=${r.size}`, severity: 'P0', evidence: '`now >= expiresAt` 必须收敛为 ∅（边界相等即过期）' };
  });

  // #26b 未过期边界 → 正常
  runCase('#26b', '未过期边界（ctx.now = expiresAt - 1）→ 正常授予', 'result === capabilitiesOf(commenter)', () => {
    const chain = [
      node('root', null),
      node('f', 'root', { grants: [grant(L('lk1'), 'editor')], linkPolicy: { scope: 'invited', deny: [], expiresAt: 1000 } }),
    ];
    const r = resolvePermissions(setUser, chain, linkVia('lk1', true), makeCtx(999, ALL_TEAMS));
    return { ok: eqSet(r, capabilitiesOf('commenter')), actual: `result=${setToArr(r).join(',')}`, severity: 'P1' };
  });

  // #27 linkPolicy.deny=['download'] 生效（D4）
  runCase('#27', 'D4：linkPolicy.deny=[download]，链接授 Editor → commenterCaps − download', '无 download，其余 commenterCaps 在', () => {
    const chain = [
      node('root', null),
      node('f', 'root', { grants: [grant(L('lk1'), 'editor')], linkPolicy: { scope: 'invited', deny: ['download'] } }),
    ];
    const r = resolvePermissions(setUser, chain, linkVia('lk1', true), CTX);
    const want = diff(capabilitiesOf('commenter'), new Set(['download']));
    return {
      ok: eqSet(r, want) && !r.has('download') && r.has('export') && r.has('print'),
      actual: `含 download=${r.has('download')} result=${setToArr(r).join(',')}`,
      severity: 'P0',
      evidence: 'v0.3 只声明不应用 → 链接级"禁下载"可绕过（假安全）',
    };
  });

  // #28 scope='anyone' → Q11 强制注入 deny=[download,export,print]
  runCase('#28', 'Q11/D4：scope=anyone + 授 commenter → commenterCaps − {download,export,print}', 'result = {open,comment,viewHistory}', () => {
    const chain = [
      node('root', null),
      node('f', 'root', { grants: [grant(ANYONE, 'commenter')], linkPolicy: { scope: 'anyone', deny: [] } }),
    ];
    const r = resolvePermissions(setUser, chain, linkVia('lk-pub', true), CTX);
    const want = new Set(['open', 'comment', 'viewHistory']);
    return {
      ok: eqSet(r, want),
      actual: `result=${setToArr(r).join(',')}`,
      severity: 'P0',
      evidence: '公网链接默认不得下载/导出/打印（Q11=B）',
    };
  });

  // #28b scope='invited' 不注入 → 允许 download
  runCase('#28b', 'scope=invited 不注入 Q11 禁项 → download 仍在', 'result === capabilitiesOf(commenter)', () => {
    const chain = [
      node('root', null),
      node('f', 'root', { grants: [grant(L('lk1'), 'commenter')], linkPolicy: { scope: 'invited', deny: [] } }),
    ];
    const r = resolvePermissions(setUser, chain, linkVia('lk1', true), CTX);
    return { ok: eqSet(r, capabilitiesOf('commenter')), actual: `result=${setToArr(r).join(',')}`, severity: 'P1' };
  });

  // #29 多重 detach → 取最深断点
  runCase('#29', 'D5：链上两处 detachedFromParent → 取最深断点，仅其祖先 grants 被清空', 'root/b/c.grants=0；d/f.grants 保留', () => {
    const map = new Map([
      ['root', node('root', null, { grants: [grant(U('u1'), 'owner')] })],
      ['b', node('b', 'root', { detachedFromParent: true, grants: [grant(U('u1'), 'owner')] })],
      ['c', node('c', 'b', { grants: [grant(U('u1'), 'owner')] })],
      ['d', node('d', 'c', { detachedFromParent: true, grants: [grant(U('u1'), 'editor')] })],
      ['f', node('f', 'd', { grants: [grant(U('u1'), 'editor')] })],
    ]);
    const chain = buildChain(map, 'f');
    const g = (id) => chain.find((n) => n.id === id)?.grants.length;
    const ok = chain.length === 5 &&
      g('root') === 0 && g('b') === 0 && g('c') === 0 && g('d') === 1 && g('f') === 1;
    const r = resolvePermissions(setUser, chain, MEMBER, CTX);
    return {
      ok: ok && eqSet(r, capabilitiesOf('editor')),
      actual: `len=${chain.length} grants(root,b,c,d,f)=${g('root')},${g('b')},${g('c')},${g('d')},${g('f')} resolve=${setToArr(r).join(',')}`,
      severity: 'P0',
      evidence: '若取最浅断点 → 浅断点与深断点之间的节点 grants 会被错误保留（授权越界）',
    };
  });
}

/* =========================================================================
 * 5. 追加反证：缓存串权 / 合并 P0 / 纯函数 / D1 回归 / 单调性
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
    const rA = resolvePermissions(u, chainA, viaA, CTX);
    const rB = resolvePermissions(u, chainB, viaB, CTX);
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
  runCase('X3', 'buildChain 纯度：不 mutate nodesById', '返回后原节点 grants/denies/policyCap 不变', () => {
    const n1 = node('root', null, { grants: [grant(U('u1'), 'owner')], denies: [deny(U('u1'), 'download')], maxRole: 'commenter' });
    const n2 = node('f', 'root', { detachedFromParent: true, grants: [grant(U('u1'), 'editor')] });
    const map = new Map([['root', n1], ['f', n2]]);
    const snap = JSON.stringify([n1, n2]);
    buildChain(map, 'f');
    return { ok: JSON.stringify([n1, n2]) === snap, actual: `入参未变=${JSON.stringify([n1, n2]) === snap}`, severity: 'P0' };
  });

  // X4 allowSet 单调性 + 非法 maxRole
  runCase('X4', 'allowSet：⋃(r ≤ maxRole) 与 capabilitiesOf(maxRole) 数值等价；非法 maxRole → ∅', '5 档等价；superuser → ∅', () => {
    const bad = [];
    for (const r of ROLE_ORDER) {
      if (!eqSet(allowSet(r), capabilitiesOf(r))) bad.push(r);
    }
    const illegalEmpty = allowSet('superuser').size === 0;
    return {
      ok: bad.length === 0 && illegalEmpty,
      actual: bad.length ? `不等价：${bad.join(',')}` : `5 档等价；非法 maxRole=∅ ${illegalEmpty}`,
      severity: 'P1',
    };
  });

  // X5 D1 回归防线：passwordOk 缺失 ⇒ ∅（不得按 `!== false 放行`）
  runCase('X5', 'D1 回归：passwordOk 缺失（undefined）⇒ ∅', '空集（漏传参绝不静默绕过密码）', () => {
    const chain = [node('root', null), node('f', 'root', { grants: [grant(L('lk1'), 'editor')] })];
    const r = resolvePermissions({ id: 'u1', teamIds: [] }, chain, { kind: 'link', id: 'lk1' }, CTX);
    return {
      ok: r.size === 0,
      actual: `size=${r.size}`,
      severity: 'P0',
      evidence: '若按 `=== false 放行`，漏传 passwordOk 即静默绕过密码（与 Q5=A fail-closed 相悖）',
    };
  });
}

/* =========================================================================
 * 5b. 突变控制（mutation control）—— 证明断言"有牙齿"而非空转
 *
 * 若把算法换成 v0.2 的逐级写法（每节点：并集 grants → 减 denies → 截断 cap），
 * 用例 4/9/10/15 必须**失败**。若突变体也能通过，说明断言形同虚设（测试自身 P0）。
 * ========================================================================= */

/** 故意写坏的 v0.2 风格实现：逐级先并集再差集（会允许更深层 grant 回弹） */
function resolveV02Mutant(user, chain, via, ctx) {
  const teams = new Set((user?.teamIds ?? []).filter((id) => (ctx?.activeTeamIds ?? []).includes(id)));
  let caps = new Set();
  for (const n of chain ?? []) {
    for (const g of n.grants ?? []) if (subjectMatches(user, via, g.subject, teams)) unionInto(caps, capabilitiesOf(g.role));
    for (const d of n.denies ?? []) if (subjectMatches(user, via, d.subject, teams) && CAPS.includes(d.capability)) caps.delete(d.capability);
    caps = intersect(caps, allowSet(n.policyCap?.maxRole));   // 在循环内截断（v0.2 的做法）
    for (const c of n.policyCap?.denied ?? []) caps.delete(c);
  }
  return intersect(caps, allowSetVia(via));
}

/**
 * 故意写坏的 resolver：**linkPolicy 只声明不应用**（v0.3 D4 的"假安全"）。
 * 过期不判、linkPolicy.deny 不并、anyone 不注入 Q11 禁项。
 */
function resolveLinkPolicyBlind(user, chain, via, ctx) {
  const teams = new Set((user?.teamIds ?? []).filter((id) => (ctx?.activeTeamIds ?? []).includes(id)));
  let granted = new Set();
  const denied = new Set();
  let allowed = new Set(CAPS);
  for (const node of chain ?? []) {
    const cap = node?.policyCap ?? {};
    if (via.kind === 'link' && cap.linkSharingEnabled === false) return new Set();
    for (const g of node?.grants ?? []) {
      if (subjectMatches(user, via, g?.subject, teams)) unionInto(granted, capabilitiesOf(g?.role));
    }
    for (const d of node?.denies ?? []) {
      if (subjectMatches(user, via, d?.subject, teams) && CAPS.includes(d?.capability)) denied.add(d.capability);
    }
    for (const c of toCaps(cap.denied)) denied.add(c);
    allowed = intersect(allowed, allowSet(cap.maxRole));
  }
  return intersect(diff(intersect(granted, allowed), denied), allowSetVia(via));
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

/** 故意写坏的 allowSetVia：`passwordOk === false ⇒ ∅`（漏传参即放行，D1 明令禁止的口径） */
function allowSetViaLoose(via) {
  if (!via || typeof via !== 'object') return new Set();
  if (via.kind === 'member') return new Set(CAPS);
  if (via.kind === 'link') {
    if (via.passwordOk === false) return new Set();
    return capabilitiesOf('commenter');
  }
  return new Set();
}

function runMutationControl() {
  const u = { id: 'u1', teamIds: [] };

  runCase('MUT1', '突变控制：v0.2 逐级写法必须被用例 4/9/10/15 全部抓住', '四个 P0 用例在突变体上全部失败', () => {
    const c4 = [
      node('root', null, { denies: [deny(U('u1'), 'download')] }),
      node('f', 'root', { grants: [grant(U('u1'), 'viewer')] }),
    ];
    const c4Caught = resolveV02Mutant(u, c4, MEMBER, CTX).has('download');

    const c9 = [
      node('root', null, { maxRole: 'owner' }),
      node('child', 'root', { maxRole: 'commenter' }),
      node('f', 'child', { maxRole: 'owner', grants: [grant(U('u1'), 'editor')] }),
    ];
    const c9Caught = !eqSet(resolveV02Mutant(u, c9, MEMBER, CTX), capabilitiesOf('commenter'));

    const c10 = [
      node('root', null, { denied: ['print', 'export'] }),
      node('f', 'root', { grants: [grant(U('u1'), 'editor')] }),
    ];
    const m10 = resolveV02Mutant(u, c10, MEMBER, CTX);
    const c10Caught = m10.has('print') || m10.has('export');

    const c15 = [
      node('root', null, { denies: [deny(U('u1'), 'download')] }),
      node('mid', 'root', { grants: [grant(U('u1'), 'editor')] }),
      node('leaf', 'mid', { grants: [grant(U('u1'), 'owner')] }),
    ];
    const c15Caught = resolveV02Mutant(u, c15, MEMBER, CTX).has('download');

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

  runCase('MUT3', '突变控制：linkPolicy 只声明不应用必须被用例 26/27/28 抓住', '过期/deny/公网禁项三条断言在突变体上全部失败', () => {
    // 26：过期 → 期望 ∅；突变体不判过期 → 非空
    const c26 = [
      node('root', null),
      node('f', 'root', { grants: [grant(L('lk1'), 'editor')], linkPolicy: { scope: 'invited', deny: [], expiresAt: 1000 } }),
    ];
    const c26Caught = resolveLinkPolicyBlind(u, c26, linkVia('lk1', true), makeCtx(1000, ALL_TEAMS)).size !== 0;

    // 27：linkPolicy.deny=[download] → 期望无 download；突变体不并 deny → 有 download
    const c27 = [
      node('root', null),
      node('f', 'root', { grants: [grant(L('lk1'), 'editor')], linkPolicy: { scope: 'invited', deny: ['download'] } }),
    ];
    const c27Caught = resolveLinkPolicyBlind(u, c27, linkVia('lk1', true), CTX).has('download');

    // 28：scope=anyone → 期望无 download/export/print；突变体不注入 → 有
    const c28 = [
      node('root', null),
      node('f', 'root', { grants: [grant(ANYONE, 'commenter')], linkPolicy: { scope: 'anyone', deny: [] } }),
    ];
    const m28 = resolveLinkPolicyBlind(u, c28, linkVia('lk-pub', true), CTX);
    const c28Caught = m28.has('download') && m28.has('export') && m28.has('print');

    const all = [c26Caught, c27Caught, c28Caught];
    return {
      ok: all.every(Boolean),
      actual: `突变体被抓：用例26=${c26Caught} 用例27=${c27Caught} 用例28=${c28Caught}`,
      severity: 'P0',
      evidence: 'D4 若退化为"声明了不用"，三条断言必须变红，否则属假安全',
    };
  });

  runCase('MUT4', '突变控制：`passwordOk !== false 放行` 旧口径必须被 X5 抓住', 'X5 在宽松突变体上失败（漏传参放行）', () => {
    // 复刻用户用例：唯一差异 = allowSetVia 的宽松口径
    const chain = [node('root', null), node('f', 'root', { grants: [grant(L('lk1'), 'editor')] })];
    const via = { kind: 'link', id: 'lk1' }; // 漏传 passwordOk
    const strict = resolvePermissions({ id: 'u1', teamIds: [] }, chain, via, CTX);
    const loose = (() => {
      // 用宽松 allowSetVia 复算（其他逻辑与参考实现一致）
      const teams = new Set();
      let granted = new Set();
      let allowed = new Set(CAPS);
      for (const n of chain) {
        for (const g of n.grants ?? []) if (subjectMatches({ id: 'u1', teamIds: [] }, via, g.subject, teams)) unionInto(granted, capabilitiesOf(g.role));
        allowed = intersect(allowed, allowSet(n.policyCap.maxRole));
      }
      return intersect(intersect(granted, allowed), allowSetViaLoose(via));
    })();
    const ok = strict.size === 0 && loose.size > 0;
    return {
      ok,
      actual: `严格=${strict.size}（应为0） 宽松=${loose.size}（应>0）`,
      severity: 'P0',
      evidence: '两者不等 ⇒ X5 能区分 D1 定稿口径与旧口径',
    };
  });
}

/* =========================================================================
 * 6. PRD v0.4 剩余偏差（**QA 只报不改**；均为 PRD 内部不一致）
 * ========================================================================= */

const REMAINING_DEVIATIONS = [
  ['R1', 'D1 未落到 §12.2', '§12.2 `ShareVia` 仍为 `passwordOk?: boolean`（可选，L835）', '与 D1"必需 boolean"冲突；§4.4/约束④/§4.4.1/用例 8/20 已一致，唯契约草案未同步 → typecheck 无法暴露漏传'],
  ['R2', 'D2 未落到 §12.2', '§12.2 `ShareCapability` 仍只有 10 项（L814–816，缺 transferOwnership）', '与 §4.4.1 表 11 项冲突 → 契约一旦照抄即 typecheck 红'],
  ['R3', 'D3 未落到 §12.2', '§12.2 `linkPolicy` 仍保留 `role: ShareRole`（L852）', '与"删除 linkPolicy.role、授权只走 grants"冲突 → 双事实源回归风险（铁律 1.1）'],
  ['R4', 'D6 未落到 §12.2', '§12.2 `resolvePermissions(user, chain, via)` / `resolveAccess(...)` 均无 `ctx`；全文无 `ResolveContext` 类型定义', '与 D6"第 4 必需入参"冲突；工程照 §12.2 签名会丢失 expiresAt 判定与解散团队判定'],
  ['R5', 'D1 旧口径残留', '§12.2 `allowSetVia` 注释仍写 "link 且 passwordOk===false → ∅"（L865）', '与全文统一口径 `!== true ⇒ ∅` 冲突'],
  ['R6', 'D5 未落到 §12.2', '§12.2 `buildChain` 注释仍写"断链实现二选一 A/B"（L908–913）', '与 D5"写死方案 B"冲突；工程可能选 A 而签名无处放 detachIndex'],
  ['R7', 'D6 派生不一致', '§12.2 `subjectMatches(user, via, subject)` 3 参（L868）vs §4.4 伪码 `subjectMatches(user, via, g.subject, teams)` 4 参（L274/277）', '有效团队集合无入参位置；需补 `teams: ReadonlySet<string>` 或 `ctx`'],
  ['R8', '计数过期', '§9.1 CS-P0-7 仍写"§4.4 用例表 25 条""§4.4 五条 P0 约束"；§11 风险清单同（L711/L775）', '应为 **29 条** 与 **六条**（§4.4 正文已是六条）；验收口径与正文不一致'],
  ['R9', '【v0.4 新引入】linkPolicy 无 link 身份', 'D3 删 `role` 后 `linkPolicy` 只剩 scope/password/expiresAt/deny，**没有 linkId**；§4.4 伪码 `linkMatches(node, via)` 未定义（L267）', '同一文件多条链接（不同有效期/禁项）无法区分约束归属；建议 `linkPolicies?: Record<linkId, LinkPolicy>` 或补 `linkPolicy.id`'],
  ['R10', '变更说明与用例表编号错位', '修订说明（L44）写"28 已解散团队"，但用例表 28 是公网链接 Q11；已解散团队实为用例 13', '变更记录与实际用例表不一致，易导致工程漏测 Q11'],
];

/* =========================================================================
 * 7. 输出
 * ========================================================================= */

function main() {
  runCases();
  runExtras();
  runMutationControl();

  // 门禁自检：可注入一条必失败断言，验证退出码 2 语义（不影响正常跑）
  if (process.env.SHARING_SCAN_FORCE_FAIL === '1') {
    runCase('SELFTEST', '门禁自检：强制注入失败断言', '本项必失败，用于验证退出码 2', () => ({
      ok: false, actual: 'SHARING_SCAN_FORCE_FAIL=1', severity: 'P0',
    }));
  }

  const pass = RESULTS.filter((r) => r.pass).length;
  const fail = RESULTS.length - pass;
  const p0 = RESULTS.filter((r) => !r.pass && r.severity === 'P0').length;
  const p1 = RESULTS.filter((r) => !r.pass && r.severity === 'P1').length;

  console.log('=== 云共享权限/合并 契约级反证基线（PRD v0.4 契约定稿）===');
  console.log(`环境：${process.platform} / Node ${process.version}`);
  console.log('参考模型：内置（scripts/sharing-merge-scan.mjs），非产品源码');
  console.log('覆盖：§4.4 用例表 1–29 + X1–X5 追加反证 + MUT1–MUT4 突变控制\n');

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

  console.log('\n--- PRD v0.4 剩余偏差（QA 只报不改，需产品收敛）---');
  for (const [id, title, where, need] of REMAINING_DEVIATIONS) {
    console.log(`[${id}] ${title}`);
    console.log(`    位置：${where}`);
    console.log(`    影响：${need}`);
  }

  console.log('\n--- ADAPTER（工程落地后如何复用）---');
  console.log('1) 把本文件 `resolvePermissions` / `resolveAccess` / `buildChain` / `allowSetVia` /');
  console.log('   `capabilitiesOf` / `subjectMatches` 换成 `packages/core/src/contracts/sharing.ts` 的实现；');
  console.log('2) 删除本文件的参考模型段（§1、§3 构造工具中的实现部分），断言与构造工具原样保留；');
  console.log('3) 用例 1–29 的期望值无需改动；X1–X5 为门禁追加项，MUT1–MUT4 为断言有效性证明。');

  console.log(fail === 0 ? '\n✅ 基线全绿（契约可实现且无越权）' : `\n❌ 基线失败（P0=${p0}，P1=${p1}）`);
  process.exit(fail === 0 ? 0 : 2);
}

main();
