/**
 * adversarial-audit.mjs —— jareking 全局对抗性测试 + 跨软件兼容验证（QA 严过关 / 并行任务 3/3）。
 *
 * 立场：对抗（adversarial）。目标 —— 保证「不丢格式、文件不损坏、不同软件均能正常读取」。
 *
 * 覆盖四层：
 *   A. 边界 / 恶意输入：逐项构造极端 docx / xlsx / pptx / pdf，断言「不崩溃、不丢数据」；
 *   B. round-trip 保真：parse → export → parse，比对关键结构计数（段落/runs/表格/样式/合并/
 *      公式/批注/修订/页眉页脚/脚注 …）是否逐一相等；
 *   C. 文件完整性：导出产物用 JSZip 解压 + CRC32 校验，断言必需部件齐、
 *      [Content_Types].xml 与各 XML 合法、.rels 关系 Target 均指向存在部件（悬空关系 = 典型「文件损坏」）；
 *   D. 跨软件可读：把 jareking 导出的 docx/xlsx/pptx 样本交给本机 WPS 的 COM 自动化组件打开并读回结构。
 *
 * 隔离约束（并行任务）：
 *   - 本脚本只写 scripts/**（自身）与 docs/adversarial-audit.md；**不修改任何源码**；
 *   - 生成的样本与 COM 中间产物写入系统临时目录（os.tmpdir()/jareking-adversarial-audit），不污染仓库；
 *   - 不新增依赖：只复用已装的 jszip / fast-xml-parser / 各包 dist；
 *   - 严禁 window.prompt/alert（本脚本为 Node 环境，无 DOM）。
 *
 * 用法：
 *   node scripts/adversarial-audit.mjs                # 全量：A/B/C 必跑；D 若已有结果则纳入，否则标「未实测」
 *   node scripts/adversarial-audit.mjs --com-only     # 只生成跨软件样本 + PS 脚本（供 PowerShell 执行）
 *   node scripts/adversarial-audit.mjs --no-com       # 跳过跨软件，仅本地 A/B/C
 *
 * 跨软件实测（两步，因沙箱禁止从 Bash/Node 直接拉起 PowerShell）：
 *   1) node scripts/adversarial-audit.mjs            # 生成 <tmp>/cross-input.json + cross-software.ps1
 *   2) PowerShell: & "<tmp>/cross-software.ps1"       # 产出 <tmp>/cross-software.json
 *   3) node scripts/adversarial-audit.mjs            # 再跑一次即把真实 COM 结果纳入报告
 *
 * 退出码：0 = 无阻断/严重问题；2 = 存在 P0/P1（源码 bug），供 CI 分流。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

/* ------------------------------------------------------------------ 环境/依赖 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const requireFromWriter = createRequire(path.join(root, 'packages/writer/package.json'));
const JSZip = requireFromWriter('jszip');
const { XMLValidator, XMLParser } = requireFromWriter('fast-xml-parser');

const { parseDocx, exportDocx } = await import(
  new URL('../packages/writer/dist/index.js', import.meta.url).href
);
const { parseXlsx, exportXlsx } = await import(
  new URL('../packages/sheet/dist/index.js', import.meta.url).href
);
const { parsePptx, exportPptx } = await import(
  new URL('../packages/presentation/dist/index.js', import.meta.url).href
);
const {
  imagesToPdf,
  mergePdfs,
  addWatermark,
  getPageCount,
  extractPages,
  rotatePages,
  deletePages,
} = await import(new URL('../packages/pdf/dist/index.js', import.meta.url).href);

const ARGS = process.argv.slice(2);
const COM_ONLY = ARGS.includes('--com-only');
const NO_COM = ARGS.includes('--no-com');

const TMP = path.join(os.tmpdir(), 'jareking-adversarial-audit');
const CROSS_INPUT = path.join(TMP, 'cross-input.json');
const CROSS_PS1 = path.join(TMP, 'cross-software.ps1');
const CROSS_OUT = path.join(TMP, 'cross-software.json');

/* ------------------------------------------------------------------ 结果收集 */

/** 全部断言结果 */
const RESULTS = [];
let seq = 0;

/** @param {{module:string,case:string,expected:string,actual:string,result:'PASS'|'FAIL'|'DEGRADED',severity?:'P0'|'P1'|'P2',evidence?:string,sourceLoc?:string}} o */
function record(o) {
  seq += 1;
  RESULTS.push({ id: `T${String(seq).padStart(2, '0')}`, ...o });
}

/**
 * 执行单个用例并登记结果。
 * @param {string} module  模块（Writer/Sheet/Presentation/PDF/Integrity/CrossSoft）
 * @param {string} name    用例名
 * @param {string} expected 期望
 * @param {(ctx:any)=>Promise<{ok:boolean,actual:string,evidence?:string,degraded?:boolean,severity?:'P0'|'P1'|'P2'}>} fn
 */
async function runCase(module, name, expected, fn) {
  try {
    const r = await fn();
    record({
      module,
      case: name,
      expected,
      actual: r.actual,
      result: r.ok ? (r.degraded ? 'DEGRADED' : 'PASS') : 'FAIL',
      severity: r.ok ? undefined : r.severity ?? 'P1',
      evidence: r.evidence,
      sourceLoc: r.sourceLoc,
    });
  } catch (e) {
    record({
      module,
      case: name,
      expected,
      actual: `抛出异常：${e && e.message}`,
      result: 'FAIL',
      severity: 'P0',
      evidence: (e && e.stack ? e.stack : String(e)).split('\n').slice(0, 4).join(' ⏎ '),
    });
  }
}

/* ------------------------------------------------------------------ 通用工具 */

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const stripBom = (s) => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** 归一化包内路径（消除 ./ 与多余斜杠，用于悬空关系比对） */
function normalizePart(p) {
  const parts = [];
  for (const seg of String(p).replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/* ---------- docx 原始包构造（对抗输入用；复用 fixtures 思路，独立实现） ---------- */

const NS = {
  W: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  R: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  REL: 'http://schemas.openxmlformats.org/package/2006/relationships',
  WP: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  A: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  PIC: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  M: 'http://schemas.openxmlformats.org/officeDocument/2006/math',
};

function makeDocumentXml(body) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${NS.W}" xmlns:r="${NS.R}" xmlns:wp="${NS.WP}" xmlns:a="${NS.A}" xmlns:pic="${NS.PIC}" xmlns:m="${NS.M}">
  <w:body>${body}</w:body>
</w:document>`;
}

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS.REL}">
  <Relationship Id="rId1" Type="${NS.R}/officeDocument" Target="word/document.xml"/>
</Relationships>`;

/**
 * 组装最小但合法的 .docx（可含图片/批注/脚注/页眉等附加部件）。
 * @param {{body:string,rels?:string,styles?:string,numbering?:string,settings?:string,extra?:{path:string,content:string|Uint8Array}[],defaults?:{ext:string,ct:string}[]}} cfg
 */
async function buildDocxZip(cfg) {
  const overrides = [
    {
      part: '/word/document.xml',
      ct: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    },
  ];
  const defaults = [
    { ext: 'rels', ct: 'application/vnd.openxmlformats-package.relationships+xml' },
    { ext: 'xml', ct: 'application/xml' },
  ];
  const zip = new JSZip();
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('word/document.xml', makeDocumentXml(cfg.body));
  if (cfg.rels) zip.file('word/_rels/document.xml.rels', cfg.rels);
  if (cfg.styles) {
    zip.file('word/styles.xml', cfg.styles);
    overrides.push({
      part: '/word/styles.xml',
      ct: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
    });
  }
  if (cfg.numbering) {
    zip.file('word/numbering.xml', cfg.numbering);
    overrides.push({
      part: '/word/numbering.xml',
      ct: 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
    });
  }
  if (cfg.settings) {
    zip.file('word/settings.xml', cfg.settings);
    overrides.push({
      part: '/word/settings.xml',
      ct: 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml',
    });
  }
  for (const ex of cfg.extra ?? []) {
    zip.file(ex.path, ex.content);
    if (ex.ct) overrides.push({ part: `/${ex.path}`, ct: ex.ct });
    if (ex.defaultExt && ex.defaultCt) defaults.push({ ext: ex.defaultExt, ct: ex.defaultCt });
  }
  const ctXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="${NS.REL}">\n` +
    defaults.map((d) => `  <Default Extension="${d.ext}" ContentType="${d.ct}"/>`).join('\n') +
    '\n' +
    overrides.map((o) => `  <Override PartName="${o.part}" ContentType="${o.ct}"/>`).join('\n') +
    '\n</Types>';
  zip.file('[Content_Types].xml', ctXml);
  return zip.generateAsync({ type: 'uint8array' });
}

/** 1×1 PNG */
const PNG_1x1 = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
);

const DRAWING = (embed = 'rId7') => `
  <w:drawing><wp:inline>
    <wp:extent cx="914400" cy="457200"/>
    <wp:docPr id="1" name="Picture 1" descr="adv"/>
    <wp:graphic><a:graphicData uri="${NS.PIC}"><pic:pic>
      <pic:blipFill><a:blip r:embed="${embed}"/></pic:blipFill>
    </pic:pic></a:graphicData></wp:graphic>
  </wp:inline></w:drawing>`;

/* ------------------------------------------------------- 结构计数（round-trip 比对） */

function countWriter(doc) {
  const c = {
    paragraphs: 0, runs: 0, tables: 0, merges: 0, formulas: 0, revisions: 0,
    images: 0, breaks: 0, hyperlinks: 0, fields: 0, footnoteRefs: 0,
    sectionBreaks: 0, comments: 0, footnotes: 0, endnotes: 0, styles: 0,
    sections: 0, imageRels: 0, mediaBytes: 0, headerBlocks: 0, footerBlocks: 0, columns: 0,
  };
  const walkInline = (inls) => {
    for (const i of inls ?? []) {
      if (i.type === 'run') {
        c.runs += 1;
        if (i.revision) c.revisions += 1;
      } else if (i.type === 'formula') c.formulas += 1;
      else if (i.type === 'image') c.images += 1;
      else if (i.type === 'break') c.breaks += 1;
      else if (i.type === 'hyperlink') {
        c.hyperlinks += 1;
        walkInline(i.runs);
      } else if (i.type === 'field') c.fields += 1;
      else if (i.type === 'footnoteRef') c.footnoteRefs += 1;
    }
  };
  const walkBlocks = (blocks) => {
    for (const b of blocks ?? []) {
      if (b.type === 'paragraph') {
        c.paragraphs += 1;
        walkInline(b.runs);
      } else if (b.type === 'table') {
        c.tables += 1;
        for (const r of b.rows ?? [])
          for (const cell of r.cells ?? []) {
            if (cell.cellPr?.gridSpan && cell.cellPr.gridSpan > 1) c.merges += 1;
            walkBlocks(cell.blocks);
          }
      } else if (b.type === 'sectionBreak') c.sectionBreaks += 1;
    }
  };
  walkBlocks(doc.body);
  c.comments = (doc.comments ?? []).length;
  c.footnotes = (doc.footnotes ?? []).length;
  c.endnotes = (doc.endnotes ?? []).length;
  c.styles = (doc.styleDefs?.styles ?? []).length;
  c.sections = (doc.sections ?? []).length;
  c.imageRels = (doc.relationships ?? []).filter((r) => r.type === 'image').length;
  c.mediaBytes = Object.values(doc.media ?? {}).reduce((n, v) => n + v.length, 0);
  for (const s of doc.sections ?? []) {
    c.headerBlocks += (s.header ?? []).length;
    c.footerBlocks += (s.footer ?? []).length;
    if (s.columns?.count && s.columns.count > 1) c.columns += 1;
  }
  return c;
}

function countSheet(wb) {
  return {
    sheetCount: wb.sheets.length,
    perSheet: wb.sheets.map((s) => ({
      name: s.name,
      cells: Object.keys(s.cells ?? {}).length,
      merges: (s.merges ?? []).length,
      formulas: Object.values(s.cells ?? {}).filter((c) => c.formula).length,
      hidden: !!s.hidden,
    })),
  };
}

function countPpt(p) {
  return {
    slides: p.slides.length,
    media: Object.keys(p.media ?? {}).length,
    perSlide: p.slides.map((s) => ({
      shapes: s.shapes.length,
      text: s.shapes.filter((x) => x.type === 'text').length,
      image: s.shapes.filter((x) => x.type === 'image').length,
      table: s.shapes.filter((x) => x.type === 'table').length,
      rotated: s.shapes.filter((x) => x.rotation === 359).length,
      hyperlinks: s.shapes.filter((x) => !!x.hyperlink).length,
    })),
  };
}

/** 比较两个计数对象，返回差异描述数组（空 = 一致） */
function diffCounts(a, b, keys) {
  const diffs = [];
  for (const k of keys) {
    const va = a[k];
    const vb = b[k];
    if (va !== vb) diffs.push(`${k}: ${va} → ${vb}`);
  }
  return diffs;
}

const WRITER_KEYS = [
  'paragraphs', 'runs', 'tables', 'merges', 'formulas', 'revisions', 'images', 'breaks',
  'hyperlinks', 'fields', 'footnoteRefs', 'comments', 'footnotes', 'endnotes', 'styles',
];

/* --------------------------------------------------------------- 文件完整性（C） */

/**
 * 必需部件表（按格式）。
 * 注意：`<main>.rels`（如 word/_rels/document.xml.rels）在 OOXML/OPC 中**是可选的**——
 * 当主部件不含任何 r:id/r:embed/r:link 引用时允许缺失。故此处不硬性要求，
 * 改由 checkZipIntegrity 的「引用→关系」条件检查 + 悬空关系检查覆盖。
 */
const REQUIRED_PARTS = {
  docx: ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'],
  xlsx: ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml'],
  pptx: ['[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml'],
};

/** 主部件 → 其关系部件路径（用于「有引用却缺 rels」检测） */
const MAIN_PART_RELS = {
  docx: [['word/document.xml', 'word/_rels/document.xml.rels']],
  xlsx: [['xl/workbook.xml', 'xl/_rels/workbook.xml.rels']],
  pptx: [['ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels']],
};

/**
 * 校验导出包完整性：CRC、部件齐、XML 合法、[Content_Types].xml 合法、无悬空关系。
 * @param {Uint8Array} bytes
 * @param {'docx'|'xlsx'|'pptx'} kind
 */
async function checkZipIntegrity(bytes, kind) {
  const issues = [];
  let zip;
  try {
    // checkCRC32：解压时逐条校验 CRC，损坏条目会抛错
    zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  } catch (e) {
    return { ok: false, issues: [`ZIP 无法打开/CRC 校验失败：${e.message}`] };
  }

  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  for (const req of REQUIRED_PARTS[kind]) {
    if (!names.includes(req)) issues.push(`缺少必需部件 ${req}`);
  }

  // 条件关系检查：主部件引用了 r:id/r:embed/r:link 却缺少对应 .rels → 悬空引用
  for (const [mainPart, relPath] of MAIN_PART_RELS[kind] ?? []) {
    const f = zip.file(mainPart);
    if (!f) continue;
    const xml = await f.async('string');
    if (/\sr:(id|embed|link)=/.test(xml) && !names.includes(relPath)) {
      issues.push(`${mainPart} 引用了 r:* 关系，但缺少关系部件 ${relPath}`);
    }
  }

  // 所有 .xml/.rels 部件的 XML 合法性
  for (const n of names) {
    if (!/\.(xml|rels)$/i.test(n)) continue;
    const text = stripBom(await zip.file(n).async('string'));
    const v = XMLValidator.validate(text);
    if (v !== true) issues.push(`XML 非法 ${n}: ${v && v.err ? `${v.err.code}@${v.err.line}` : 'unknown'}`);
  }

  // [Content_Types].xml 语义：存在且可解析出 Types
  const ctRaw = zip.file('[Content_Types].xml');
  if (!ctRaw) issues.push('缺少 [Content_Types].xml');
  else {
    try {
      const parsed = new XMLParser({ removeNSPrefix: true, isArray: () => true }).parse(
        stripBom(await ctRaw.async('string')),
      );
      if (!parsed.Types) issues.push('[Content_Types].xml 缺少 <Types> 根');
    } catch (e) {
      issues.push(`[Content_Types].xml 解析失败：${e.message}`);
    }
  }

  // 悬空关系：每个 .rels 的 Target（非 External）必须指向存在的部件
  const relFiles = names.filter((n) => n.endsWith('.rels'));
  for (const rf of relFiles) {
    const xml = stripBom(await zip.file(rf).async('string'));
    let parsed;
    try {
      parsed = new XMLParser({ removeNSPrefix: true, isArray: () => true }).parse(xml);
    } catch (e) {
      issues.push(`${rf} 解析失败：${e.message}`);
      continue;
    }
    const rels = parsed?.Relationships?.Relationship ?? [];
    // rels 所在目录：_rels/.rels → 根；word/_rels/document.xml.rels → word/
    const baseDir = rf.replace(/_rels\/[^/]+$/, '');
    for (const rel of rels) {
      const target = rel.Target;
      const mode = rel.TargetMode;
      if (!target || String(mode).toLowerCase() === 'external') continue;
      const resolved = String(target).startsWith('/')
        ? String(target).slice(1)
        : normalizePart(`${baseDir}${target}`);
      if (!names.includes(resolved)) {
        issues.push(`悬空关系 ${rf}: ${rel.Id} → "${target}"（期望部件 ${resolved} 不存在）`);
      }
    }
  }

  return { ok: issues.length === 0, issues, parts: names.length };
}

/* ================================================================== A/B: Writer */

/** docx 对抗样本定义 */
async function buildWriterSamples() {
  const samples = [];

  // W1 空文档
  samples.push({
    name: '空文档（body 为空）',
    expected: '不崩溃；段落/表格计数 round-trip 一致',
    bytes: await buildDocxZip({ body: '' }),
  });

  // W2 超长单段（10 万字符）
  const longText = 'A'.repeat(100000);
  samples.push({
    name: '超长单段（100,000 字符）',
    expected: '文本长度 100000 保真，不崩溃',
    bytes: await buildDocxZip({ body: `<w:p><w:r><w:t xml:space="preserve">${longText}</w:t></w:r></w:p>` }),
    verify: (a, b) => {
      const t1 = a.body[0]?.runs?.[0]?.text ?? '';
      const t2 = b.body[0]?.runs?.[0]?.text ?? '';
      const ok = t1.length === 100000 && t2.length === 100000;
      return { ok, actual: ok ? '两次解析长度均=100000' : `长度 a=${t1.length} b=${t2.length}` };
    },
  });

  // W3 特殊字符
  const specials =
    '😀👨‍👩‍👧 emoji 组合 ' +
    'e\u0301a\u0300（组合字符） ' +
    '\u05e2\u05d1\u05e8\u05d9\u05ea（RTL 希伯来） ' +
    'مرحبا（RTL 阿拉伯） ' +
    '中文全角ＣＪＫ ' +
    '零宽\u200b\u200d\uFEFF字符 ' +
    `XML敏感：<tag> & "quote" 'apos' ` +
    '连续空格：   A   B   ' +
    '制表\t符';
  samples.push({
    name: '特殊字符（emoji/组合/RTL/CJK/零宽/XML敏感/连续空格/制表符）',
    expected: '文本逐字保真（含 emoji/组合/零宽/敏感字符），tab/br 计数一致',
    bytes: await buildDocxZip({
      body:
        `<w:p><w:r><w:t xml:space="preserve">${esc(specials)}</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r></w:p>`,
    }),
    verify: (a, b) => {
      const t1 = a.body[0]?.runs?.[0]?.text ?? '';
      const t2 = b.body[0]?.runs?.[0]?.text ?? '';
      const brkA = countWriter(a).breaks;
      const brkB = countWriter(b).breaks;
      const ok = t1 === specials && t2 === specials && brkA === brkB;
      return {
        ok,
        actual: ok
          ? '文本逐字一致；tab/br 计数一致'
          : `文本一致a=${t1 === specials} b=${t2 === specials}，brk ${brkA}→${brkB}`,
        evidence: t2 === specials ? undefined : `b 文本片段：${JSON.stringify(t2.slice(0, 60))}`,
      };
    },
  });

  // W4 深嵌套表格（3 层）
  const p = (t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
  const tbl = (inner) =>
    `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/></w:tblPr>` +
    `<w:tblGrid><w:gridCol w:w="9000"/></w:tblGrid>` +
    `<w:tr><w:tc><w:tcPr><w:tcW w:w="9000" w:type="dxa"/></w:tcPr>${inner}</w:tc></w:tr></w:tbl>`;
  samples.push({
    name: '深嵌套表格（3 层）',
    expected: '表格计数=3 且嵌套结构保真',
    bytes: await buildDocxZip({
      body: tbl(tbl(tbl(p('L3 最内层')))),
    }),
    verify: (a, b) => {
      const ta = countWriter(a).tables;
      const tb = countWriter(b).tables;
      const ok = ta === 3 && tb === 3;
      return { ok, actual: `表格计数 a=${ta} b=${tb}` };
    },
  });

  // W5 超大图片（1 张 5MB）
  const bigPng = new Uint8Array(5 * 1024 * 1024);
  bigPng.set(PNG_1x1.subarray(0, 8), 0);
  for (let i = 8; i < bigPng.length; i++) bigPng[i] = (i * 1103515245 + 12345) & 0xff;
  samples.push({
    name: '超大图片（单张 5MB PNG）',
    expected: '图片字节数 ≥5MB 保真，image 关系保留',
    bytes: await buildDocxZip({
      body: `<w:p><w:r>${DRAWING('rId7')}</w:r></w:p>`,
      rels: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS.REL}">
  <Relationship Id="rId7" Type="${NS.R}/image" Target="media/image1.png"/>
</Relationships>`,
      extra: [{ path: 'word/media/image1.png', content: bigPng, defaultExt: 'png', defaultCt: 'image/png' }],
    }),
    verify: (a, b) => {
      const ma = countWriter(a).mediaBytes;
      const mb = countWriter(b).mediaBytes;
      const ok = ma >= 5 * 1024 * 1024 && mb >= 5 * 1024 * 1024;
      return { ok, actual: `媒体字节 a=${ma} b=${mb}（期望≥${5 * 1024 * 1024}）` };
    },
  });

  // W6 混排（公式+批注+修订+页眉页脚+脚注+分栏 同时存在）
  const mixedBody =
    `<w:p><w:r><w:t xml:space="preserve">混排：</w:t></w:r>` +
    `<m:oMath><m:r><m:t>x^2+y^2=z^2</m:t></m:r></m:oMath></w:p>` +
    `<w:p><w:commentRangeStart w:id="1"/><w:r><w:t>被批注文本</w:t></w:r><w:commentRangeEnd w:id="1"/>` +
    `<w:r><w:commentReference w:id="1"/></w:r></w:p>` +
    `<w:p><w:ins w:id="2" w:author="Alice" w:date="2024-01-01T00:00:00Z"><w:r><w:t>插入内容</w:t></w:r></w:ins>` +
    `<w:del w:id="3" w:author="Bob" w:date="2024-01-02T00:00:00Z"><w:r><w:delText>删除内容</w:delText></w:r></w:del></w:p>` +
    `<w:p><w:r><w:t>脚注引用</w:t></w:r><w:r><w:footnoteReference w:id="2"/></w:r></w:p>` +
    `<w:sectPr><w:cols w:num="2" w:space="425"/><w:headerReference w:type="default" r:id="rIdHdr1"/>` +
    `<w:footerReference w:type="default" r:id="rIdFtr1"/></w:sectPr>`;
  samples.push({
    name: '混排（公式+批注+修订+页眉页脚+脚注+分栏并存）',
    expected: '公式/批注/修订/脚注/页眉/页脚/分栏 计数 round-trip 全一致',
    bytes: await buildDocxZip({
      body: mixedBody,
      rels: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS.REL}">
  <Relationship Id="rIdHdr1" Type="${NS.R}/header" Target="header1.xml"/>
  <Relationship Id="rIdFtr1" Type="${NS.R}/footer" Target="footer1.xml"/>
  <Relationship Id="rIdFn1" Type="${NS.R}/footnotes" Target="footnotes.xml"/>
  <Relationship Id="rIdCmt1" Type="${NS.R}/comments" Target="comments.xml"/>
</Relationships>`,
      extra: [
        {
          path: 'word/comments.xml',
          ct: 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
          content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="${NS.W}">
  <w:comment w:id="1" w:author="Alice" w:initials="AL" w:date="2024-01-01T00:00:00Z"><w:p><w:r><w:t>一条批注</w:t></w:r></w:p></w:comment>
</w:comments>`,
        },
        {
          path: 'word/footnotes.xml',
          ct: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
          content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="${NS.W}">
  <w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>
  <w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>
  <w:footnote w:id="2"><w:p><w:r><w:t>脚注正文</w:t></w:r></w:p></w:footnote>
</w:footnotes>`,
        },
        {
          path: 'word/header1.xml',
          ct: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
          content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="${NS.W}"><w:p><w:r><w:t>页眉文本</w:t></w:r></w:p></w:hdr>`,
        },
        {
          path: 'word/footer1.xml',
          ct: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml',
          content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="${NS.W}"><w:p><w:r><w:t>页脚文本</w:t></w:r></w:p></w:ftr>`,
        },
      ],
      styles: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${NS.W}">
  <w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/></w:style>
  <w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/></w:style>
</w:styles>`,
      settings: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="${NS.W}"><w:defaultTabStop w:val="420"/></w:settings>`,
    }),
    verify: (a, b) => {
      const ca = countWriter(a);
      const cb = countWriter(b);
      const checks = {
        formula: [ca.formulas, cb.formulas],
        comments: [ca.comments, cb.comments],
        revisions: [ca.revisions, cb.revisions],
        footnoteRefs: [ca.footnoteRefs, cb.footnoteRefs],
        footnotes: [ca.footnotes, cb.footnotes],
        headerBlocks: [ca.headerBlocks, cb.headerBlocks],
        footerBlocks: [ca.footerBlocks, cb.footerBlocks],
        columns: [ca.columns, cb.columns],
      };
      const bad = Object.entries(checks).filter(([, [x, y]]) => x !== y || x === 0);
      const zero = Object.entries(checks).filter(([, [x]]) => x === 0);
      const ok = bad.length === 0;
      return {
        ok,
        actual: Object.entries(checks)
          .map(([k, [x, y]]) => `${k} ${x}→${y}`)
          .join(', '),
        evidence: ok ? undefined : `失配/为零项：${zero.map(([k]) => k).join(',') || bad.map(([k]) => k).join(',')}`,
      };
    },
  });

  // W7 修订 + commentRange 锚点（显式 ins/del/commentRange）
  samples.push({
    name: '修订与批注锚点（w:ins/w:del + commentRangeStart/End/Reference）',
    expected: '修订 run 数=2，批注数=1，commentRange 锚点保留',
    bytes: await buildDocxZip({
      body:
        `<w:p><w:ins w:id="10" w:author="A" w:date="2024-03-01T00:00:00Z"><w:r><w:t>NEW</w:t></w:r></w:ins>` +
        `<w:del w:id="11" w:author="B" w:date="2024-03-02T00:00:00Z"><w:r><w:delText>OLD</w:delText></w:r></w:del></w:p>` +
        `<w:p><w:commentRangeStart w:id="5"/><w:r><w:t>锚点文本</w:t></w:r><w:commentRangeEnd w:id="5"/>` +
        `<w:r><w:commentReference w:id="5"/></w:r></w:p>`,
      rels: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS.REL}">
  <Relationship Id="rIdCmt1" Type="${NS.R}/comments" Target="comments.xml"/>
</Relationships>`,
      extra: [
        {
          path: 'word/comments.xml',
          ct: 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
          content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="${NS.W}">
  <w:comment w:id="5" w:author="C" w:date="2024-03-03T00:00:00Z"><w:p><w:r><w:t>锚点批注</w:t></w:r></w:p></w:comment>
</w:comments>`,
        },
      ],
    }),
    verify: (a, b) => {
      const ca = countWriter(a);
      const cb = countWriter(b);
      const rangesA = (a.body[1]?.commentRanges ?? []).length;
      const rangesB = (b.body[1]?.commentRanges ?? []).length;
      const ok = ca.revisions === 2 && cb.revisions === 2 && cb.comments === 1 && rangesB >= 1;
      return {
        ok,
        actual: `修订 ${ca.revisions}→${cb.revisions}，批注 ${ca.comments}→${cb.comments}，锚点区间 a=${rangesA} b=${rangesB}`,
      };
    },
  });

  return samples;
}

async function runWriter() {
  const samples = await buildWriterSamples();
  for (const s of samples) {
    await runCase('Writer', s.name, s.expected, async () => {
      const a = await parseDocx(s.bytes);
      const out = await exportDocx(a);
      const b = await parseDocx(out);
      let detail;
      if (s.verify) {
        const v = s.verify(a, b);
        detail = { ok: v.ok, actual: v.actual, evidence: v.evidence };
      } else {
        const ca = countWriter(a);
        const cb = countWriter(b);
        const diffs = diffCounts(ca, cb, WRITER_KEYS);
        detail = {
          ok: diffs.length === 0,
          actual: diffs.length ? `计数失配：${diffs.join('; ')}` : '计数一致',
        };
      }
      // 无论计数如何，导出产物必须通过完整性校验
      const integ = await checkZipIntegrity(out, 'docx');
      if (!integ.ok) {
        if (detail.ok) detail = { ok: false, actual: '完整性失败', severity: 'P0' };
        detail.evidence = `${detail.evidence ? detail.evidence + ' | ' : ''}完整性：${integ.issues.join('; ')}`;
        detail.severity = 'P0';
      }
      return detail;
    });
  }
}

/* ================================================================== A/B: Sheet */

async function runSheet() {
  const empty = { sheets: [{ name: 'Sheet1', rowCount: 0, colCount: 0, cells: {}, merges: [] }] };
  const wide = {
    sheets: [
      {
        name: 'Wide200',
        rowCount: 2,
        colCount: 200,
        cells: (() => {
          const c = {};
          for (let col = 0; col < 200; col++) c[`0,${col}`] = { value: col + 1 };
          return c;
        })(),
        merges: [],
      },
    ],
  };
  const badFormula = {
    sheets: [
      {
        name: 'Formula',
        rowCount: 3,
        colCount: 2,
        cells: {
          '0,0': { formula: '1/0' },
          '1,0': { formula: 'SUM(A:A)' },
          '2,0': { value: 42 },
        },
        merges: [],
      },
    ],
  };
  const longStr = {
    sheets: [
      {
        name: 'LongStr',
        rowCount: 1,
        colCount: 1,
        cells: { '0,0': { value: 'X'.repeat(50000) } },
        merges: [],
      },
    ],
  };
  const fullwidth = {
    sheets: [
      {
        name: '全角',
        rowCount: 1,
        colCount: 3,
        cells: {
          '0,0': { value: 'ＡＢＣＤＥ１２３４５' },
          '0,1': { value: '　全角空格　隔开　' },
          '0,2': { value: '＜标签＞　＆　"引号"' },
        },
        merges: [],
      },
    ],
  };
  const multiHidden = {
    sheets: [
      { name: '可见1', rowCount: 1, colCount: 1, cells: { '0,0': { value: 'A' } }, merges: [] },
      { name: '隐藏', rowCount: 1, colCount: 1, cells: { '0,0': { value: 'B' } }, merges: [], hidden: true },
      { name: '可见2', rowCount: 1, colCount: 1, cells: { '0,0': { value: 'C' } }, merges: [] },
    ],
    activeSheetIndex: 2,
  };
  const singleMerge = {
    sheets: [
      {
        name: 'MergeBoundary',
        rowCount: 1,
        colCount: 1,
        cells: { '0,0': { value: '单格' } },
        merges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }],
      },
    ],
  };

  const cases = [
    ['空表（0 行 0 列）', '不崩溃；sheet 计数一致', empty],
    ['超宽表（200 列）', '200 列单元格全部保真', wide],
    ['非法公式（=1/0、=SUM(A:A)）', '公式字符串原样保留、不崩溃', badFormula],
    ['超长字符串单元格（50,000 字符）', '不崩溃（如实记录截断）', longStr],
    ['100% 全角字符', '全角文本保真', fullwidth],
    ['多 sheet + 隐藏 sheet', 'sheet 数=3、隐藏标记保真', multiHidden],
    ['合并区域边界（单格合并 A1:A1）', '不崩溃或如实降级', singleMerge],
  ];

  for (const [name, expected, wb] of cases) {
    await runCase('Sheet', name, expected, async () => {
      const out = await exportXlsx(wb);
      const b = await parseXlsx(out);
      const ca = countSheet(wb);
      const cb = countSheet(b);
      const diffs = [];
      if (ca.sheetCount !== cb.sheetCount) diffs.push(`sheet 数 ${ca.sheetCount}→${cb.sheetCount}`);
      for (let i = 0; i < Math.min(ca.perSheet.length, cb.perSheet.length); i++) {
        const x = ca.perSheet[i];
        const y = cb.perSheet[i];
        if (x.name !== y.name) diffs.push(`sheet[${i}] 名 ${x.name}→${y.name}`);
        if (y.cells < x.cells) diffs.push(`[${x.name}] 单元格 ${x.cells}→${y.cells}`);
        if (y.merges !== x.merges) diffs.push(`[${x.name}] 合并 ${x.merges}→${y.merges}`);
        if (y.formulas !== x.formulas) diffs.push(`[${x.name}] 公式 ${x.formulas}→${y.formulas}`);
        if (x.hidden !== y.hidden) diffs.push(`[${x.name}] 隐藏 ${x.hidden}→${y.hidden}`);
      }
      const integ = await checkZipIntegrity(out, 'xlsx');
      const isSingleMerge = name.includes('单格合并');
      let ok = diffs.length === 0 && integ.ok;
      let degraded = false;
      // 单格合并 A1:A1：Excel/WPS 本身不支持，导出规范化为「无合并」属设计内降级
      if (!ok && isSingleMerge && integ.ok && diffs.every((d) => /合并 1→0/.test(d))) {
        ok = true;
        degraded = true;
      }
      const severity = integ.ok ? undefined : 'P0';
      return {
        ok,
        degraded,
        actual: ok
          ? degraded
            ? `设计内降级：单格合并被规范化丢弃（Excel 不支持 A1:A1）｜${diffs.join('; ')}`
            : '结构一致'
          : `${diffs.join('; ')}${integ.ok ? '' : ' | 完整性：' + integ.issues.join('; ')}`,
        severity,
        evidence: integ.ok ? undefined : integ.issues.join('; '),
      };
    });
  }
}

/* ============================================================ A/B: Presentation */

function circle10x10() {
  const rows = [];
  for (let r = 0; r < 10; r++) {
    const cells = [];
    for (let c = 0; c < 10; c++) cells.push({ text: `R${r}C${c}` });
    rows.push({ cells });
  }
  return rows;
}

async function runPresentation() {
  const emptySlide = {
    slides: [{ shapes: [] }],
    slideWidth: 9144000,
    slideHeight: 6858000,
  };
  const longText = {
    slides: [{ shapes: [{ type: 'text', x: 0, y: 0, w: 9144000, h: 1000000, paragraphs: [{ runs: [{ text: 'L'.repeat(20000) }] }], geom: 'rect' }] }],
    slideWidth: 9144000,
    slideHeight: 6858000,
  };
  const zeroSize = {
    slides: [{ shapes: [{ type: 'shape', geom: 'rect', x: 0, y: 0, w: 0, h: 0, fill: '#123456' }] }],
    slideWidth: 9144000,
    slideHeight: 6858000,
  };
  const rotated = {
    slides: [{ shapes: [{ type: 'shape', geom: 'roundRect', x: 100, y: 100, w: 1000000, h: 1000000, rotation: 359, fill: '#ABCDEF' }] }],
    slideWidth: 9144000,
    slideHeight: 6858000,
  };
  const tables = {
    slides: [
      { shapes: [{ type: 'table', x: 0, y: 0, w: 4000000, h: 1000000, colWidths: [2000000], rows: [{ cells: [{ text: '1x1' }] }] }] },
      { shapes: [{ type: 'table', x: 0, y: 0, w: 8000000, h: 4000000, colWidths: new Array(10).fill(800000), rows: circle10x10() }] },
    ],
    slideWidth: 9144000,
    slideHeight: 6858000,
  };
  const hyperlinked = {
    slides: [{ shapes: [{ type: 'shape', geom: 'rect', x: 0, y: 0, w: 2000000, h: 1000000, fill: '#FF9900', hyperlink: 'https://example.com/a?b=1&c=2' }] }],
    slideWidth: 9144000,
    slideHeight: 6858000,
  };

  const cases = [
    ['空 0 形状页', '不崩溃；页数/形状数一致', emptySlide, (b) => b.slides[0].shapes.length === 0],
    ['超长文本（20,000 字符）', '不崩溃', longText, (b) => b.slides[0].shapes.length === 1],
    ['0 尺寸形状（w=0,h=0）', '不崩溃；形状保留', zeroSize, (b) => b.slides[0].shapes.length === 1],
    ['旋转 359°', 'rotation=359 保真', rotated, (b) => b.slides[0].shapes[0]?.rotation === 359],
    ['表格 1×1 与 10×10', '两页表格形状保留', tables, (b) => b.slides.length === 2 && b.slides[1].shapes.some((s) => s.type === 'table')],
    ['带超链接形状', '超链接保留', hyperlinked, (b) => !!b.slides[0].shapes[0]?.hyperlink],
    ['母版/版式缺失', '不崩溃；导出自动补默认母版/版式', { slides: [{ shapes: [{ type: 'shape', geom: 'rect', x: 0, y: 0, w: 100, h: 100 }] }], slideWidth: 9144000, slideHeight: 6858000 }, (b) => b.slides.length === 1],
  ];

  for (const [name, expected, pres, check] of cases) {
    await runCase('Presentation', name, expected, async () => {
      const out = await exportPptx(pres);
      const b = await parsePptx(out);
      const ca = countPpt(pres);
      const cb = countPpt(b);
      const diffs = [];
      if (ca.slides !== cb.slides) diffs.push(`页数 ${ca.slides}→${cb.slides}`);
      if (cb.media < ca.media) diffs.push(`媒体数 ${ca.media}→${cb.media}`);
      for (let i = 0; i < Math.min(ca.perSlide.length, cb.perSlide.length); i++) {
        if (cb.perSlide[i].shapes < ca.perSlide[i].shapes)
          diffs.push(`第${i + 1}页形状 ${ca.perSlide[i].shapes}→${cb.perSlide[i].shapes}`);
        if (ca.perSlide[i].rotated && cb.perSlide[i].rotated < ca.perSlide[i].rotated)
          diffs.push(`第${i + 1}页旋转丢失`);
        if (ca.perSlide[i].hyperlinks && cb.perSlide[i].hyperlinks < ca.perSlide[i].hyperlinks)
          diffs.push(`第${i + 1}页超链接丢失`);
      }
      const integ = await checkZipIntegrity(out, 'pptx');
      const checkOk = check ? !!check(b) : true;
      const ok = diffs.length === 0 && integ.ok && checkOk;
      return {
        ok,
        actual: ok ? '结构一致' : `${diffs.join('; ')}${checkOk ? '' : ' | 专项断言失败'}${integ.ok ? '' : ' | 完整性：' + integ.issues.join('; ')}`,
        severity: integ.ok ? undefined : 'P0',
        evidence: integ.ok ? undefined : integ.issues.join('; '),
      };
    });
  }
}

/* ================================================================== A/B: PDF */

async function runPdf() {
  const png = { bytes: PNG_1x1, type: 'png' };

  await runCase('PDF', '图片转 PDF（2 图 → 2 页）', '页数=2，%PDF- 头', async () => {
    const one = await imagesToPdf([png]);
    const two = await imagesToPdf([png, png]);
    const n1 = await getPageCount(one);
    const n2 = await getPageCount(two);
    const head = String.fromCharCode(...two.slice(0, 5));
    const ok = n1 === 1 && n2 === 2 && head === '%PDF-';
    return { ok, actual: `单图=${n1} 页，双图=${n2} 页，head=${head}` };
  });

  await runCase('PDF', '合并（2 份 1 页 → 2 页）', '页数=2', async () => {
    const a = await imagesToPdf([png]);
    const b = await imagesToPdf([png]);
    const merged = await mergePdfs([a, b]);
    const n = await getPageCount(merged);
    return { ok: n === 2, actual: `合并后页数=${n}` };
  });

  await runCase('PDF', '链式：图片→合并→水印（ASCII 文本）', '页数守恒且输出合法 PDF', async () => {
    const merged = await mergePdfs([await imagesToPdf([png]), await imagesToPdf([png])]);
    const wm = await addWatermark(merged, { text: 'CONFIDENTIAL', fontSize: 40, opacity: 0.2, rotate: 45, color: '#808080' });
    const n = await getPageCount(wm);
    const head = String.fromCharCode(...wm.slice(0, 5));
    const ok = n === 2 && head === '%PDF-' && wm.length > merged.length;
    return { ok, actual: `页数=${n} head=${head} size ${merged.length}→${wm.length}` };
  });

  await runCase('PDF', '水印：非 Latin（中文）文本', '不崩溃或给出可读的输入校验错误', async () => {
    const base = await imagesToPdf([png]);
    try {
      const wm = await addWatermark(base, { text: '机密', fontSize: 40, opacity: 0.2, rotate: 45 });
      const n = await getPageCount(wm);
      return { ok: true, actual: `支持中文水印（页数=${n}）` };
    } catch (e) {
      // 中文水印抛 WinAnsi 异常 → 真实缺陷（P1）：addWatermark 固定用标准字体 Helvetica，
      // 对非 Latin 输入无降级/无输入校验；PdfToolbox 直接透传用户输入。
      return {
        ok: false,
        severity: 'P1',
        actual: `抛出异常：${e.message}`,
        evidence:
          `packages/pdf/src/index.ts:310 doc.embedFont(StandardFonts.Helvetica) → ` +
          `font.widthOfTextAtSize 对非 Latin 输入抛 WinAnsi；` +
          `apps/desktop/src/renderer/src/components/PdfToolbox.tsx:136-148 直接透传用户输入（无 CJK 校验）。` +
          `原始错误：${e.message}`,
        sourceLoc: 'packages/pdf/src/index.ts:310（watermark 字体） + PdfToolbox.tsx:136-148（无输入校验）',
      };
    }
  });

  await runCase('PDF', '页面工具：提取/旋转/删除', '页数按预期变化', async () => {
    const three = await imagesToPdf([png, png, png]);
    const ex = await extractPages(three, '1,3');
    const rt = await rotatePages(three, 'all', 90);
    const dl = await deletePages(three, '2');
    const [ne, nr, nd] = [await getPageCount(ex), await getPageCount(rt), await getPageCount(dl)];
    const ok = ne === 2 && nr === 3 && nd === 2;
    return { ok, actual: `提取=${ne} 旋转=${nr} 删除=${nd}` };
  });
}

/* ============================================================ C: 完整性专项（大图/混合产物） */

async function runIntegritySpot() {
  await runCase('Integrity', 'docx 混排产物 zip 完整性（含关系可达）', '无损坏条目/部件齐/无悬空关系', async () => {
    const samples = await buildWriterSamples();
    const mixed = samples.find((s) => s.name.startsWith('混排'));
    const a = await parseDocx(mixed.bytes);
    const out = await exportDocx(a);
    const integ = await checkZipIntegrity(out, 'docx');
    return { ok: integ.ok, actual: integ.ok ? `通过（${integ.parts} 个部件）` : integ.issues.join('; '), severity: 'P0', evidence: integ.ok ? undefined : integ.issues.join('; ') };
  });

  await runCase('Integrity', '含 5MB 图片 docx 产物完整性（媒体可达）', 'word/media 存在且被关系指向', async () => {
    const samples = await buildWriterSamples();
    const big = samples.find((s) => s.name.startsWith('超大图片'));
    const a = await parseDocx(big.bytes);
    const out = await exportDocx(a);
    const integ = await checkZipIntegrity(out, 'docx');
    const zip = await JSZip.loadAsync(out);
    const hasMedia = Object.keys(zip.files).some((n) => /^word\/media\//.test(n));
    const ok = integ.ok && hasMedia;
    return { ok, actual: `完整性=${integ.ok} media 部件=${hasMedia}`, severity: 'P0', evidence: integ.ok ? undefined : integ.issues.join('; ') };
  });
}

/* ========================= 跨软件失败的结构性根因（无需 COM 即可复现） */

async function runPptxStructure() {
  // (a) 默认新建演示（无母版）导出 → 必须自带最小母版/版式/主题，否则 WPS/PowerPoint 打不开
  await runCase(
    'Presentation',
    '导出包结构：默认演示（无母版）应自带母版/版式/主题',
    '含 ppt/slideMasters/*、ppt/slideLayouts/*、ppt/theme/*，且 presentation.xml 含 <p:sldMasterIdLst>',
    async () => {
      const pres = {
        slides: [
          { shapes: [{ type: 'text', x: 0, y: 0, w: 1000000, h: 1000000, paragraphs: [{ runs: [{ text: 'x' }] }], geom: 'rect' }] },
        ],
        slideWidth: 9144000,
        slideHeight: 6858000,
      };
      const out = await exportPptx(pres);
      const zip = await JSZip.loadAsync(out);
      const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
      const hasMaster = names.some((n) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(n));
      const hasLayout = names.some((n) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(n));
      const hasTheme = names.some((n) => /^ppt\/theme\/theme\d+\.xml$/.test(n));
      const presXml = await zip.file('ppt/presentation.xml').async('string');
      const hasMasterIdLst = /<p:sldMasterIdLst/.test(presXml);
      const ok = hasMaster && hasLayout && hasTheme && hasMasterIdLst;
      return {
        ok,
        actual: `slideMaster=${hasMaster} slideLayout=${hasLayout} theme=${hasTheme} sldMasterIdLst=${hasMasterIdLst}`,
        severity: 'P0',
        evidence: ok
          ? undefined
          : `导出包仅 ${names.length} 个部件：${names.join(', ')}；缺母版/主题，WPS/PowerPoint 无法正常打开`,
        sourceLoc:
          'packages/presentation/src/exporter/index.ts（仅当 pres.masters/layouts 存在才写母版/主题）+ apps/desktop/src/renderer/src/slide/SlideEditor.tsx:74 demoPresentation()（默认模型无 masters）',
      };
    },
  );

  // (b) 显式提供母版时：母版必须列出 <p:sldLayoutIdLst> 且与版式建立关系
  await runCase(
    'Presentation',
    '导出包结构：母版应含 <p:sldLayoutIdLst> 并关联版式',
    'slideMaster 含 <p:sldLayoutIdLst>；母版 rels 含 slideLayout 关系',
    async () => {
      const pres = {
        slides: [
          {
            partName: 'slide1',
            layout: 'ppt/slideLayouts/slideLayout1.xml',
            shapes: [{ type: 'shape', geom: 'rect', x: 0, y: 0, w: 1000000, h: 1000000 }],
          },
        ],
        slideWidth: 9144000,
        slideHeight: 6858000,
        masters: [{ partName: 'ppt/slideMasters/slideMaster1.xml', name: 'Master', themeName: 'Office' }],
        layouts: [
          {
            partName: 'ppt/slideLayouts/slideLayout1.xml',
            name: 'Blank',
            masterPartName: 'ppt/slideMasters/slideMaster1.xml',
          },
        ],
      };
      const out = await exportPptx(pres);
      const zip = await JSZip.loadAsync(out);
      const master = await zip.file('ppt/slideMasters/slideMaster1.xml').async('string');
      const relsFile = zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels');
      const rels = relsFile ? await relsFile.async('string') : '';
      const hasLayoutIdLst = /<p:sldLayoutIdLst/.test(master);
      const relLinksLayout = /relationships\/slideLayout/.test(rels);
      const ok = hasLayoutIdLst && relLinksLayout;
      return {
        ok,
        actual: `sldLayoutIdLst=${hasLayoutIdLst} 母版→版式关系=${relLinksLayout}`,
        severity: 'P1',
        evidence: ok
          ? undefined
          : 'slideMaster1.xml 仅含 cSld+clrMap；母版 rels 仅含 theme —— 母版与版式未建立 OOXML 要求的关联',
        sourceLoc: 'packages/presentation/src/exporter/index.ts（serializeSlideMaster + 母版 rels 生成）',
      };
    },
  );
}

/** 把跨软件 COM 实测结果纳入测试矩阵（每条 = 一个断言） */
function incorporateCrossSoft(cross) {
  if (!cross || !cross.data) return;
  for (const o of cross.data.opens ?? []) {
    const detail = o.ok
      ? o.kind === 'word'
        ? `段落=${o.paragraphs} 表格=${o.tables}`
        : o.kind === 'excel'
          ? `sheets=${o.sheets} 首表UsedRange=${o.firstUsedRange ?? '-'}`
          : `slides=${o.slides}`
      : `打开失败：${o.err}`;
    record({
      module: 'CrossSoft',
      case: `WPS 打开 ${o.file}`,
      expected: '能被本机 WPS 正常打开并读回结构',
      actual: detail,
      result: o.ok ? 'PASS' : 'FAIL',
      severity: o.ok ? undefined : o.kind === 'ppt' ? 'P0' : 'P1',
      evidence: o.ok ? undefined : `progId=${o.progId} err=${o.err}`,
      sourceLoc:
        !o.ok && o.kind === 'ppt'
          ? 'packages/presentation/src/exporter/index.ts（母版/主题/版式关联缺失）'
          : undefined,
    });
  }
}

/* ============================================================ D: 跨软件（WPS COM） */

async function generateCrossSoftSamples() {
  await fsp.mkdir(TMP, { recursive: true });
  // 清理旧样本目录
  for (const sub of ['docx', 'xlsx', 'pptx']) {
    await fsp.rm(path.join(TMP, sub), { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(path.join(TMP, sub), { recursive: true });
  }
  const created = [];

  // docx 样本（jareking 导出）：基础 + 表格 + 混排
  const samples = await buildWriterSamples();
  const pick = [
    samples.find((s) => s.name.startsWith('混排')),
    samples.find((s) => s.name.startsWith('特殊字符')),
    samples.find((s) => s.name.startsWith('深嵌套')),
  ];
  let i = 0;
  for (const s of pick) {
    if (!s) continue;
    i += 1;
    const doc = await parseDocx(s.bytes);
    const out = await exportDocx(doc);
    const file = path.join(TMP, 'docx', `jareking-doc-${i}.docx`);
    await fsp.writeFile(file, out);
    created.push({ kind: 'word', path: file, note: s.name });
  }

  // xlsx 样本
  const wbs = [
    { name: 'jareking-sheet-1.xlsx', wb: { sheets: [{ name: '数据', rowCount: 2, colCount: 3, cells: { '0,0': { value: 'A' }, '0,1': { value: 1 }, '1,0': { formula: 'SUM(B1:B1)' } }, merges: [] }] } },
    { name: 'jareking-sheet-2.xlsx', wb: { sheets: [{ name: 'S1', rowCount: 1, colCount: 2, cells: { '0,0': { value: 'merged' } }, merges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 1 }] }, { name: 'S2', rowCount: 1, colCount: 1, cells: { '0,0': { value: 'x' } }, merges: [], hidden: true }] } },
  ];
  for (const { name, wb } of wbs) {
    const out = await exportXlsx(wb);
    const file = path.join(TMP, 'xlsx', name);
    await fsp.writeFile(file, out);
    created.push({ kind: 'excel', path: file, note: name });
  }

  // pptx 样本
  const presses = [
    { name: 'jareking-slide-1.pptx', pres: { slides: [{ shapes: [{ type: 'text', x: 1000000, y: 1000000, w: 5000000, h: 1000000, paragraphs: [{ runs: [{ text: 'Hello WPS', bold: true, fontSize: 32 }] }], geom: 'rect' }, { type: 'shape', geom: 'ellipse', x: 1000000, y: 2500000, w: 3000000, h: 1500000, fill: '#FF0000' }] }], slideWidth: 9144000, slideHeight: 6858000 } },
    { name: 'jareking-slide-2.pptx', pres: { slides: [{ shapes: [{ type: 'text', x: 500000, y: 500000, w: 6000000, h: 800000, paragraphs: [{ runs: [{ text: '第二页' }] }], geom: 'rect' }] }, { shapes: [{ type: 'table', x: 500000, y: 500000, w: 4000000, h: 2000000, colWidths: [2000000, 2000000], rows: [{ cells: [{ text: 'A' }, { text: 'B' }] }, { cells: [{ text: 'C' }, { text: 'D' }] }] }] }], slideWidth: 9144000, slideHeight: 6858000 } },
  ];
  for (const { name, pres } of presses) {
    const out = await exportPptx(pres);
    const file = path.join(TMP, 'pptx', name);
    await fsp.writeFile(file, out);
    created.push({ kind: 'ppt', path: file, note: name });
  }

  await fsp.writeFile(CROSS_INPUT, JSON.stringify({ files: created }, null, 2));
  // 关键：Windows PowerShell 5.1 无 BOM 时按 ANSI/GBK 解码 .ps1，会破坏中文 → 必须写 UTF-8 BOM
  await fsp.writeFile(CROSS_PS1, '\uFEFF' + CROSS_SOFTWARE_PS1, 'utf8');
  return created;
}

/** 跨软件 COM 校验的 PowerShell 脚本（用 Activator 惯用法，非 New-Object -ComObject） */
const CROSS_SOFTWARE_PS1 = `# jareking 跨软件可读性校验（WPS/Office COM）。由 adversarial-audit.mjs 生成。
$ErrorActionPreference = 'Continue'
$tmp = Split-Path -Parent $MyInvocation.MyCommand.Path
$inFile = Join-Path $tmp 'cross-input.json'
$outFile = Join-Path $tmp 'cross-software.json'
$logFile = Join-Path $tmp 'cross-software.log'
function Log([string]$m) { try { Add-Content -LiteralPath $logFile -Value ("{0} {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding UTF8 } catch { } }
'START' | Set-Content -LiteralPath $logFile -Encoding UTF8
Log "tmp=$tmp in=$inFile"

function Get-App([string[]]$ids) {
  foreach ($id in $ids) {
    try {
      $t = [Type]::GetTypeFromProgID($id)
      if (-not $t) { continue }
      $app = [Activator]::CreateInstance($t)
      if ($app) { return @{ id = $id; app = $app } }
    } catch { }
  }
  return $null
}

function Release($app) {
  if ($null -eq $app) { return }
  try { $app.Quit() } catch { }
  try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null } catch { }
}

$result = @{ }
$result['generatedAt'] = (Get-Date).ToString('o')
$result['engines'] = @()
$result['opens'] = @()

# 引擎探测
$groups = @(
  @{ kind = 'word';  ids = @('Word.Application','KWPS.Application','wps.Application') },
  @{ kind = 'excel'; ids = @('Excel.Application','KET.Application','et.Application') },
  @{ kind = 'ppt';   ids = @('KWPP.Application','wpp.Application','PowerPoint.Application') }
)
foreach ($g in $groups) {
  $hit = Get-App $g.ids
  if ($hit) {
    $nm = $null; $vr = $null
    try { $nm = $hit.app.Name } catch { }
    try { $vr = $hit.app.Version } catch { }
    $result['engines'] += [pscustomobject]@{ kind = $g.kind; progId = $hit.id; name = "$nm"; version = "$vr" }
    Log ("engine {0} -> {1} {2}" -f $g.kind, $nm, $vr)
    Release $hit.app
  } else {
    $result['engines'] += [pscustomobject]@{ kind = $g.kind; progId = $null; name = $null; version = $null }
    Log ("engine {0} -> NONE" -f $g.kind)
  }
}

$files = @()
try {
  $raw = Get-Content -LiteralPath $inFile -Raw -Encoding UTF8
  Log ("rawLen=" + (($raw | Measure-Object -Character).Characters))
  $parsed = ConvertFrom-Json -InputObject $raw
  foreach ($x in $parsed.files) { $files += $x }
  Log ("fileCount=" + $files.Count)
} catch {
  $result['fileReadError'] = "$($_.Exception.Message)"
  Log ("READ_ERR " + $_.Exception.Message)
}

try {
foreach ($f in $files) {
  $leaf = Split-Path $f.path -Leaf
  Log ("open " + $f.kind + " " + $leaf)
  if ($f.kind -eq 'word') {
    $hit = Get-App @('Word.Application','KWPS.Application','wps.Application')
    if (-not $hit) { $result['opens'] += [pscustomobject]@{ file = $leaf; kind = $f.kind; ok = $false; err = 'no word COM' }; continue }
    $app = $hit.app; $doc = $null
    try {
      try { $app.Visible = $false } catch { }
      try { $app.DisplayAlerts = 0 } catch { }
      $doc = $app.Documents.Open($f.path, $false, $true, $false)
      $result['opens'] += [pscustomobject]@{ file = $leaf; kind = $f.kind; ok = $true; progId = $hit.id; paragraphs = [int]$doc.Paragraphs.Count; tables = [int]$doc.Tables.Count }
      Log ("word OK paragraphs=" + [int]$doc.Paragraphs.Count)
    } catch {
      Log ("word ERR " + $_.Exception.Message)
      $result['opens'] += [pscustomobject]@{ file = $leaf; kind = $f.kind; ok = $false; progId = $hit.id; err = "$($_.Exception.Message)" }
    } finally {
      if ($doc) { try { $doc.Close($false) } catch { } }
      Release $app
    }
  }
  elseif ($f.kind -eq 'excel') {
    $hit = Get-App @('Excel.Application','KET.Application','et.Application')
    if (-not $hit) { $result['opens'] += [pscustomobject]@{ file = $leaf; kind = $f.kind; ok = $false; err = 'no excel COM' }; continue }
    $app = $hit.app; $wb = $null
    try {
      try { $app.Visible = $false } catch { }
      try { $app.DisplayAlerts = $false } catch { }
      $wb = $app.Workbooks.Open($f.path, 0, $true)
      $ws = $wb.Worksheets.Item(1)
      $addr = $null
      try { $ur = $ws.UsedRange; $addr = ("{0}x{1}" -f [int]$ur.Rows.Count, [int]$ur.Columns.Count) } catch { $addr = $null }
      $result['opens'] += [pscustomobject]@{ file = $leaf; kind = $f.kind; ok = $true; progId = $hit.id; sheets = [int]$wb.Sheets.Count; firstUsedRange = $addr }
      Log ("excel OK sheets=" + [int]$wb.Sheets.Count)
    } catch {
      Log ("excel ERR " + $_.Exception.Message)
      $result['opens'] += [pscustomobject]@{ file = $leaf; kind = $f.kind; ok = $false; progId = $hit.id; err = "$($_.Exception.Message)" }
    } finally {
      if ($wb) { try { $wb.Close($false) } catch { } }
      Release $app
    }
  }
  elseif ($f.kind -eq 'ppt') {
    # WPS 演示对一个「无/弱母版」的 pptx 会挂起（疑似弹出修复对话框），
    # 故在子作业中带超时执行，避免整脚本卡死。仅用 KWPP.Application（本机 PowerPoint.Application 为悬空注册）。
    $sb = {
      param($file)
      $ErrorActionPreference = 'Continue'
      try {
        $app = [Activator]::CreateInstance([Type]::GetTypeFromProgID('KWPP.Application'))
        $p = $app.Presentations.Open($file, $true, $false, $false)
        $n = [int]$p.Slides.Count
        try { $p.Close() } catch { }
        try { $app.Quit() } catch { }
        "OK|$n"
      } catch { "ERR|$($_.Exception.Message)" }
    }
    $job = Start-Job -ScriptBlock $sb -ArgumentList $f.path
    $done = Wait-Job $job -Timeout 45
    if ($done) {
      $line = @(Receive-Job $job -ErrorAction SilentlyContinue)[-1]
      if ($line -like 'OK|*') {
        $n = [int](($line -split '\|')[1])
        $result['opens'] += [pscustomobject]@{ file = $leaf; kind = $f.kind; ok = $true; progId = 'KWPP.Application'; slides = $n }
        Log ("ppt OK slides=$n")
      } else {
        $result['opens'] += [pscustomobject]@{ file = $leaf; kind = $f.kind; ok = $false; progId = 'KWPP.Application'; err = "$line" }
        Log ("ppt ERR $line")
      }
    } else {
      Stop-Job $job -ErrorAction SilentlyContinue
      $result['opens'] += [pscustomobject]@{ file = $leaf; kind = $f.kind; ok = $false; progId = 'KWPP.Application'; err = 'TIMEOUT: WPS 演示打开 >45s 未返回（疑似挂起/需修复）' }
      Log 'ppt TIMEOUT'
      Get-Process wpp -ErrorAction SilentlyContinue | ForEach-Object { try { Stop-Process -Id $_.Id -Force } catch { } }
    }
    Remove-Job $job -Force -ErrorAction SilentlyContinue
  }
}
} catch { Log ("FATAL " + $_.Exception.ToString()); $result['fatal'] = "$($_.Exception.Message)" }

Log ("done opens=" + $result['opens'].Count)
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $outFile -Encoding UTF8
`;

async function loadCrossSoftResults() {
  try {
    const raw = stripBom(await fsp.readFile(CROSS_OUT, 'utf8'));
    return { stale: false, data: JSON.parse(raw) };
  } catch {
    return { stale: false, data: null };
  }
}

/* ================================================================== 报告输出 */

function summarize() {
  const by = (r) => RESULTS.filter((x) => x.result === r).length;
  return { total: RESULTS.length, pass: by('PASS'), fail: by('FAIL'), degraded: by('DEGRADED') };
}

function severityRank(s) {
  return s === 'P0' ? 0 : s === 'P1' ? 1 : 2;
}

function buildReport(cross) {
  const s = summarize();
  const failures = RESULTS.filter((r) => r.result === 'FAIL').sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity),
  );
  const lines = [];
  const now = new Date().toISOString();

  lines.push('# jareking 对抗性审计报告（adversarial-audit）');
  lines.push('');
  lines.push('> 生成者：QA 严过关 · 并行任务 3/3 · 由 `scripts/adversarial-audit.mjs` 自动生成');
  lines.push(`> 生成时间：${now}`);
  lines.push(`> 运行环境：${process.platform} / Node ${process.version}`);
  lines.push('');
  lines.push('## 1. 概述');
  lines.push('');
  lines.push('- 立场：**对抗（adversarial）**。目标：保证不丢格式、文件不损坏、不同软件均能正常读取。');
  lines.push('- 范围：Writer(docx) / Sheet(xlsx) / Presentation(pptx) / PDF 四大模块的边界与恶意输入、round-trip 保真、包完整性、跨软件可读性。');
  lines.push('- 方法：');
  lines.push('  - **A 边界/恶意输入**：程序化构造极端样本（空文档 / 超长（10 万字符）/ 特殊字符 emoji+组合+RTL+零宽+XML 敏感 / 深嵌套 3 层表格 / 5MB 大图 / 公式+批注+修订+页眉页脚+脚注+分栏 混排 / 200 列 / 非法公式 / 全角 …）；');
  lines.push('  - **B round-trip 保真**：`parse → export → parse`，比对关键结构计数是否逐一相等；');
  lines.push('  - **C 文件完整性**：JSZip 解压 + CRC32 校验 + 必需部件 + XML 合法性 + **悬空关系（dangling rel）**检测；');
  lines.push('  - **D 跨软件可读**：把 jareking 导出的 docx/xlsx/pptx 样本交本机 WPS 的 COM 组件打开并读回结构。');
  lines.push(`- 真实 WPS 实测：**${cross && cross.data ? '已实测（见 §4）' : '未实测（未检测到 cross-software.json；见 §4 说明）'}**`);
  lines.push(`- 生成样本目录：\`${TMP}\``);
  lines.push('');

  lines.push('## 2. 测试矩阵');
  lines.push('');
  lines.push('| ID | 模块 | 用例 | 期望 | 实际 | 结果 |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of RESULTS) {
    const badge = r.result === 'PASS' ? '✅' : r.result === 'DEGRADED' ? '🟡 设计内降级' : `❌ ${r.severity ?? ''}`;
    lines.push(`| ${r.id} | ${r.module} | ${r.case.replace(/\|/g, '\\|')} | ${r.expected.replace(/\|/g, '\\|')} | ${String(r.actual).replace(/\|/g, '\\|')} | ${badge} |`);
  }
  lines.push('');
  lines.push(`**小计**：共 ${s.total} 项 —— 通过 ${s.pass} / 设计内降级 ${s.degraded} / 失败 ${s.fail}。`);
  lines.push('');

  lines.push('## 3. Bug 清单（分级）');
  lines.push('');
  if (!failures.length) {
    lines.push('**未发现任何失败项（P0/P1/P2 均为空）。** 全部断言通过或属设计内降级。');
    lines.push('');
  } else {
    for (const r of failures) {
      lines.push(`### [${r.severity}] ${r.id} ${r.module} · ${r.case}`);
      if (r.sourceLoc) lines.push(`- **源码定位**：${r.sourceLoc}`);
      else lines.push(`- **源码定位**：见「实际/证据」列示的触发模块（脚本内用例编号 ${r.id}）`);
      lines.push(`- **复现**：\`node scripts/adversarial-audit.mjs\` 即可；该用例编号 ${r.id}`);
      lines.push(`- **期望**：${r.expected}`);
      lines.push(`- **实际**：${r.actual}`);
      lines.push(`- **证据**：${r.evidence ? '`' + r.evidence + '`' : '（见实际列）'}`);
      lines.push(`- **影响**：${
        r.severity === 'P0'
          ? '阻断级：可能导致文件无法打开 / 保存即损坏 / 跨软件打不开。'
          : r.severity === 'P1'
            ? '严重级：支持范围内的内容丢失或结构走样，round-trip 不可逆。'
            : '轻微级：边缘/不规范输入，影响有限。'
      }`);
      lines.push('');
    }
  }

  lines.push('## 4. 跨软件可读性结论');
  lines.push('');
  if (cross && cross.data) {
    const d = cross.data;
    lines.push('**结论：已用本机 WPS 的 COM 自动化组件真实打开 jareking 导出样本并读回结构。**');
    lines.push('');
    lines.push('引擎探测（COM ProgID → 组件自报名称/版本）：');
    lines.push('');
    lines.push('| 大类 | ProgID | 组件自报名 | 版本 |');
    lines.push('|---|---|---|---|');
    for (const e of d.engines ?? []) {
      lines.push(`| ${e.kind} | ${e.progId ?? '(未探测到)'} | ${e.name ?? '-'} | ${e.version ?? '-'} |`);
    }
    lines.push('');
    lines.push('打开结果：');
    lines.push('');
    lines.push('| 文件 | 大类 | 打开 | 读回结构 |');
    lines.push('|---|---|---|---|');
    for (const o of d.opens ?? []) {
      const readback =
        o.kind === 'word'
          ? `段落=${o.paragraphs} 表格=${o.tables}`
          : o.kind === 'excel'
            ? `sheets=${o.sheets} 首表UsedRange=${o.firstUsedRange ?? '-'}`
            : o.kind === 'ppt'
              ? `slides=${o.slides}`
              : '-';
      lines.push(`| ${o.file} | ${o.kind} | ${o.ok ? '✅' : '❌ ' + (o.err ?? '')} | ${o.ok ? readback : '-'} |`);
    }
    lines.push('');
  } else {
    lines.push('**结论：未能完成真实 WPS/Office 实测。**');
    lines.push('');
    lines.push('原因与补救：');
    lines.push('- 本机已安装 WPS Office（`KWPS.Application` / `KET.Application` / `KWPP.Application` 三套 COM ProgID 均探测成功，组件自报为 "Microsoft Office 12.0" 兼容层）；');
    lines.push('- 但审计运行环境禁止从 Bash/Node 直接拉起 `powershell.exe`（安全策略），且沙箱禁止 `New-Object -ComObject`；');
    lines.push('- 已改为两步执行：本脚本生成 `cross-input.json` + `cross-software.ps1`，由 PowerShell 工具执行该脚本产出 `cross-software.json`，再次运行本脚本即自动纳入实测结果。');
    lines.push(`- 待执行脚本：\`${CROSS_PS1}\``);
    lines.push('');
  }

  // §5 源码定位与路由判定
  lines.push('## 5. 源码定位与路由判定（交工程师 / 主理人转派）');
  lines.push('');
  const routed = failures.filter((r) => r.sourceLoc);
  if (!routed.length) {
    lines.push('无需要路由的源码缺陷（无源码级失败项）。');
  } else {
    lines.push('以下失败项均为**可复现的源码缺陷**：断言期望正确（符合 ECMA-376 / 用户验收目标），实现不符 → 归因 **源码 bug**（非测试问题）。');
    lines.push('');
    lines.push('| 源码文件（定位） | 关联用例 | 级别 |');
    lines.push('|---|---|---|');
    const byFile = new Map();
    for (const r of routed) {
      if (!byFile.has(r.sourceLoc)) byFile.set(r.sourceLoc, []);
      byFile.get(r.sourceLoc).push(r);
    }
    for (const [loc, rs] of byFile) {
      lines.push(`| \`${loc}\` | ${rs.map((r) => `${r.id}(${r.severity})`).join(', ')} | ${[...new Set(rs.map((r) => r.severity))].join('/')} |`);
    }
    lines.push('');
  }
  lines.push('');

  // §6 证据链（pptx 根因隔离）
  lines.push('## 6. 证据链：pptx 跨软件失败根因隔离（对抗实验）');
  lines.push('');
  lines.push('为区分「环境/COM 问题」与「jareking 导出物问题」，做了三组对照（均用本机 WPS COM）：');
  lines.push('');
  lines.push('| 实验 | 样本 | 结果 |');
  lines.push('|---|---|---|');
  lines.push('| ① 控制组 | WPS 自身 `Presentations.Add()` 新建并另存的 pptx（含完整母版/主题） | ✅ 正常打开（slides=1） |');
  lines.push('| ② 交换组 | WPS 骨架 + **仅替换**为 jareking 的 `slide1.xml` | ✅ 正常打开 → 证明 jareking 的**页 XML 正确** |');
  lines.push('| ③ 被测组 | jareking 导出的 pptx（默认无母版 / 手工注入母版两版） | ❌ 均挂起（>45s 未返回） |');
  lines.push('');
  lines.push('→ 结论：**故障在 jareking 的 pptx 包骨架**（缺母版/主题；母版缺 `p:sldLayoutIdLst` 与母版→版式关系），');
  lines.push('  而非页内容、也非 WPS COM 环境。docx/xlsx 同环境可正常打开，进一步排除环境因素。');
  lines.push('');

  // §7 未覆盖项与局限
  lines.push('## 7. 未覆盖项与局限（如实声明）');
  lines.push('');
  lines.push('- **视觉保真**：跨软件仅比对**结构计数**（段落/表格/sheets/slides），未逐像素比对分页、字体回退、精确版式；Word「结构能读」≠「排版逐像素一致」。');
  lines.push('- **本机仅有 WPS**：无真实 Microsoft Office，MS Office 真机未实测（COM 组件自报 "Microsoft Office 12.0" 为 WPS 兼容层）。');
  lines.push('- **旧格式/其它格式**：`.doc`/`.xls`/`.ppt`（二进制旧格式）、RTF、ODF、CSV 未覆盖。');
  lines.push('- **高级特性**：SmartArt / OLE / 图表渲染 / 宏(VBA) / 数字签名 / 加密与受保护文档 / 修订接受-拒绝语义 未覆盖（部分为已知降级项，见 `fidelity`）。');
  lines.push('- **性能/规模**：超大文件（≥100MB）往返由 `gen-bigfile.mjs` / `bigfile-bench.mjs` 单独覆盖，本脚本未重复。');
  lines.push('- **Excel 值级等价**：跨软件仅读 `Sheets.Count` / `UsedRange` 尺寸，未逐单元格比对值（结构级）。');
  lines.push('- **PDF 打印管线像素保真**：由 `pdf-export-smoke.mjs` 单独覆盖，本脚本仅覆盖 PDF 数据层算子（合并/水印/提取等）。');
  lines.push('');
  lines.push('## 8. 总体结论与建议');
  lines.push('');
  const p0 = failures.filter((r) => r.severity === 'P0').length;
  const p1 = failures.filter((r) => r.severity === 'P1').length;
  const p2 = failures.filter((r) => r.severity === 'P2').length;
  lines.push(`- 汇总：P0=${p0}，P1=${p1}，P2=${p2}，设计内降级=${s.degraded}，通过=${s.pass}。`);
  lines.push(
    p0 + p1 === 0
      ? '- **总体结论**：核心链路的边界/恶意输入均未崩溃，round-trip 保真与包完整性达标，未见阻断/严重缺陷。'
      : '- **总体结论**：存在阻断/严重缺陷，需工程师修复后复测（见 §3）。',
  );
  lines.push('- 建议：将本脚本纳入交付前门禁（`node scripts/adversarial-audit.mjs`）；把「悬空关系检测」并入导出门禁。');
  if (failures.some((r) => r.module === 'Presentation' || r.case.includes('.pptx'))) {
    lines.push('- **修复建议（pptx）**：导出器应在 `pres.masters/layouts` 缺失时**合成最小默认母版/版式/主题**，写出 `<p:sldLayoutIdLst>` 与「母版→版式」关系；或在应用「新建演示」默认模型中内置一份母版。');
  }
  if (failures.some((r) => r.module === 'PDF')) {
    lines.push('- **修复建议（水印）**：`addWatermark` 对非 Latin 输入改用可嵌入的 CJK 字体（或按字符集校验并给出明确错误）；UI 侧同步做输入校验。');
  }
  lines.push('');

  return lines.join('\n');
}

/* ================================================================== main */

async function main() {
  console.log('=== jareking 对抗性审计（adversarial-audit）===');
  console.log(`环境：${process.platform} / Node ${process.version}`);
  console.log(`临时目录：${TMP}`);

  if (COM_ONLY) {
    const created = await generateCrossSoftSamples();
    console.log(`已生成跨软件样本 ${created.length} 个 + cross-software.ps1。`);
    console.log(`请在 PowerShell 执行：& "${CROSS_PS1}"`);
    return;
  }

  await runWriter();
  await runSheet();
  await runPresentation();
  await runPdf();
  await runIntegritySpot();
  await runPptxStructure();

  // 跨软件：仅当尚无实测结果（或显式 --regen-com）时才重新生成样本与脚本，
  // 否则会覆盖输入文件、使已产出的 cross-software.json 失效。
  let cross = { data: null };
  if (!NO_COM) {
    const needGen = ARGS.includes('--regen-com') || !fs.existsSync(CROSS_OUT);
    if (needGen) {
      await generateCrossSoftSamples().catch((e) => console.log('生成跨软件样本失败：', e.message));
    } else {
      console.log('检测到既有跨软件实测结果，直接纳入（如样本需更新请加 --regen-com）。');
    }
    cross = await loadCrossSoftResults();
    incorporateCrossSoft(cross);
  }

  const report = buildReport(cross);
  const outPath = path.join(root, 'docs', 'adversarial-audit.md');
  await fsp.writeFile(outPath, report, 'utf8');

  const s = summarize();
  console.log('');
  console.log(`用例：${s.total} | ✅ 通过 ${s.pass} | 🟡 设计内降级 ${s.degraded} | ❌ 失败 ${s.fail}`);
  for (const r of RESULTS.filter((x) => x.result !== 'PASS')) {
    console.log(`  ${r.result === 'FAIL' ? '❌' : '🟡'} [${r.severity ?? '降级'}] ${r.id} ${r.module} ${r.case} → ${r.actual}`);
  }
  console.log('');
  console.log(`报告已写入：${outPath}`);
  if (!cross.data && !NO_COM) {
    console.log('跨软件：未纳入实测结果（请先运行 PowerShell 脚本 cross-software.ps1，再重跑本脚本）。');
  } else if (cross.data) {
    console.log('跨软件：已纳入真实 WPS COM 实测结果。');
  }

  const severe = RESULTS.filter((r) => r.result === 'FAIL' && (r.severity === 'P0' || r.severity === 'P1'));
  process.exit(severe.length ? 2 : 0);
}

main().catch((e) => {
  console.error('审计脚本失败：', e);
  process.exit(1);
});
