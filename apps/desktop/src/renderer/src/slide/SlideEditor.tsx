/**
 * SlideEditor —— 基于 Konva（react-konva）的幻灯片编辑器（T3.2）。
 *
 * 职责：
 *  - 左侧幻灯片缩略列表（切换/新增/删除页）
 *  - 中央 Konva 舞台：按 EMU→px 比例渲染 文本框/预设形状/图片，可选中、拖拽移动、双击改文字
 *  - 工具栏：添加文本框/矩形/椭圆/图片、删除、打开/保存 .pptx（经 @jareking/presentation 数据层）
 *  - 图片：插入文件 → dataURL 展示 + 字节存入 media（键 `${slideIdx}:${relId}`）→ 保存落盘
 *
 * v1 范围：基础编辑（移动/文字/增删）；缩放变换手柄、多选、动画后续迭代。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Group, Image as KImage, Layer, Rect, Stage, Text as KText, Ellipse } from 'react-konva';
import type Konva from 'konva';
import {
  Circle,
  Copy,
  Download,
  FolderOpen,
  ImageIcon,
  Play,
  Plus,
  Sparkles,
  Square,
  Trash2,
  Type,
} from 'lucide-react';
import { createAiAdapter, createPresentationPlanner, type PresentationOp } from '@jareking/ai';
import { exportPptx, parsePptx, type JkPresentation, type JkShape, type JkSlide } from '@jareking/presentation';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { toast } from '../stores/toastStore';
import { useAiStore } from '../stores/aiStore';
import { SlideshowOverlay } from './SlideshowOverlay';

/** 舞台像素宽（画布 EMU 宽按比例缩放） */
const STAGE_W = 896;
const STAGE_H = 504;

/** 便捷构造：带唯一 id */
let idSeq = 0;
const nextId = () => `shp-${Date.now().toString(36)}-${idSeq++}`;

function withIds(slide: JkSlide): JkSlide {
  return { ...slide, shapes: slide.shapes.map((s) => ({ ...s, id: s.id ?? nextId() })) };
}

/** 演示文稿（首载） */
function demoPresentation(): JkPresentation {
  return {
    slides: [
      {
        shapes: [
          {
            type: 'text',
            id: nextId(),
            name: '标题',
            x: 914400,
            y: 685800,
            w: 7315200,
            h: 1143000,
            paragraphs: [
              {
                runs: [{ text: 'jareking 演示文稿', bold: true, fontSize: 40, color: '#1F3864' }],
                align: 'center',
              },
            ],
          },
          {
            type: 'shape',
            id: nextId(),
            name: '强调块',
            geom: 'roundRect',
            x: 1371600,
            y: 2377440,
            w: 2743200,
            h: 914400,
            fill: '#4472C4',
            paragraphs: [
              { runs: [{ text: 'Konva 画布', bold: true, fontSize: 18, color: '#FFFFFF' }], align: 'center' },
            ],
          },
          {
            type: 'text',
            id: nextId(),
            name: '要点',
            x: 4800600,
            y: 2377440,
            w: 3200400,
            h: 1828800,
            paragraphs: [
              { runs: [{ text: '大纲级别 1', fontSize: 18 }], level: 1, bullet: true },
              { runs: [{ text: '大纲级别 2', fontSize: 16 }], level: 2, bullet: true },
            ],
          },
        ],
      },
      {
        shapes: [
          {
            type: 'text',
            id: nextId(),
            name: '第二页',
            x: 2743200,
            y: 2286000,
            w: 3657600,
            h: 914400,
            paragraphs: [{ runs: [{ text: '第二页：待你编辑', fontSize: 28 }], align: 'center' }],
          },
        ],
      },
    ],
    slideWidth: 9144000,
    slideHeight: 6858000,
    media: {},
  };
}

/** 文本形状 → 纯文本（编辑用） */
function paragraphsToText(shape: JkShape): string {
  if (shape.type === 'image') return '';
  return (shape.paragraphs ?? []).map((p) => p.runs.map((r) => r.text).join('')).join('\n');
}

/** 纯文本 → 段落（沿用首个 run 的格式） */
function textToParagraphs(text: string, shape: JkShape): JkShape['paragraphs'] {
  if (shape.type === 'image') return undefined;
  const first = shape.paragraphs?.[0];
  const style = first?.runs?.[0];
  const base = style ? { ...style } : { text: '' };
  return text.split('\n').map((line, i) => ({
    runs: [{ ...base, text: line }],
    align: first?.align,
    level: i === 0 ? first?.level : undefined,
    bullet: i === 0 ? first?.bullet : undefined,
  }));
}

/** media 字节 → dataURL */
function bytesToDataUrl(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:image/png;base64,${btoa(bin)}`;
}

/** 加载 dataURL → HTMLImageElement（Konva.Image 需要） */
function useLoadedImages(urls: string[]): Record<string, HTMLImageElement> {
  const [loaded, setLoaded] = useState<Record<string, HTMLImageElement>>({});
  const key = urls.join('|');
  useEffect(() => {
    let alive = true;
    const next: Record<string, HTMLImageElement> = {};
    void Promise.all(
      urls.map(
        (u) =>
          new Promise<void>((res) => {
            const img = new window.Image();
            img.onload = () => {
              next[u] = img;
              res();
            };
            img.onerror = () => res();
            img.src = u;
          }),
      ),
    ).then(() => {
      if (alive) setLoaded(next);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return loaded;
}

export function SlideEditor() {
  const [pres, setPres] = useState<JkPresentation>(demoPresentation);
  const [slideIdx, setSlideIdx] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);
  const [playing, setPlaying] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [aiInstruction, setAiInstruction] = useState('');
  const aiInstructionRef = useRef('');
  const configs = useAiStore((st) => st.configs);
  const aiLoaded = useAiStore((st) => st.loaded);
  const loadAiConfigs = useAiStore((st) => st.load);
  const resolveKey = useAiStore((st) => st.resolveKey);

  useEffect(() => {
    if (!aiLoaded) void loadAiConfigs();
  }, [aiLoaded, loadAiConfigs]);

  // F5 放映（拦截浏览器默认刷新）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F5') {
        e.preventDefault();
        setPlaying(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const slide: JkSlide | undefined = pres.slides[slideIdx];
  const scale = STAGE_W / pres.slideWidth;

  // 图片 dataURL（当前页）
  const imageUrls = useMemo(() => {
    if (!slide) return [];
    return slide.shapes
      .filter((s) => s.type === 'image')
      .map((s) => `${s.id}`)
      .map((key) => {
        const bytes = pres.media?.[`${slideIdx}:${key}`];
        return bytes ? bytesToDataUrl(bytes) : '';
      });
  }, [slide, pres.media, slideIdx]);
  const loadedImages = useLoadedImages(imageUrls.filter(Boolean));

  /** 更新当前页形状（不可变） */
  const updateShapes = (fn: (shapes: JkShape[]) => JkShape[]) => {
    setPres((prev) => {
      const slides = [...prev.slides];
      slides[slideIdx] = { ...slides[slideIdx], shapes: fn(slides[slideIdx].shapes) };
      return { ...prev, slides };
    });
  };

  const onSelect = (id: string | null) => setSelectedId(id);

  const onDragEnd = (id: string, x: number, y: number) => {
    updateShapes((shapes) =>
      shapes.map((s) =>
        s.id === id ? { ...s, x: Math.round(x / scale), y: Math.round(y / scale) } : s,
      ),
    );
  };

  const onEditText = (id: string) => {
    const shape = slide?.shapes.find((s) => s.id === id);
    if (!shape || shape.type === 'image') return;
    const next = window.prompt('编辑文字（换行分段）：', paragraphsToText(shape));
    if (next === null) return;
    updateShapes((shapes) =>
      shapes.map((s) =>
        s.id === id ? ({ ...s, paragraphs: textToParagraphs(next, s) } as JkShape) : s,
      ),
    );
  };

  const addShape = (kind: 'text' | 'rect' | 'ellipse') => {
    const cx = (pres.slideWidth - 2743200) / 2;
    const cy = (pres.slideHeight - 914400) / 2;
    let shape: JkShape;
    if (kind === 'text') {
      shape = {
        type: 'text',
        id: nextId(),
        name: '文本框',
        x: cx,
        y: cy,
        w: 2743200,
        h: 914400,
        paragraphs: [{ runs: [{ text: '新建文本', fontSize: 20 }] }],
      };
    } else if (kind === 'rect') {
      shape = { type: 'shape', id: nextId(), name: '矩形', geom: 'rect', x: cx, y: cy, w: 1828800, h: 1143000, fill: '#4472C4' };
    } else {
      shape = { type: 'shape', id: nextId(), name: '椭圆', geom: 'ellipse', x: cx, y: cy, w: 1828800, h: 1828800, fill: '#ED7D31' };
    }
    updateShapes((shapes) => [...shapes, shape]);
    setSelectedId(shape.id!);
  };

  const addImage = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const relId = `img-${Date.now().toString(36)}`;
    const cx = (pres.slideWidth - 2743200) / 2;
    const cy = (pres.slideHeight - 1828800) / 2;
    setPres((prev) => {
      const slides = [...prev.slides];
      slides[slideIdx] = {
        ...slides[slideIdx],
        shapes: [
          ...slides[slideIdx].shapes,
          { type: 'image', id: nextId(), relId, x: cx, y: cy, w: 2743200, h: 1828800 },
        ],
      };
      return {
        ...prev,
        slides,
        media: { ...prev.media, [`${slideIdx}:${relId}`]: bytes },
      };
    });
    toast.success('已插入图片');
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    updateShapes((shapes) => shapes.filter((s) => s.id !== selectedId));
    setSelectedId(null);
  };

  const duplicateSelected = () => {
    const shape = slide?.shapes.find((s) => s.id === selectedId);
    if (!shape) return;
    const copy = { ...shape, id: nextId(), name: `${shape.name ?? '形状'} 副本`, x: shape.x + 228600, y: shape.y + 228600 };
    updateShapes((shapes) => [...shapes, copy]);
    setSelectedId(copy.id!);
  };

  const addSlide = () => {
    setPres((prev) => {
      const slides = [...prev.slides];
      slides.splice(slideIdx + 1, 0, { shapes: [] });
      return { ...prev, slides };
    });
    setSlideIdx((i) => i + 1);
  };

  const deleteSlide = () => {
    if (pres.slides.length <= 1) {
      toast.warning('至少保留一页');
      return;
    }
    setPres((prev) => ({ ...prev, slides: prev.slides.filter((_, i) => i !== slideIdx) }));
    setSlideIdx((i) => Math.max(0, i - 1));
  };

  /** T4.6：大纲 → 成稿（Presentation Planner → addSlide ops → 追加幻灯片） */
  const runPresentationAi = async (instruction: string) => {
    if (!instruction || aiBusy) return;
    const config = configs.find((c) => c.enabled);
    if (!config) {
      toast.warning('请先在「设置 → AI 服务商」配置并启用一个服务商');
      return;
    }
    setAiBusy(true);
    setAiNote('AI 生成中…');
    try {
      const key = await resolveKey(config.id);
      const adapter = createAiAdapter(config, key);
      const planner = createPresentationPlanner({ adapter });
      const plan = await planner.planPresentation(instruction, {
        slideCount: pres.slides.length,
        outline: pres.slides
          .map((sl, i) => `第${i + 1}页：${sl.shapes.find((x) => x.type === 'text' && (x as JkShape & { paragraphs?: unknown }).paragraphs)?.name ?? ''}`)
          .join('；'),
      });
      if (!plan.ops.length) {
        setAiNote(plan.explanation || '（无生成内容）');
        return;
      }
      const newSlides = plan.ops
        .filter((o): o is Extract<PresentationOp, { op: 'addSlide' }> => o.op === 'addSlide')
        .map(buildSlideFromOp);
      setPres((prev) => ({ ...prev, slides: [...prev.slides, ...newSlides] }));
      setSlideIdx(pres.slides.length);
      setAiNote(`${plan.explanation || '已生成'} · 新增 ${newSlides.length} 页`);
      toast.success(`AI 已生成 ${newSlides.length} 页幻灯片`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAiNote(`失败：${msg}`);
      toast.warning(`AI 生成失败：${msg}`);
    } finally {
      setAiBusy(false);
    }
  };

  /** 调试钩子（--jk-debug）：供自动化冒烟断言与触发 */
  const aiRunRef = useRef(runPresentationAi);
  aiRunRef.current = runPresentationAi;
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('jk-debug')) {
      (window as unknown as Record<string, unknown>).__jkSlideDebug = {
        runPresentationAi: (instruction: string) => aiRunRef.current(instruction),
        slideCount: () => pres.slides.length,
      };
    }
  });

  /** T4.6：addSlide op → 排版为标题 + 要点文本框 */
  const buildSlideFromOp = (op: Extract<PresentationOp, { op: 'addSlide' }>): JkSlide => ({
    shapes: [
      {
        type: 'text',
        id: nextId(),
        name: op.title.slice(0, 12) || '标题',
        x: 914400,
        y: 457200,
        w: 7315200,
        h: 914400,
        paragraphs: [{ runs: [{ text: op.title, bold: true, fontSize: 32, color: '#1F3864' }], align: 'center' }],
      },
      ...(op.bullets.length
        ? [
            {
              type: 'text' as const,
              id: nextId(),
              name: '要点',
              x: 1143000,
              y: 1828800,
              w: 6858000,
              h: 3657600,
              paragraphs: op.bullets.map((b) => ({
                runs: [{ text: b, fontSize: 20 }],
                level: 1,
                bullet: true,
              })),
            },
          ]
        : []),
    ],
  });

  const onOpenFile = () => fileInputRef.current?.click();

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const loaded = await parsePptx(buf);
      setPres({ ...loaded, slides: loaded.slides.map(withIds) });
      setSlideIdx(0);
      setSelectedId(null);
      toast.success(`已打开 ${file.name}`);
    } catch {
      toast.warning('打开失败：文件可能不是有效的 .pptx');
    }
  };

  const onSave = async () => {
    try {
      const buf = await exportPptx(pres);
      const blob = new Blob([buf], {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '导出.pptx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('已导出「导出.pptx」');
    } catch {
      toast.warning('导出失败');
    }
  };

  /** 渲染单个形状（Konva 节点） */
  const renderShape = (shape: JkShape, idx: number) => {
    const x = shape.x * scale;
    const y = shape.y * scale;
    const w = shape.w * scale;
    const h = shape.h * scale;
    const selected = shape.id === selectedId;
    const common = {
      x,
      y,
      rotation: shape.rotation,
      draggable: true,
      onClick: () => onSelect(shape.id!),
      onTap: () => onSelect(shape.id!),
      onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) =>
        onDragEnd(shape.id!, e.target.x(), e.target.y()),
      onDblClick: () => onEditText(shape.id!),
    };

    if (shape.type === 'image') {
      const url = imageUrls[idx] || '';
      const el = loadedImages[url];
      return (
        <Group key={shape.id} {...common}>
          {el ? (
            <KImage image={el} width={w} height={h} stroke={selected ? '#2563EB' : undefined} strokeWidth={selected ? 2 : 0} />
          ) : (
            <Rect width={w} height={h} fill="#E5E7EB" />
          )}
        </Group>
      );
    }

    if (shape.type === 'shape') {
      const fill = shape.fill ?? '#94A3B8';
      const body =
        shape.geom === 'ellipse' ? (
          <Ellipse x={w / 2} y={h / 2} radiusX={w / 2} radiusY={h / 2} fill={fill} stroke={selected ? '#2563EB' : undefined} strokeWidth={selected ? 2 : 0} />
        ) : (
          <Rect width={w} height={h} cornerRadius={shape.geom === 'roundRect' ? 8 : 0} fill={fill} stroke={selected ? '#2563EB' : undefined} strokeWidth={selected ? 2 : 0} />
        );
      const plain = paragraphsToText(shape);
      return (
        <Group key={shape.id} {...common}>
          {body}
          {plain ? (
            <KText
              text={plain}
              width={w}
              height={h}
              align="center"
              verticalAlign="middle"
              fontSize={(shape.paragraphs?.[0]?.runs?.[0]?.fontSize ?? 18) * 1.333 * scale}
              fill={shape.paragraphs?.[0]?.runs?.[0]?.color ?? '#FFFFFF'}
              listening={false}
            />
          ) : null}
        </Group>
      );
    }

    // text
    const plain = paragraphsToText(shape);
    const firstRun = shape.paragraphs?.[0]?.runs?.[0];
    const align = shape.paragraphs?.[0]?.align ?? 'left';
    const bulletLines = shape.paragraphs?.map((p) => (p.bullet ? '• ' : '')).join('');
    void bulletLines;
    const lines = shape.paragraphs?.map((p) => {
      const txt = p.runs.map((r) => r.text).join('');
      return p.bullet ? `• ${txt}` : txt;
    });
    return (
      <Group key={shape.id} {...common}>
        {selected ? <Rect width={w} height={h} stroke="#2563EB" dash={[4, 4]} strokeWidth={1.5} /> : null}
        <KText
          text={(lines ?? [plain]).join('\n')}
          width={w}
          align={align}
          fontSize={(firstRun?.fontSize ?? 18) * 1.333 * scale}
          fontStyle={`${firstRun?.bold ? 'bold ' : ''}${firstRun?.italic ? 'italic' : ''}`.trim() || 'normal'}
          fill={firstRun?.color ?? '#1F2937'}
        />
      </Group>
    );
  };

  return (
    <div className="flex h-full w-full min-h-0">
      {/* 左：幻灯片列表 */}
      <div className="flex w-40 shrink-0 flex-col overflow-auto border-r border-border bg-surface p-2">
        <div className="mb-1 flex items-center justify-between px-1">
          <span className="text-tiny text-muted">幻灯片</span>
          <button type="button" className="rounded p-1 hover:bg-muted" title="新增幻灯片" onClick={addSlide}>
            <Plus size={14} />
          </button>
        </div>
        {pres.slides.map((s, i) => (
          <button
            key={i}
            type="button"
            className={`mb-1 flex h-[62px] w-full items-center justify-center rounded border text-tiny ${
              i === slideIdx ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted hover:bg-muted'
            }`}
            onClick={() => {
              setSlideIdx(i);
              setSelectedId(null);
            }}
          >
            第 {i + 1} 页
          </button>
        ))}
        <Button variant="ghost" size="sm" icon={<Trash2 size={13} />} onClick={deleteSlide} className="mt-1">
          删除本页
        </Button>
      </div>

      {/* 右：工具栏 + 画布 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-2">
          <Button variant="secondary" size="sm" icon={<FolderOpen size={13} />} onClick={onOpenFile}>
            打开
          </Button>
          <Button variant="primary" size="sm" icon={<Download size={13} />} onClick={onSave}>
            保存
          </Button>
          <span className="mx-1 h-5 w-px bg-border" />
          <Button variant="ghost" size="sm" icon={<Type size={13} />} onClick={() => addShape('text')}>
            文本框
          </Button>
          <Button variant="ghost" size="sm" icon={<Square size={13} />} onClick={() => addShape('rect')}>
            矩形
          </Button>
          <Button variant="ghost" size="sm" icon={<Circle size={13} />} onClick={() => addShape('ellipse')}>
            椭圆
          </Button>
          <Button variant="ghost" size="sm" icon={<ImageIcon size={13} />} onClick={() => imgInputRef.current?.click()}>
            图片
          </Button>
          <span className="mx-1 h-5 w-px bg-border" />
          <Button variant="ghost" size="sm" icon={<Copy size={13} />} disabled={!selectedId} onClick={duplicateSelected}>
            复制
          </Button>
          <Button variant="ghost" size="sm" icon={<Trash2 size={13} />} disabled={!selectedId} onClick={deleteSelected}>
            删除
          </Button>
          <span className="mx-1 h-5 w-px bg-border" />
          <Sparkles size={14} className="shrink-0 text-accent" aria-hidden="true" />
          <Input
            className="w-64"
            placeholder="AI：如「生成一份产品发布会 PPT」"
            disabled={aiBusy}
            value={aiInstruction}
            onChange={(e) => {
              aiInstructionRef.current = e.target.value;
              setAiInstruction(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && aiInstructionRef.current.trim()) {
                e.preventDefault();
                void runPresentationAi(aiInstructionRef.current.trim());
                aiInstructionRef.current = '';
                setAiInstruction('');
              }
            }}
          />
          {aiNote && (
            <span className="max-w-64 truncate text-tiny text-muted" title={aiNote}>
              {aiNote}
            </span>
          )}
          <span className="mx-1 h-5 w-px bg-border" />
          <Button variant="secondary" size="sm" icon={<Play size={13} />} onClick={() => setPlaying(true)} title="F5">
            放映
          </Button>
          <select
            className="h-7 rounded border border-border bg-surface px-1 text-xs text-text outline-none"
            value={slide?.transition ?? 'none'}
            title="切换效果"
            onChange={(e) => {
              const v = e.target.value as 'none' | 'fade';
              setPres((prev) => {
                const slides = [...prev.slides];
                slides[slideIdx] = { ...slides[slideIdx], transition: v };
                return { ...prev, slides };
              });
            }}
          >
            <option value="none">无切换</option>
            <option value="fade">淡入</option>
          </select>
          <span className="ml-2 text-xs text-text-secondary">拖拽移动 · 双击改文字 · 单击选中 · F5 放映</span>
        </div>

        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted-bg/60 p-4">
          <div
            className="rounded bg-white shadow-card"
            style={{ width: STAGE_W, height: STAGE_H }}
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setSelectedId(null);
            }}
          >
            <Stage
              ref={stageRef}
              width={STAGE_W}
              height={STAGE_H}
              onMouseDown={(e) => {
                if (e.target === e.target.getStage()) setSelectedId(null);
              }}
            >
              <Layer>
                {slide?.shapes.map((shape, idx) => renderShape(shape, idx))}
              </Layer>
            </Stage>
          </div>
        </div>
      </div>

      <input ref={fileInputRef} type="file" accept=".pptx" className="hidden" onChange={onFileChange} />
      <input
        ref={imgInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void addImage(f);
        }}
      />

      {playing && (
        <SlideshowOverlay
          pres={pres}
          startIndex={slideIdx}
          onClose={() => setPlaying(false)}
        />
      )}
    </div>
  );
}
