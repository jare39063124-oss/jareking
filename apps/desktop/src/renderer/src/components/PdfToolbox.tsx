/**
 * PdfToolbox —— PDF 工具箱面板（T5，融合用户自研「PDF页面工具箱」）。
 *
 * 入口：Ribbon「PDF 工具」标签页（一级标签页，卖点显性化）+「文件」标签页的 PDF 工具组。
 * 能力：页面提取/删除、合并、旋转、插入页面、页面替换、图片转 PDF、
 *       PDF 转 TXT（文本提取）、PDF 转图片（逐页光栅化）。
 * 页面操作经 @jareking/pdf 数据层（pdf-lib，本地离线）；文本/图片经 pdf.js。
 *
 * 当前模式由 uiStore.pdfToolboxMode 决定：Ribbon 点哪个按钮就以哪个模式打开；
 * 关闭弹窗不重置，下次打开保留上次（或由 Ribbon 重新指定）。
 */
import { useRef, useState } from 'react';
import {
  deletePages,
  extractPages,
  imagesToPdf,
  insertPages,
  mergePdfs,
  replacePages,
  rotatePages,
  pdfToText,
  type ImageInput,
} from '@jareking/pdf';
import { pdfToImages } from '../lib/pdfRender';
import { ArrowDown, ArrowUp, FileDown, Loader2, Plus, Scissors, Trash2, X } from 'lucide-react';
import { Button } from './Button';
import { Modal } from './Modal';
import { Select } from './Select';
import { toast } from '../stores/toastStore';
import { useUiStore, type PdfToolboxMode } from '../stores/uiStore';

type Mode = PdfToolboxMode;

const MODE_LABELS: { value: Mode; label: string }[] = [
  { value: 'extract', label: '提取 / 删除页' },
  { value: 'merge', label: '合并多个 PDF' },
  { value: 'rotate', label: '旋转页面' },
  { value: 'insert', label: '插入页面' },
  { value: 'replace', label: '替换页面' },
  { value: 'images', label: '图片转 PDF' },
  { value: 'toText', label: 'PDF 转 TXT' },
  { value: 'toImages', label: 'PDF 转图片' },
];

async function readBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

function download(bytes: Uint8Array, name: string, mime = 'application/pdf'): void {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 延迟回收，确保下载已触发
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const stamp = () => new Date().toISOString().slice(0, 10);

interface ImageResult {
  page: number;
  url: string;
  name: string;
}

export function PdfToolbox() {
  const open = useUiStore((s) => s.pdfToolboxOpen);
  const setOpen = useUiStore((s) => s.setPdfToolboxOpen);
  // 模式存 uiStore：由 Ribbon 的入口按钮决定，关闭弹窗不重置（下次打开保留上次）
  const mode = useUiStore((s) => s.pdfToolboxMode);
  const setMode = useUiStore((s) => s.setPdfToolboxMode);

  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [imageResults, setImageResults] = useState<ImageResult[]>([]);

  // 单文件模式：目标文件
  const [target, setTarget] = useState<File | null>(null);
  // 合并/图片模式：多文件列表（可排序）
  const [items, setItems] = useState<File[]>([]);
  // 插入/替换模式：来源文件
  const [source, setSource] = useState<File | null>(null);
  const [sourceSpec, setSourceSpec] = useState('');

  const [extractSpec, setExtractSpec] = useState('1-2');
  const [rotateDeg, setRotateDeg] = useState<'90' | '180' | '270'>('90');
  const [rotateSpec, setRotateSpec] = useState('all');
  const [insertPos, setInsertPos] = useState<'front' | 'back' | 'after'>('back');
  const [insertAfter, setInsertAfter] = useState('1');
  const [replaceTargetSpec, setReplaceTargetSpec] = useState('1');

  const targetInput = useRef<HTMLInputElement>(null);
  const multiInput = useRef<HTMLInputElement>(null);
  const sourceInput = useRef<HTMLInputElement>(null);

  const needSingle =
    mode === 'extract' ||
    mode === 'rotate' ||
    mode === 'insert' ||
    mode === 'replace' ||
    mode === 'toText' ||
    mode === 'toImages';
  const needMulti = mode === 'merge' || mode === 'images';
  const needSource = mode === 'insert' || mode === 'replace';

  const reset = () => {
    setNote(null);
    setTarget(null);
    setItems([]);
    setSource(null);
  };

  const revokeImages = (list: ImageResult[]) => list.forEach((r) => URL.revokeObjectURL(r.url));

  const run = async () => {
    setBusy(true);
    setNote(null);
    revokeImages(imageResults);
    try {
      let out: Uint8Array;
      let name = `jareking-pdf-${stamp()}.pdf`;
      if (mode === 'extract') {
        if (!target) throw new Error('请选择 PDF 文件');
        const isDelete = extractSpec.startsWith('del:');
        const spec = isDelete ? extractSpec.slice(4) : extractSpec;
        out = isDelete ? await deletePages(await readBytes(target), spec) : await extractPages(await readBytes(target), spec);
        name = `${target.name.replace(/\.pdf$/i, '')}-${isDelete ? '已删除' : '已提取'}.pdf`;
      } else if (mode === 'merge') {
        if (items.length < 2) throw new Error('请选择至少 2 个 PDF');
        const list: Uint8Array[] = [];
        for (const f of items) list.push(await readBytes(f));
        out = await mergePdfs(list);
        name = `合并文档-${stamp()}.pdf`;
      } else if (mode === 'rotate') {
        if (!target) throw new Error('请选择 PDF 文件');
        out = await rotatePages(await readBytes(target), rotateSpec, Number(rotateDeg) as 90 | 180 | 270);
        name = `${target.name.replace(/\.pdf$/i, '')}-已旋转.pdf`;
      } else if (mode === 'insert') {
        if (!target || !source) throw new Error('请选择目标 PDF 与来源 PDF');
        out = await insertPages(
          await readBytes(target),
          await readBytes(source),
          { type: insertPos, afterPage: insertPos === 'after' ? Number(insertAfter) : undefined },
          sourceSpec.trim() || undefined,
        );
        name = `${target.name.replace(/\.pdf$/i, '')}-已插入.pdf`;
      } else if (mode === 'replace') {
        if (!target || !source) throw new Error('请选择目标 PDF 与来源 PDF');
        out = await replacePages(
          await readBytes(target),
          await readBytes(source),
          replaceTargetSpec,
          sourceSpec.trim() || undefined,
        );
        name = `${target.name.replace(/\.pdf$/i, '')}-已替换.pdf`;
      } else if (mode === 'images') {
        if (!items.length) throw new Error('请选择至少 1 张图片');
        const imgs: ImageInput[] = [];
        for (const f of items) {
          const bytes = await readBytes(f);
          imgs.push({ bytes, type: /\.png$/i.test(f.name) ? 'png' : 'jpg' });
        }
        out = await imagesToPdf(imgs);
        name = `图片合并-${stamp()}.pdf`;
      } else if (mode === 'toText') {
        if (!target) throw new Error('请选择 PDF 文件');
        const text = await pdfToText(await readBytes(target));
        const enc = new TextEncoder().encode(text);
        const txtName = `${target.name.replace(/\.pdf$/i, '')}-文本.txt`;
        download(enc, txtName, 'text/plain;charset=utf-8');
        setImageResults([]);
        setNote(`✅ 已提取文本（${text.length} 字），已导出「${txtName}」`);
        toast.success('PDF 转 TXT 完成');
        return;
      } else {
        // toImages：逐页渲染为 PNG，结果区预览 + 下载
        if (!target) throw new Error('请选择 PDF 文件');
        const pages = await pdfToImages(await readBytes(target));
        const results: ImageResult[] = pages.map((p) => {
          const blob = new Blob([p.png], { type: 'image/png' });
          const url = URL.createObjectURL(blob);
          return { page: p.page, url, name: `${target.name.replace(/\.pdf$/i, '')}-第${p.page}页.png` };
        });
        setImageResults(results);
        setNote(`✅ 已渲染 ${results.length} 页为 PNG`);
        toast.success(`PDF 转图片完成：${results.length} 页`);
        return;
      }
      download(out, name);
      setImageResults([]);
      setNote(`✅ 已导出「${name}」`);
      toast.success(`PDF 处理完成：${name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNote(`❌ ${msg}`);
      toast.warning(`处理失败：${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const downloadAllImages = () => {
    imageResults.forEach((r, idx) => {
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = r.url;
        a.download = r.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, idx * 250);
    });
  };

  const canRun =
    !busy &&
    ((needSingle && !!target && (!needSource || !!source)) ||
      (needMulti && (mode === 'merge' ? items.length >= 2 : items.length >= 1)));

  return (
    <Modal open={open} onClose={() => setOpen(false)} title="PDF 工具箱" width={680}>
      <div className="flex flex-col gap-4">
        {/* 模式切换 */}
        <div className="flex flex-wrap gap-1.5">
          {MODE_LABELS.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => {
                setMode(m.value);
                reset();
              }}
              className={`rounded-full border px-3 py-1 text-tiny transition-colors ${
                mode === m.value
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border text-muted hover:bg-hover hover:text-fg'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        <p className="text-tiny text-muted">
          本地离线处理，文件不上传。页码规格支持 <code>1,3-5</code>、<code>last</code>（末页）。
        </p>

        {/* 目标文件（单文件模式） */}
        {needSingle && (
          <div className="flex items-center gap-2">
            <span className="w-20 shrink-0 text-body text-fg">目标 PDF</span>
            <Button variant="secondary" size="sm" onClick={() => targetInput.current?.click()}>
              {target ? target.name : '选择文件'}
            </Button>
            {target && (
              <button type="button" className="text-muted hover:text-red-500" onClick={() => setTarget(null)}>
                <X size={14} />
              </button>
            )}
            <input
              ref={targetInput}
              type="file"
              accept=".pdf"
              className="hidden"
              onChange={(e) => setTarget(e.target.files?.[0] ?? null)}
            />
          </div>
        )}

        {/* 提取/删除 */}
        {mode === 'extract' && (
          <div className="flex items-center gap-2">
            <span className="w-20 shrink-0 text-body text-fg">页码</span>
            <input
              className="h-7 min-w-0 flex-1 rounded border border-border bg-surface px-2 text-body text-fg outline-none"
              value={extractSpec}
              onChange={(e) => setExtractSpec(e.target.value)}
              placeholder="提取：1-2 ｜ 删除：del:3-4"
            />
            <span className="text-tiny text-muted">删除页请输入 del:页码</span>
          </div>
        )}

        {/* 旋转 */}
        {mode === 'rotate' && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-20 shrink-0 text-body text-fg">旋转</span>
            <Select
              className="w-28"
              value={rotateDeg}
              options={[
                { value: '90', label: '90 度' },
                { value: '180', label: '180 度' },
                { value: '270', label: '270 度' },
              ]}
              onChange={(v) => setRotateDeg(v as '90')}
            />
            <span className="text-body text-fg">范围</span>
            <input
              className="h-7 w-28 rounded border border-border bg-surface px-2 text-body text-fg outline-none"
              value={rotateSpec}
              onChange={(e) => setRotateSpec(e.target.value)}
              placeholder="all 或 1-3"
            />
          </div>
        )}

        {/* 插入/替换：来源文件 + 位置 */}
        {needSource && (
          <>
            <div className="flex items-center gap-2">
              <span className="w-20 shrink-0 text-body text-fg">来源 PDF</span>
              <Button variant="secondary" size="sm" onClick={() => sourceInput.current?.click()}>
                {source ? source.name : '选择文件'}
              </Button>
              {source && (
                <button type="button" className="text-muted hover:text-red-500" onClick={() => setSource(null)}>
                  <X size={14} />
                </button>
              )}
              <span className="text-body text-fg">来源页码</span>
              <input
                className="h-7 w-20 rounded border border-border bg-surface px-2 text-body text-fg outline-none"
                value={sourceSpec}
                onChange={(e) => setSourceSpec(e.target.value)}
                placeholder="留空=全部"
              />
              <input
                ref={sourceInput}
                type="file"
                accept=".pdf"
                className="hidden"
                onChange={(e) => setSource(e.target.files?.[0] ?? null)}
              />
            </div>
            {mode === 'insert' ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-20 shrink-0 text-body text-fg">位置</span>
                <Select
                  className="w-32"
                  value={insertPos}
                  options={[
                    { value: 'front', label: '最前面' },
                    { value: 'back', label: '最后面' },
                    { value: 'after', label: '指定页之后' },
                  ]}
                  onChange={(v) => setInsertPos(v as 'back')}
                />
                {insertPos === 'after' && (
                  <>
                    <span className="text-body text-fg">页</span>
                    <input
                      className="h-7 w-16 rounded border border-border bg-surface px-2 text-body text-fg outline-none"
                      value={insertAfter}
                      onChange={(e) => setInsertAfter(e.target.value)}
                    />
                  </>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-body text-fg">被替换页</span>
                <input
                  className="h-7 w-28 rounded border border-border bg-surface px-2 text-body text-fg outline-none"
                  value={replaceTargetSpec}
                  onChange={(e) => setReplaceTargetSpec(e.target.value)}
                  placeholder="如 1 或 1-5"
                />
                <span className="text-tiny text-muted">来源页数须与被替换页数一致</span>
              </div>
            )}
          </>
        )}

        {/* 多文件（合并/图片） */}
        {needMulti && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="w-20 shrink-0 text-body text-fg">文件列表</span>
              <Button variant="secondary" size="sm" icon={<Plus size={13} />} onClick={() => multiInput.current?.click()}>
                添加{mode === 'images' ? '图片' : ' PDF'}
              </Button>
              <span className="text-tiny text-muted">
                {mode === 'merge' ? '按列表顺序合并（可上移/下移调整）' : '按列表顺序生成页面'}
              </span>
              <input
                ref={multiInput}
                type="file"
                multiple
                accept={mode === 'images' ? 'image/*' : '.pdf'}
                className="hidden"
                onChange={(e) => {
                  const added = Array.from(e.target.files ?? []);
                  if (added.length) setItems((prev) => [...prev, ...added]);
                  e.target.value = '';
                }}
              />
            </div>
            {items.length > 0 && (
              <div className="flex max-h-40 flex-col gap-1 overflow-auto rounded border border-border p-1.5">
                {items.map((f, i) => (
                  <div key={`${f.name}-${i}`} className="flex items-center gap-1.5 text-tiny text-fg">
                    <span className="w-6 text-muted">{i + 1}.</span>
                    <span className="min-w-0 flex-1 truncate">{f.name}</span>
                    <button
                      type="button"
                      title="上移"
                      className="text-muted hover:text-fg disabled:opacity-30"
                      disabled={i === 0}
                      onClick={() => setItems((prev) => prev.map((x, j) => (j === i ? prev[i - 1] : j === i - 1 ? x : x)))}
                    >
                      <ArrowUp size={12} />
                    </button>
                    <button
                      type="button"
                      title="下移"
                      className="text-muted hover:text-fg disabled:opacity-30"
                      disabled={i === items.length - 1}
                      onClick={() => setItems((prev) => prev.map((x, j) => (j === i ? prev[i + 1] : j === i + 1 ? x : x)))}
                    >
                      <ArrowDown size={12} />
                    </button>
                    <button
                      type="button"
                      title="移除"
                      className="text-muted hover:text-red-500"
                      onClick={() => setItems((prev) => prev.filter((_, j) => j !== i))}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* PDF 转图片：渲染结果预览 */}
        {mode === 'toImages' && imageResults.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-tiny text-muted">已渲染 {imageResults.length} 页</span>
              <Button variant="secondary" size="sm" onClick={downloadAllImages}>
                下载全部
              </Button>
            </div>
            <div className="grid max-h-64 grid-cols-3 gap-2 overflow-auto rounded border border-border p-2">
              {imageResults.map((r) => (
                <div key={r.page} className="flex flex-col items-center gap-1">
                  <img
                    src={r.url}
                    alt={`第 ${r.page} 页`}
                    className="h-28 w-full rounded border border-border bg-white object-contain"
                  />
                  <div className="flex w-full items-center justify-between">
                    <span className="text-tiny text-muted">第 {r.page} 页</span>
                    <button
                      type="button"
                      className="text-tiny text-accent hover:underline"
                      onClick={() => {
                        const a = document.createElement('a');
                        a.href = r.url;
                        a.download = r.name;
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                      }}
                    >
                      下载
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 结果与执行 */}
        {note && <div className="rounded bg-muted-bg px-3 py-2 text-tiny text-fg">{note}</div>}
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-tiny text-muted">
            <Scissors size={12} /> 处理在本地完成
          </span>
          <Button
            variant="primary"
            size="sm"
            icon={busy ? <Loader2 size={13} className="animate-spin" /> : <FileDown size={13} />}
            disabled={!canRun}
            onClick={() => void run()}
          >
            {busy ? '处理中…' : '开始处理'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
