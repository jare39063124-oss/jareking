/**
 * T1.8 Phase 验收 —— 真实 .docx round-trip 校验工具（真实机器运行）。
 *
 * 用法：
 *   node scripts/verify-docx-roundtrip.mjs <目录或文件> [--out <输出目录>]
 *
 * 流程：对每个 .docx 执行「parseDocx → exportDocx（重新保存）→ parseDocx」
 * 并比对两次解析的结构计数与保真报告，输出是否「格式无可见丢失」。
 *
 * 依赖：先构建 writer 包（`pnpm --filter @jareking/writer build`），
 * 本脚本从 packages/writer/dist/index.js 引入解析/导出能力。
 *
 * 说明：本工具覆盖「数据侧」保真；视觉效果（分页/页眉页脚/精确版式）
 * 仍需在 Word/WPS 中人工打开导出的 .docx 复核。
 */
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocx, exportDocx } from '../packages/writer/dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function countBlocks(doc) {
  let paragraphs = 0;
  let tables = 0;
  let headings = 0;
  const walk = (blocks = []) => {
    for (const b of blocks) {
      if (b.type === 'paragraph') {
        paragraphs += 1;
        if (b.pPr?.outlineLvl !== undefined) headings += 1;
      } else if (b.type === 'table') {
        tables += 1;
        b.rows?.forEach((r) => r.cells?.forEach((c) => walk(c.blocks)));
      }
    }
  };
  walk(doc.body);
  return { paragraphs, tables, headings };
}

function countImages(doc) {
  const rels = (doc.relationships ?? []).filter((r) => r.type === 'image');
  return { imageRels: rels.length, mediaBytes: Object.keys(doc.media ?? {}).length };
}

function shortFidelity(doc) {
  return {
    level: doc.fidelity?.level,
    features: (doc.fidelity?.features ?? []).map((f) => f.kind || f.label || String(f)),
  };
}

async function verifyFile(file, outDir) {
  const buf = new Uint8Array(await readFile(file));
  const a = await parseDocx(buf);
  const reExported = await exportDocx(a);
  if (outDir) {
    const name = path.basename(file);
    await writeFile(path.join(outDir, `re-${name}`), reExported);
  }
  const b = await parseDocx(reExported);

  const ca = countBlocks(a);
  const cb = countBlocks(b);
  const ia = countImages(a);
  const ib = countImages(b);

  const ok =
    ca.paragraphs === cb.paragraphs &&
    ca.tables === cb.tables &&
    ca.headings === cb.headings &&
    ib.imageRels >= ia.imageRels; // 重新保存后图片关系不应减少

  return {
    file: path.basename(file),
    sizeIn: buf.length,
    sizeOut: reExported.length,
    blocksA: ca,
    blocksB: cb,
    imagesA: ia,
    imagesB: ib,
    fidelityAfter: shortFidelity(b),
    ok,
  };
}

async function collectDocx(target) {
  const s = await stat(target);
  if (s.isFile()) return [target];
  const entries = await readdir(target, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.docx'))
    .map((e) => path.join(target, e.name));
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('用法: node verify-docx-roundtrip.mjs <目录或文件> [--out <输出目录>]');
    process.exit(1);
  }
  const target = args[0];
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? args[outIdx + 1] : null;
  if (outDir) await mkdir(outDir, { recursive: true });

  const files = await collectDocx(target);
  if (!files.length) {
    console.error('未找到任何 .docx 文件');
    process.exit(1);
  }

  let pass = 0;
  for (const f of files) {
    try {
      const r = await verifyFile(f, outDir);
      console.log(`\n=== ${r.file} ===`);
      console.log(`  大小: ${r.sizeIn} → ${r.sizeOut} 字节`);
      console.log(`  结构: 段=${r.blocksA.paragraphs}→${r.blocksB.paragraphs} 表=${r.blocksA.tables}→${r.blocksB.tables} 标题=${r.blocksA.headings}→${r.blocksB.headings}`);
      console.log(`  图片: 关系=${r.imagesA.imageRels}→${r.imagesB.imageRels} 媒体=${r.imagesA.mediaBytes}→${r.imagesB.mediaBytes}`);
      console.log(`  保真(再解析): L=${r.fidelityAfter.level} 降级=${r.fidelityAfter.features.length ? r.fidelityAfter.features.join(',') : '无'}`);
      console.log(`  结论: ${r.ok ? '✅ 结构一致' : '❌ 结构变化，需复核'}`);
      if (r.ok) pass += 1;
    } catch (err) {
      console.log(`\n=== ${path.basename(f)} ===`);
      console.log(`  ❌ 处理失败: ${err.message}`);
    }
  }
  console.log(`\n汇总: ${pass}/${files.length} 通过`);
  process.exit(pass === files.length ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
