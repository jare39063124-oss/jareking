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
}: {
  shape: JkShape;
  scale: number;
  dataUrl?: string;
}) {
  const style: React.CSSProperties = {
    position: 'absolute',
    left: shape.x * scale,
    top: shape.y * scale,
    width: shape.w * scale,
    height: shape.h * scale,
    transform: shape.rotation ? `rotate(${shape.rotation}deg)` : undefined,
    transformOrigin: 'center center',
  };

  if (shape.type === 'image') {
    return dataUrl ? (
      // eslint-disable-next-line jsx-a11y/alt-text
      <img style={style} src={dataUrl} draggable={false} />
    ) : (
      <div style={{ ...style, background: '#E5E7EB' }} />
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

  const animate = slide?.transition !== 'none';

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black"
      onClick={next}
      onContextMenu={(e) => {
        e.preventDefault();
        prev();
      }}
    >
      <style>{`@keyframes jk-fade { from { opacity: 0; } to { opacity: 1; } }`}</style>
      <div
        key={idx}
        className="relative bg-white shadow-2xl"
        style={{
          width: w,
          height: h,
          animation: animate ? 'jk-fade 0.25s ease' : undefined,
        }}
      >
        {slide?.shapes.map((shape) => (
          <RenderShape
            key={shape.id}
            shape={shape}
            scale={scale}
            dataUrl={shape.id ? imageUrls[shape.id] : undefined}
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
