/**
 * T2.7 Phase 验收 —— 真实 .xlsx round-trip 校验工具（与 verify-docx-roundtrip.mjs 配套）。
 *
 * 用法：node scripts/verify-xlsx-roundtrip.mjs <目录或文件> [--out <输出目录>]
 * 流程：parseXlsx → exportXlsx（重新保存）→ parseXlsx，比对每张表的
 * 单元格数/合并数/尺寸，输出是否「结构无丢失」。
 * 依赖：先 `pnpm --filter @jareking/sheet build`。
 */
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseXlsx, exportXlsx } from '../packages/sheet/dist/index.js';

function summarize(wb) {
  return wb.sheets.map((s) => ({
    name: s.name,
    cells: Object.keys(s.cells).length,
    merges: s.merges.length,
    formulas: Object.values(s.cells).filter((c) => c.formula).length,
    hidden: !!s.hidden,
  }));
}

async function verifyFile(file, outDir) {
  const buf = new Uint8Array(await readFile(file));
  const a = await parseXlsx(buf);
  const re = await exportXlsx(a);
  if (outDir) {
    await writeFile(path.join(outDir, `re-${path.basename(file)}`), re);
  }
  const b = await parseXlsx(re);

  const sa = summarize(a);
  const sb = summarize(b);
  const issues = [];
  if (sa.length !== sb.length) issues.push(`sheet 数 ${sa.length}→${sb.length}`);
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
    if (sa[i].name !== sb[i].name) issues.push(`sheet[${i}] 名 ${sa[i].name}→${sb[i].name}`);
    if (sb[i].cells < sa[i].cells) issues.push(`[${sa[i].name}] 单元格 ${sa[i].cells}→${sb[i].cells}（丢失）`);
    if (sb[i].merges < sa[i].merges) issues.push(`[${sa[i].name}] 合并 ${sa[i].merges}→${sb[i].merges}（丢失）`);
    if (sb[i].formulas < sa[i].formulas) issues.push(`[${sa[i].name}] 公式 ${sa[i].formulas}→${sb[i].formulas}（丢失）`);
  }
  return { file: path.basename(file), sizeIn: buf.length, sizeOut: re.length, sa, sb, ok: issues.length === 0, issues };
}

async function collect(target) {
  const s = await stat(target);
  if (s.isFile()) return [target];
  const entries = await readdir(target, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && /\.(xlsx|xlsm)$/i.test(e.name))
    .map((e) => path.join(target, e.name));
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('用法: node verify-xlsx-roundtrip.mjs <目录或文件> [--out <输出目录>]');
    process.exit(1);
  }
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? args[outIdx + 1] : null;
  if (outDir) await mkdir(outDir, { recursive: true });

  const files = await collect(args[0]);
  if (!files.length) {
    console.error('未找到 .xlsx 文件');
    process.exit(1);
  }
  let pass = 0;
  for (const f of files) {
    try {
      const r = await verifyFile(f, outDir);
      console.log(`\n=== ${r.file} ===`);
      console.log(`  大小: ${r.sizeIn} → ${r.sizeOut} 字节 | sheets: ${r.sa.length}`);
      for (const s of r.sa) console.log(`  [${s.name}] 格=${s.cells} 并=${s.merges} 式=${s.formulas}${s.hidden ? ' (隐藏)' : ''}`);
      console.log(`  结论: ${r.ok ? '✅ 结构一致' : `❌ ${r.issues.join('; ')}`}`);
      if (r.ok) pass += 1;
    } catch (err) {
      console.log(`\n=== ${path.basename(f)} ===`);
      console.log(`  ❌ 处理失败: ${err.message}`);
    }
  }
  console.log(`\n汇总: ${pass}/${files.length} 通过`);
  process.exit(pass === files.length ? 0 : 2);
}

main().catch((e) => { console.error(e); process.exit(1); });
