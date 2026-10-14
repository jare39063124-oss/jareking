/**
 * #46-C 压测样本生成器：产出 output/big-sample.xlsx 与 output/big-sample.pptx。
 *
 * - xlsx：10 万行 × 4 列（序号 / 300 字符随机文本 ×2 / 数字），目标 ≥100MB
 *   （随机文本不可压缩，确保 zip 后体积真实）。
 * - pptx：40 页 × 每页（1 文本框 + 1 张 3MB 伪 PNG：PNG 签名 + 随机字节）→ ≥120MB
 *   （解析器只保留字节不解码图片，伪图片合法参与全链路）。
 *
 * 用法：node scripts/gen-bigfile.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = path.join(root, 'output');
mkdirSync(outDir, { recursive: true });

const randText = (len) => {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(0x4e00 + ((Math.random() * 2000) | 0));
  return s;
};

/* ---------------- xlsx ---------------- */
async function genXlsx() {
  const require = createRequire(path.join(root, 'packages/sheet/package.json'));
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('压力测试');
  ws.columns = [
    { width: 12 },
    { width: 60 },
    { width: 60 },
    { width: 14 },
  ];
  const head = ws.addRow(['序号', '随机文本A', '随机文本B', '数值']);
  head.font = { bold: true };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
  head.eachCell((c) => {
    c.border = { bottom: { style: 'thin' } };
  });

  const ROWS = 100000;
  const t0 = Date.now();
  for (let r = 1; r <= ROWS; r++) {
    ws.addRow([r, randText(300), randText(300), (Math.random() * 100000) | 0]);
    if (r % 20000 === 0) console.log(`  xlsx rows: ${r}/${ROWS} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  const xlsxPath = path.join(outDir, 'big-sample.xlsx');
  console.log('  写盘中（zip 压缩随机文本，较慢）…');
  const buf = await wb.xlsx.writeBuffer();
  writeFileSync(xlsxPath, buf);
  const mb = statSync(xlsxPath).size / 1024 / 1024;
  console.log(`✅ xlsx: ${xlsxPath} = ${mb.toFixed(1)} MB`);
  return mb;
}

/* ---------------- pptx ---------------- */
async function genPptx() {
  const { exportPptx } = await import(
      new URL('../packages/presentation/dist/index.js', import.meta.url).href
  );
  const fakePng = () => {
    const bytes = new Uint8Array(3 * 1024 * 1024);
    bytes[0] = 0x89; bytes[1] = 0x50; bytes[2] = 0x4e; bytes[3] = 0x47; // PNG 签名
    for (let i = 8; i < bytes.length; i++) bytes[i] = (Math.random() * 256) | 0;
    return bytes;
  };
  const PAGES = 40;
  const slides = [];
  const media = {};
  for (let i = 0; i < PAGES; i++) {
    const relId = 'rId2';
    slides.push({
      shapes: [
        {
          type: 'text',
          x: 500000, y: 300000, w: 6000000, h: 800000,
          paragraphs: [{ runs: [{ text: `压测页 ${i + 1}`, fontSize: 28 }] }],
          geom: 'rect',
        },
        { type: 'image', relId, x: 800000, y: 1400000, w: 6000000, h: 4000000 },
      ],
    });
    media[`${i}:${relId}`] = fakePng();
  }
  console.log('  exportPptx 打包中（DEFLATE 随机数据，较慢）…');
  const t0 = Date.now();
  const bytes = await exportPptx({
    slides,
    slideWidth: 9144000,
    slideHeight: 6858000,
    media,
  });
  const pptxPath = path.join(outDir, 'big-sample.pptx');
  writeFileSync(pptxPath, bytes);
  const mb = statSync(pptxPath).size / 1024 / 1024;
  console.log(`✅ pptx: ${pptxPath} = ${mb.toFixed(1)} MB（${((Date.now() - t0) / 1000).toFixed(0)}s）`);
  return mb;
}

const xmb = await genXlsx();
const pmb = await genPptx();
console.log(`\n样本就绪：xlsx ${xmb.toFixed(0)}MB / pptx ${pmb.toFixed(0)}MB`);
