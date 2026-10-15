/**
 * SlideshowOverlay —— 全屏放映模式（T3.3）。
 *
 * DOM/CSS 渲染（静态形状比 Konva 更合适）：黑底居中 16:9 画布，
 * 按 slideWidth/Height EMU 等比缩放；淡入切换（slide.transition === 'fade'）。
 * 操作：点击/→/↓/空格/PgDn 下一页，←/↑/PgUp 上一页，Home/End 首末页，Esc 退出。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JkPresentation, JkShape } from '@jareking/presentation';

/** media 字节 → dataURL */
function bytesToDataUrl(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:image/png;base64,${btoa(bin)}`;
}

/** 单形状静态渲染（EMUs → px） */
function RenderShape({
  shape,
  scale,
  dataUrl,
  enterIndex,
  animateEnter,
}: {
  shape: JkShape;
  scale: number;
  dataUrl?: string;
  /** 进入动画序号（-1 表示不播进入动画） */
  enterIndex: number;
  animateEnter: boolean;
}) {
  // 放映态：形状逐个淡入上移（WPS 基础进入动画感）
  const enterStyle: React.CSSProperties =
    animateEnter && enterIndex >= 0
      ? {
          animation: 'jk-enter 0.4s ease backwards',
          animationDelay: `${enterIndex * 0.15}s`,
        }
      : {};
  const style: React.CSSProperties = {
    position: 'absolute',
    left: shape.x * scale,
    top: shape.y * scale,
    width: shape.w * scale,
    height: shape.h * scale,
    transform: shape.rotation ? `rotate(${shape.rotation}deg)` : undefined,
    transformOrigin: 'center center',
    ...enterStyle,
  };

  if (shape.type === 'image') {
    return dataUrl ? (
      // eslint-disable-next-line jsx-a11y/alt-text
      <img style={style} src={dataUrl} draggable={false} />
    ) : (
      <div style={{ ...style, background: '#E5E7EB' }} />
    );
  }

  // 表格：按 colWidths / 行高还原为 DOM 表格（放映态只读）
  if (shape.type === 'table') {
    const totalH = shape.height ?? shape.h;
    const rowCount = shape.rows.length;
    const perRow = totalH / Math.max(1, rowCount);
    return (
      <div
        style={{
          ...style,
          display: 'table',
          tableLayout: 'fixed',
          borderCollapse: 'collapse',
          background: '#FFFFFF',
        }}
      >
        {shape.rows.map((row, r) => (
          <div key={r} style={{ display: 'table-row', height: (row.height ?? perRow) * scale }}>
            {shape.colWidths.map((cw, c) => {
              const cell = row.cells[c] ?? { text: '' };
              return (
                <div
                  key={c}
                  style={{
                    display: 'table-cell',
                    width: cw * scale,
                    border: '1px solid #9CA3AF',
                    verticalAlign: 'middle',
                    padding: 4,
                    whiteSpace: 'pre-wrap',
                    fontSize: (cell.fontSize ?? 18) * (4 / 3) * scale,
                    color: cell.color ?? '#1F2937',
                    fontWeight: cell.bold ? 700 : 400,
                    textAlign: cell.align ?? 'left',
                    overflow: 'hidden',
                  }}
                >
                  {cell.text}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    );
  }

  const paragraphs = shape.paragraphs ?? [];
  const firstRun = paragraphs[0]?.runs?.[0];
  const align = paragraphs[0]?.align ?? 'left';
  const fontSizePx = (firstRun?.fontSize ?? 18) * (4 / 3) * scale;

  const lines = paragraphs.map((p) => {
    const txt = p.runs.map((r) => r.text).join('');
    return p.bullet ? `• ${txt}` : txt;
  });

  const textStyle: React.CSSProperties = {
    fontSize: fontSizePx,
    color: firstRun?.color ?? '#1F2937',
    fontWeight: firstRun?.bold ? 700 : 400,
    fontStyle: firstRun?.italic ? 'italic' : 'normal',
    fontFamily: firstRun?.fontFamily ? `'${firstRun.fontFamily}', sans-serif` : undefined,
    textDecoration: firstRun?.underline ? 'underline' : undefined,
    whiteSpace: 'pre-wrap',
    width: '100%',
    textAlign: align === 'center' ? 'center' : align === 'right' ? 'right' : align === 'justify' ? 'justify' : 'left',
  };

  if (shape.type === 'shape') {
    return (
      <div
        style={{
          ...style,
          background: shape.fill ?? '#94A3B8',
          borderRadius: shape.geom === 'ellipse' ? '50%' : shape.geom === 'roundRect' ? 12 * scale : 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: align === 'left' ? 'flex-start' : 'center',
          padding: 6 * scale,
          boxSizing: 'border-box',
          overflow: 'hidden',
        }}
      >
        {lines.length ? <div style={textStyle}>{lines.join('\n')}</div> : null}
      </div>
    );
  }

  return (
    <div style={{ ...style, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', overflow: 'hidden' }}>
      {lines.map((line, i) => {
        const p = paragraphs[i];
        const run = p?.runs?.[0];
        return (
          <div
            key={i}
            style={{
              ...textStyle,
              fontSize: (run?.fontSize ?? firstRun?.fontSize ?? 18) * (4 / 3) * scale,
              color: run?.color ?? firstRun?.color ?? '#1F2937',
              fontWeight: run?.bold ?? firstRun?.bold ? 700 : 400,
              fontStyle: (run?.italic ?? firstRun?.italic) ? 'italic' : 'normal',
              textAlign: (p?.align ?? align) === 'center' ? 'center' : (p?.align ?? align) === 'right' ? 'right' : (p?.align ?? align) === 'justify' ? 'justify' : 'left',
              minHeight: (run?.fontSize ?? firstRun?.fontSize ?? 18) * (4 / 3) * scale * 1.4,
            }}
          >
            {p?.bullet ? `• ${line}` : line}
          </div>
        );
      })}
    </div>
  );
}

export function SlideshowOverlay({
  pres,
  startIndex,
  onClose,
}: {
  pres: JkPresentation;
  startIndex: number;
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(startIndex);
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });

  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const next = useCallback(() => {
    setIdx((i) => {
      if (i >= pres.slides.length - 1) {
        onClose();
        return i;
      }
      return i + 1;
    });
  }, [pres.slides.length, onClose]);

  const prev = useCallback(() => setIdx((i) => Math.max(0, i - 1)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (['ArrowRight', 'ArrowDown', ' ', 'PageDown', 'Enter'].includes(e.key)) {
        e.preventDefault();
        next();
      } else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) {
        e.preventDefault();
        prev();
      } else if (e.key === 'Home') setIdx(0);
      else if (e.key === 'End') setIdx(pres.slides.length - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, prev, onClose, pres.slides.length]);

  const slide = pres.slides[idx];
  const scale = Math.min(
    (viewport.w * 0.92) / pres.slideWidth,
    (viewport.h * 0.88) / pres.slideHeight,
  );
  const w = pres.slideWidth * scale;
  const h = pres.slideHeight * scale;

  const imageUrls = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of slide?.shapes ?? []) {
      if (s.type !== 'image') continue;
      const bytes = pres.media?.[`${idx}:${s.relId}`];
      if (bytes) map[s.id ?? ''] = bytesToDataUrl(bytes);
    }
    return map;
  }, [slide, pres.media, idx]);

  const transition = slide?.transition ?? 'none';

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black"
      onClick={next}
      onContextMenu={(e) => {
        e.preventDefault();
        prev();
      }}
    >
      <style>{`
        @keyframes jk-fade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes jk-slide-in { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @keyframes jk-enter { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
      <div
        key={idx}
        className="relative bg-white shadow-2xl"
        style={{
          width: w,
          height: h,
          animation:
            transition === 'fade'
              ? 'jk-fade 0.25s ease'
              : transition === 'slide'
                ? 'jk-slide-in 0.35s ease'
                : undefined,
        }}
      >
        {slide?.shapes.map((shape, i) => (
          <RenderShape
            key={shape.id}
            shape={shape}
            scale={scale}
            dataUrl={shape.id ? imageUrls[shape.id] : undefined}
            enterIndex={i}
            animateEnter={transition !== 'none'}
          />
        ))}
      </div>
      <div
        className="absolute bottom-4 rounded-full bg-black/60 px-4 py-1 text-sm text-white/90"
        onClick={(e) => e.stopPropagation()}
      >
        {idx + 1} / {pres.slides.length} · Esc 退出 · 右键上一页
      </div>
    </div>
  );
}
