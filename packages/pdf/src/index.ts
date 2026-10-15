/**
 * @jareking/pdf —— jareking PDF 页面工具箱数据层（T5 加速，源自用户自研
 * 「PDF页面工具箱 v2」的功能融合）。
 *
 * 覆盖（与工具箱对齐）：页面提取/删除、合并、旋转、插入页面、页面替换、
 * 图片转 PDF（A4 等比居中）。压缩（栅格化重建）与 Office 转 PDF 属
 * 渲染/外部引擎层，另行接入。
 *
 * 坐标约定：页码规格面向用户（从 1 开始），内部统一转 0 基索引。
 * 支持格式："1,3-5"（含 "last"/"-1" 表示末页）。
 */
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont } from 'pdf-lib';

/* =========================================================================
 * 页码规格解析
 * ========================================================================= */

export interface PageSpecParseOptions {
  /** 总页数（解析 last / 越界裁剪用） */
  /** 保持输入顺序（默认 false = 按页码升序去重） */
  keepOrder?: boolean;
}

/**
 * 解析页码规格："1,3-5,last" / "-1"（末页）→ 0 基页索引数组。
 * 越界页自动忽略；重复页在升序模式下去重。
 */
export function parsePageSpec(spec: string, pageCount: number, opts?: PageSpecParseOptions): number[] {
  const indices: number[] = [];
  const seen = new Set<number>();
  for (const rawPart of spec.split(/[,，]/)) {
    const part = rawPart.trim();
    if (!part) continue;
    let fromStr: string;
    let toStr: string;
    if (part.includes('-')) {
      const [a, b] = part.split('-');
      fromStr = a.trim();
      toStr = b.trim();
    } else {
      fromStr = part;
      toStr = part;
    }
    const resolve = (t: string): number | null => {
      if (/^(last|末页|-1)$/i.test(t)) return pageCount - 1;
      if (/^first$/i.test(t)) return 0;
      const n = Number(t);
      if (!Number.isInteger(n) || n < 1 || n > pageCount) return null;
      return n - 1;
    };
    const from = resolve(fromStr);
    const to = resolve(toStr);
    if (from === null || to === null) continue;
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    for (let p = lo; p <= hi; p++) {
      if (!seen.has(p)) {
        seen.add(p);
        indices.push(p);
      }
    }
  }
  if (opts?.keepOrder) {
    // keepOrder 模式允许重复：重新按规格顺序展开
    const ordered: number[] = [];
    for (const rawPart of spec.split(/[,，]/)) {
      const part = rawPart.trim();
      if (!part) continue;
      const [a, b] = part.includes('-') ? part.split('-') : [part, part];
      const resolve = (t: string): number | null => {
        if (/^(last|末页|-1)$/i.test(t)) return pageCount - 1;
        const n = Number(t);
        return Number.isInteger(n) && n >= 1 && n <= pageCount ? n - 1 : null;
      };
      const from = resolve(a.trim());
      const to = resolve(b.trim());
      if (from === null || to === null) continue;
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      for (let p = lo; p <= hi; p++) ordered.push(p);
    }
    return ordered;
  }
  return indices.sort((a, b) => a - b);
}

/* =========================================================================
 * 基础
 * ========================================================================= */

export async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { ignoreEncryption: true });
}

export function getPageCount(pdf: Uint8Array | PDFDocument): number | Promise<number> {
  if (pdf instanceof PDFDocument) return pdf.getPageCount();
  return loadPdf(pdf).then((d) => d.getPageCount());
}

async function save(doc: PDFDocument): Promise<Uint8Array> {
  return doc.save({ useObjectStreams: false });
}

/* =========================================================================
 * 页面操作（与「PDF页面工具箱 v2」功能对齐）
 * ========================================================================= */

/** 提取指定页 → 新 PDF */
export async function extractPages(pdfBytes: Uint8Array, spec: string, opts?: { keepOrder?: boolean }): Promise<Uint8Array> {
  const src = await loadPdf(pdfBytes);
  const indices = parsePageSpec(spec, src.getPageCount(), opts);
  if (!indices.length) throw new Error('页码规格未匹配到任何页面');
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, indices);
  pages.forEach((p) => out.addPage(p));
  return save(out);
}

/** 删除指定页 → 新 PDF */
export async function deletePages(pdfBytes: Uint8Array, spec: string): Promise<Uint8Array> {
  const doc = await loadPdf(pdfBytes);
  const total = doc.getPageCount();
  const toDelete = new Set(parsePageSpec(spec, total));
  if (!toDelete.size) throw new Error('页码规格未匹配到任何页面');
  if (toDelete.size >= total) throw new Error('不能删除全部页面');
  const keep: number[] = [];
  for (let i = 0; i < total; i++) if (!toDelete.has(i)) keep.push(i);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(doc, keep);
  pages.forEach((p) => out.addPage(p));
  return save(out);
}

/** 旋转页面（degrees: 90/180/270；spec 为 "all" 或页码规格） */
export async function rotatePages(
  pdfBytes: Uint8Array,
  spec: string,
  degrees_: 90 | 180 | 270,
): Promise<Uint8Array> {
  const doc = await loadPdf(pdfBytes);
  const total = doc.getPageCount();
  const targets = spec === 'all' || spec === '全部'
    ? Array.from({ length: total }, (_, i) => i)
    : parsePageSpec(spec, total);
  if (!targets.length) throw new Error('页码规格未匹配到任何页面');
  for (const i of targets) {
    const page = doc.getPage(i);
    const current = page.getRotation().angle;
    page.setRotation(degrees((current + degrees_) % 360));
  }
  return save(doc);
}

/** 多文件合并（按数组顺序） */
export async function mergePdfs(pdfBytesList: Uint8Array[]): Promise<Uint8Array> {
  if (!pdfBytesList.length) throw new Error('没有可合并的文件');
  const out = await PDFDocument.create();
  for (const bytes of pdfBytesList) {
    const src = await loadPdf(bytes);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return save(out);
}

export interface InsertPosition {
  type: 'front' | 'back' | 'after';
  /** type='after' 时的基准页（1 基） */
  afterPage?: number;
}

/** 插入页面：把 source 的指定页（可选）插入 target 的最前/最后/指定页之后 */
export async function insertPages(
  targetBytes: Uint8Array,
  sourceBytes: Uint8Array,
  position: InsertPosition,
  sourceSpec?: string,
): Promise<Uint8Array> {
  const target = await loadPdf(targetBytes);
  const source = await loadPdf(sourceBytes);
  const indices = sourceSpec ? parsePageSpec(sourceSpec, source.getPageCount()) : source.getPageIndices();
  if (!indices.length) throw new Error('来源页码规格未匹配到任何页面');
  const copied = await target.copyPages(source, indices);

  let at: number;
  if (position.type === 'front') at = 0;
  else if (position.type === 'back') at = target.getPageCount();
  else {
    const after = position.afterPage ?? target.getPageCount();
    at = Math.min(Math.max(after, 0), target.getPageCount());
  }
  copied.forEach((p, i) => target.insertPage(at + i, p));
  return save(target);
}

/** 页面替换：用 source 的指定页逐页顶替 target 的指定页 */
export async function replacePages(
  targetBytes: Uint8Array,
  sourceBytes: Uint8Array,
  targetSpec: string,
  sourceSpec?: string,
): Promise<Uint8Array> {
  const target = await loadPdf(targetBytes);
  const source = await loadPdf(sourceBytes);
  const targetIndices = parsePageSpec(targetSpec, target.getPageCount());
  if (!targetIndices.length) throw new Error('被替换页码规格未匹配到任何页面');
  const sourceIndices = sourceSpec
    ? parsePageSpec(sourceSpec, source.getPageCount(), { keepOrder: true })
    : source.getPageIndices();
  if (sourceIndices.length !== targetIndices.length) {
    throw new Error(`替换源页数（${sourceIndices.length}）与被替换页数（${targetIndices.length}）不一致`);
  }
  const copied = await target.copyPages(source, sourceIndices);
  targetIndices.forEach((ti, i) => {
    target.removePage(ti);
    target.insertPage(ti, copied[i]);
  });
  return save(target);
}

export interface ImageInput {
  bytes: Uint8Array;
  /** 'jpg' | 'png'（webp/bmp/gif 需先转码，浏览器侧用 canvas 完成） */
  type: 'jpg' | 'png';
}

/** 图片转 PDF：每图一页 A4，等比居中（左右留白 24pt），纵向排布 */
export async function imagesToPdf(images: ImageInput[]): Promise<Uint8Array> {
  if (!images.length) throw new Error('没有可用的图片');
  const out = await PDFDocument.create();
  const A4 = { w: 595.28, h: 841.89 };
  const margin = 24;
  for (const img of images) {
    const embedded = img.type === 'png' ? await out.embedPng(img.bytes) : await out.embedJpg(img.bytes);
    const page = out.addPage([A4.w, A4.h]);
    // 等比缩放至内容区（A4 减去左右留白与上下对称留白）
    const boxW = A4.w - margin * 2;
    const boxH = A4.h - margin * 2;
    const scale = Math.min(boxW / embedded.width, boxH / embedded.height, 1);
    const w = embedded.width * scale;
    const h = embedded.height * scale;
    const x = (A4.w - w) / 2;
    const y = (A4.h - h) / 2;
    page.drawImage(embedded, { x, y, width: w, height: h });
  }
  return save(out);
}

/** 页面信息（UI 列表用） */
export async function getPdfInfo(pdfBytes: Uint8Array): Promise<{ pageCount: number; title?: string }> {
  const doc = await loadPdf(pdfBytes);
  return { pageCount: doc.getPageCount(), title: doc.getTitle() ?? undefined };
}

/* =========================================================================
 * 文字水印
 * -------------------------------------------------------------------------
 * 基于 pdf-lib 的 page.drawText，在每页叠加文字水印（居中单个 或 整页平铺）。
 *
 * 字体策略（Bug3 修复，杜绝「静默产出乱码」）：
 *   - 拉丁文本：沿用 pdf-lib 内建标准字体 Helvetica（无需外部字体文件）。
 *   - 非拉丁文本（中文/emoji 等，WinAnsi 无法编码）：优先运行时嵌入一个 CJK 字体
 *     —— 从本机系统字体加载（simhei.ttf / msyh.ttc / simsun.ttc …，**绝不随安装包
 *     分发任何字体文件**，规避版权），或由调用方经 opts.fontPath / opts.fontBytes 指定；
 *     该路径需运行时可用 `@pdf-lib/fontkit`（pdf-lib 嵌入 TTF/OTF/TTC 的硬性依赖，
 *     本项目不新增运行时依赖，故仅在依赖树中存在时自动启用）。
 *   - 若无法嵌入 CJK 字体：抛出**可操作的明确错误**（而非返回损坏 PDF 或乱码），
 *     UI 侧据此以 toast 友好提示。
 * ========================================================================= */

export interface WatermarkOptions {
  /** 水印文字 */
  text: string;
  /** 字号（pt，默认 48） */
  fontSize?: number;
  /** 透明度 0~1（默认 0.12） */
  opacity?: number;
  /** 旋转角度（度，默认 45，常见对角水印） */
  rotate?: number;
  /** 颜色 #RRGGBB（默认 #808080） */
  color?: string;
  /** 平铺（true=整页重复矩阵，默认 false=页面居中单个） */
  tile?: boolean;
  /**
   * 可选：显式指定中文字体文件路径（.ttf/.otf，Node / Electron 主进程环境）。
   * 仅在文本含非拉丁字符时生效；需运行时可用 `@pdf-lib/fontkit`。
   */
  fontPath?: string;
  /**
   * 可选：直接提供字体二进制（优先级高于 fontPath）。
   * 便于无 fs 环境（渲染进程）注入字体，或单元测试注入受控字体。
   */
  fontBytes?: Uint8Array;
}

/**
 * 判定文本中「标准拉丁字体（WinAnsi）无法编码」的字符（去重）。
 * 覆盖范围：可打印 ASCII（0x20-0x7E）+ Latin-1 补充（0xA0-0xFF）；
 * 制表/换行/回车为空白控制符，忽略。中文/emoji/其它文种字符均会落入返回集。
 */
function findNonLatinChars(text: string): string[] {
  const bad: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) continue;
    if (cp >= 0x20 && cp <= 0x7e) continue;
    if (cp >= 0xa0 && cp <= 0xff) continue;
    if (!bad.includes(ch)) bad.push(ch);
  }
  return bad;
}

/** 标准拉丁字体（Helvetica/WinAnsi）能否编码该文本（用临时文档探测，不污染目标文档） */
async function canEncodeWithLatin(text: string): Promise<boolean> {
  const probe = await PDFDocument.create();
  const font = await probe.embedFont(StandardFonts.Helvetica);
  try {
    font.encodeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * 可选加载 `@pdf-lib/fontkit`。
 *
 * 本项目**不新增运行时依赖**：fontkit 仅在依赖树中已存在时才可用。
 * 用变量承载模块名（并用 @vite-ignore）避免打包器静态解析该可选依赖；
 * 缺失时返回 null（后续走「明确报错」兜底）。
 */
async function loadFontkitOptional(): Promise<unknown | null> {
  const spec = '@pdf-lib/fontkit';
  try {
    const mod: any = await import(/* @vite-ignore */ spec);
    return mod?.default ?? mod ?? null;
  } catch {
    return null;
  }
}

/** 读取本机字体文件字节（Node / Electron 环境）；不可读时抛出明确错误 */
async function readFontFile(p: string): Promise<Uint8Array> {
  const fsSpec = 'node:fs/promises';
  const fs: any = await import(/* @vite-ignore */ fsSpec).catch(() => null);
  if (!fs?.readFile) {
    throw new Error(`当前环境无法读取本地字体文件（仅 Node/Electron 主进程可用）：${p}`);
  }
  try {
    const buf = await fs.readFile(p);
    return new Uint8Array(buf);
  } catch (e) {
    throw new Error(`读取字体文件失败：${p}（${e instanceof Error ? e.message : String(e)}）`);
  }
}

/**
 * Windows 常见中文字体候选（仅**运行时读取本机字体**，绝不随包分发）。
 * 优先 .ttf（simhei.ttf），其余为兜底。
 */
const SYSTEM_CJK_FONT_CANDIDATES = [
  'C:\\Windows\\Fonts\\simhei.ttf',
  'C:\\Windows\\Fonts\\msyh.ttc',
  'C:\\Windows\\Fonts\\simsun.ttc',
  'C:\\Windows\\Fonts\\simkai.ttf',
  'C:\\Windows\\Fonts\\simfang.ttf',
];

/** 依次尝试加载本机中文字体；全部不可用时返回 undefined */
async function loadSystemCjkFont(): Promise<Uint8Array | undefined> {
  for (const p of SYSTEM_CJK_FONT_CANDIDATES) {
    try {
      const bytes = await readFontFile(p);
      if (bytes?.length) return bytes;
    } catch {
      // 该候选不存在/不可读 → 试下一个
    }
  }
  return undefined;
}

/**
 * 为非拉丁文本获取可嵌入字体。
 *
 * 优先 opts.fontBytes，其次 opts.fontPath，再退回本机系统字体；均不可用（或
 * 运行时缺 fontkit）时抛出**可操作的明确错误**——**不得**返回损坏 PDF 或乱码。
 */
async function embedUnicodeFont(
  doc: PDFDocument,
  opts: WatermarkOptions,
  badChars: string[],
): Promise<PDFFont> {
  const sample = badChars.slice(0, 8).join('');
  const fontkit = await loadFontkitOptional();
  if (!fontkit) {
    throw new Error(
      `水印文字含非拉丁字符（如「${sample}」），当前环境无法嵌入该字体：` +
      `pdf-lib 嵌入 TTF/OTF/TTC 自定义字体需依赖 @pdf-lib/fontkit（本项目未引入该运行时依赖）。` +
      `请改用拉丁字符，或在已注册 fontkit 的环境中通过 opts.fontPath（如 "C:\\\\Windows\\\\Fonts\\\\simhei.ttf"）/ opts.fontBytes 指定中文字体。`,
    );
  }

  let bytes: Uint8Array | undefined = opts.fontBytes;
  if (!bytes && opts.fontPath) bytes = await readFontFile(opts.fontPath);
  if (!bytes) bytes = await loadSystemCjkFont();
  if (!bytes) {
    throw new Error(
      `水印文字含非拉丁字符（如「${sample}」），但未找到可嵌入的中文字体。` +
      `请通过 opts.fontPath 指定字体文件（如 "C:\\\\Windows\\\\Fonts\\\\simhei.ttf"），或改用拉丁字符水印。`,
    );
  }

  (doc as unknown as { registerFontkit: (k: unknown) => void }).registerFontkit(fontkit);
  return doc.embedFont(bytes, { subset: true });
}

/** 解析 #RRGGBB / #RGB 颜色为 pdf-lib 的 rgb()；非法输入回退到中灰 */
function parseHexColor(hex: string): ReturnType<typeof rgb> {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return rgb(0.5, 0.5, 0.5);
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return rgb(r, g, b);
}

/**
 * 给 PDF 每页叠加文字水印。
 *
 * - `tile=false`（默认）：水印文字旋转后在页面居中显示单个；
 * - `tile=true`：在整页按网格重复平铺（并向页面四周外扩一个文字尺度的边距，
 *   保证旋转后仍覆盖页面四角）。
 *
 * 坐标约定：pdf-lib 的 `drawText` 以文字基线左端为锚点，`rotate` 绕锚点旋转。
 *
 * 字体：拉丁文本用内建 Helvetica；含非拉丁字符（如中文）时尝试嵌入 CJK 字体，
 * 无法嵌入则抛出可操作的明确错误（不会静默产出乱码或损坏 PDF）。
 */
export async function addWatermark(pdfBytes: Uint8Array, opts: WatermarkOptions): Promise<Uint8Array> {
  const text = typeof opts.text === 'string' ? opts.text : '';
  // 约定：空文字视为调用错误，直接抛错（而非产出一份「无变化」的副本），
  // 便于调用方 / UI 及早发现输入缺失。
  if (!text.trim()) throw new Error('水印文字不能为空');

  const fontSize = opts.fontSize && opts.fontSize > 0 ? opts.fontSize : 48;
  const opacity = Math.min(1, Math.max(0, opts.opacity ?? 0.12));
  const rotate = opts.rotate ?? 45;
  const color = parseHexColor(opts.color ?? '#808080');
  const tile = opts.tile ?? false;

  const doc = await loadPdf(pdfBytes);
  // 字体选择：可被标准拉丁字体编码 → Helvetica；否则尝试嵌入 CJK 字体
  let font: PDFFont;
  if (await canEncodeWithLatin(text)) {
    font = await doc.embedFont(StandardFonts.Helvetica);
  } else {
    font = await embedUnicodeFont(doc, opts, findNonLatinChars(text));
  }
  const rad = (rotate * Math.PI) / 180;

  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const textWidth = font.widthOfTextAtSize(text, fontSize);
    const common = { size: fontSize, font, color, opacity, rotate: degrees(rotate) };

    if (tile) {
      // 平铺：水平步长 = 文字宽 + 2 倍字号间隔；垂直步长 ≈ 4 倍字号。
      // 向四周外扩 margin，抵消旋转造成的边缘留白。
      const stepX = textWidth + fontSize * 2;
      const stepY = fontSize * 4;
      const margin = Math.max(textWidth, fontSize) * 1.5;
      for (let y = -margin; y < height + margin; y += stepY) {
        for (let x = -margin; x < width + margin; x += stepX) {
          page.drawText(text, { ...common, x, y });
        }
      }
    } else {
      // 居中：把「旋转后文字框的中心」对齐到页面中心。
      // 旋转前，锚点（基线左端）到文字框中心的偏移约为 (w/2, size/2)；
      // 绕锚点旋转 θ 后该偏移变为 (offX, offY)，反推锚点即可。
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const offX = (textWidth / 2) * cos - (fontSize / 2) * sin;
      const offY = (textWidth / 2) * sin + (fontSize / 2) * cos;
      page.drawText(text, { ...common, x: width / 2 - offX, y: height / 2 - offY });
    }
  }
  return save(doc);
}

/* =========================================================================
 * 文本提取（PDF 转 TXT）
 * -------------------------------------------------------------------------
 * 依赖 pdfjs-dist 的 legacy build（单线程，Node / 浏览器主进程均可用）。
 * 动态加载，避免打包阶段强制绑定 pdf.js；文本提取不涉及 canvas，
 * 故可在 Node 环境下完整单测。
 * ========================================================================= */
export async function pdfToText(bytes: Uint8Array): Promise<string> {
  // legacy build：无 Worker 依赖，Node 与浏览器主线程均可直接跑。
  // 用变量承载模块名，避免 TS 在类型检查期强制解析 .mjs 路径声明。
  const mod = 'pdfjs-dist/legacy/build/pdf.mjs' as string;
  const pdfjs: any = await import(mod);
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const doc = await pdfjs.getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;
  const lines: string[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content: any = await page.getTextContent();
      let line = '';
      for (const item of content.items as any[]) {
        line += 'str' in item ? (item.str as string) : '';
      }
      lines.push(line);
    }
  } finally {
    await doc.destroy();
  }
  return lines.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
