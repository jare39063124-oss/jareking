/**
 * T3.5 验收 —— 真实 .pptx round-trip 校验（parse → export → reparse）。
 *
 * 用法：node scripts/verify-pptx-roundtrip.mjs <目录或文件> [--out <输出目录>]
 * 依赖：先 `pnpm --filter @jareking/presentation build`。
 */
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parsePptx, exportPptx } from '../packages/presentation/dist/index.js';

function summarize(pres) {
  return pres.slides.map((s) => ({
    name: s.shapes.length ? (s.shapes[0].name ?? '?') : '(空)',
    shapes: s.shapes.length,
    textShapes: s.shapes.filter((x) => x.type === 'text').length,
    media: Object.keys(pres.media ?? {}).length,
  }));
}

async function verifyFile(file, outDir) {
  const buf = new Uint8Array(await readFile(file));
  const a = await parsePptx(buf);
  const re = await exportPptx(a);
  if (outDir) {
    await writeFile(path.join(outDir, `re-${path.basename(file)}`), re);
  }
  const b = await parsePptx(re);

  const sa = summarize(a);
  const sb = summarize(b);
  const issues = [];
  if (sa.length !== sb.length) issues.push(`页数 ${sa.length}→${sb.length}`);
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
    if (sb[i].shapes < sa[i].shapes) issues.push(`第${i + 1}页形状 ${sa[i].shapes}→${sb[i].shapes}（丢失）`);
    // 图片校验：该页被引用的图片数 ≤ 重解析该页 media 键数
    // （导出会重分配 rId 且清理孤儿图片关系——rels 有但无 pic 引用的残留，故按页聚合比对）
    const refs = a.slides[i].shapes.filter((x) => x.type === 'image').length;
    const bKeys = Object.keys(b.media ?? {}).filter((k) => k.startsWith(`${i}:`)).length;
    if (bKeys < refs) issues.push(`第${i + 1}页被引用图片 ${refs} → 仅 ${bKeys} 个有字节`);
    // 字节大小抽检：原 media 总字节 vs 重 media 总字节（同页同数时大小应一致）
    const aBytes = Object.entries(a.media ?? {}).filter(([k]) => k.startsWith(`${i}:`)).reduce((n, [, v]) => n + v.length, 0);
    const bBytes = Object.entries(b.media ?? {}).filter(([k]) => k.startsWith(`${i}:`)).reduce((n, [, v]) => n + v.length, 0);
    if (refs > 0 && bBytes < aBytes * 0.9) issues.push(`第${i + 1}页图片字节疑似丢失（${aBytes}→${bBytes}）`);
  }
  return { file: path.basename(file), sizeIn: buf.length, sizeOut: re.length, sa, sb, ok: issues.length === 0, issues };
}

async function collect(target) {
  const s = await stat(target);
  if (s.isFile()) return [target];
  const entries = await readdir(target, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && /\.pptx$/i.test(e.name))
    .map((e) => path.join(target, e.name));
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('用法: node verify-pptx-roundtrip.mjs <目录或文件> [--out <输出目录>]');
    process.exit(1);
  }
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? args[outIdx + 1] : null;
  if (outDir) await mkdir(outDir, { recursive: true });

  const files = await collect(args[0]);
  if (!files.length) {
    console.error('未找到 .pptx 文件');
    process.exit(1);
  }
  let pass = 0;
  for (const f of files) {
    try {
      const r = await verifyFile(f, outDir);
      console.log(`\n=== ${r.file} ===`);
      console.log(`  大小: ${r.sizeIn} → ${r.sizeOut} 字节 | 页数: ${r.sa.length}`);
      r.sa.forEach((s, i) => console.log(`  [第${i + 1}页 ${s.name}] 形状=${s.shapes} 文本=${s.textShapes}`));
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
