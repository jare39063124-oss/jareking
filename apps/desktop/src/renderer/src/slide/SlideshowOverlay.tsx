/**
 * SlideshowOverlay —— 全屏放映模式（T3.3）。
 *
 * DOM/CSS 渲染（静态形状比 Konva 更合适）：黑底居中 16:9 画布，
 * 按 slideWidth/Height EMU 等比缩放；淡入切换（slide.transition === 'fade'）。
 * 操作：点击/→/↓/空格/PgDn 下一页，←/↑/PgUp 上一页，Home/End 首末页，Esc 退出。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JkPresentation, JkShape } from '@jareking/presentation';
import { createRehearsal, finalizeRehearsal, formatClock, recordSlideTime, type RehearsalRecord } from './rehearse';

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
  rehearse = false,
  onRehearsalFinish,
}: {
  pres: JkPresentation;
  startIndex: number;
  onClose: () => void;
  /** 排练计时模式：Esc 结束排练并回传记录（不直接关闭）；默认 false 保持既有放映行为 */
  rehearse?: boolean;
  /** 排练结束回调（收到完整计时记录，含当前页补记） */
  onRehearsalFinish?: (rec: RehearsalRecord) => void;
}) {
  const [idx, setIdx] = useState(startIndex);
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });

  // —— 排练计时状态（仅 rehearse 模式使用；普通放映不产生任何计时副作用）——
  /** 本页计时起点（时间戳，毫秒） */
  const slideStartRef = useRef<number>(Date.now());
  /** 当前页下标（ref 版，同步维护：导航时即时写入，供事件处理器读取最新值） */
  const idxRef = useRef<number>(startIndex);
  /** 排练记录（ref + state 双写：ref 供事件回调即时读取，state 驱动显示） */
  const recordRef = useRef<RehearsalRecord>(createRehearsal(pres.slides.length));
  const [record, setRecord] = useState<RehearsalRecord>(recordRef.current);
  /**
   * 本页是否**已访问**（下标与页序一致；仅排练模式维护）。
   * 排练中途 Esc 结束时，从未访问的页在记录里是 `0`，若直接写回会被误判为
   * 「本次排练刻意点击换片」而删除既有自动换片时间——故用此标记区分「0 = 访问过但瞬间切换」
   * 与「未访问」，结算时把未访问页转为 NaN（见 {@link finalizeRehearsal}）。
   * 初始长度按 pres.slides.length。
   */
  const visitedRef = useRef<boolean[]>(new Array(pres.slides.length).fill(false));
  /** 是否已结算（保证 onRehearsalFinish 只回调一次；**仅**在显式结算路径内首次置位） */
  const finishedRef = useRef<boolean>(false);
  /** 最新回调引用，避免陈旧闭包 */
  const onRehearsalFinishRef = useRef(onRehearsalFinish);
  onRehearsalFinishRef.current = onRehearsalFinish;
  /** 最新 onClose 引用（使 next/Esc 回调保持稳定，避免自动换片定时器被反复重建） */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  /** 本页已用时（毫秒，供渲染显示；同时驱动排练时钟刷新） */
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /** 排练时钟：每 200ms 刷新「本页用时」（仅排练模式） */
  useEffect(() => {
    if (!rehearse) return;
    const timer = window.setInterval(() => setElapsedMs(Date.now() - slideStartRef.current), 200);
    return () => window.clearInterval(timer);
  }, [rehearse]);

  /**
   * 切页（**唯一导航入口**）：排练模式下先把**当前页**停留时长写入记录并重置计时起点，
   * 再更新 idx。所有副作用都在事件处理器内同步完成，**不进入 setState updater**，
   * 从而避免 StrictMode 双调用导致重复计时 / 重复结算；普通模式仅更新 idx（行为不变）。
   */
  const navigate = useCallback(
    (target: number) => {
      const last = Math.max(0, pres.slides.length - 1);
      const clamped = Math.max(0, Math.min(target, last));
      const from = idxRef.current;
      if (rehearse && clamped !== from) {
        const stamp = Date.now();
        // 标记「离开的页」已访问（用于结算时区分「已访问的 0」与「未访问」）
        visitedRef.current[from] = true;
        const nextRec = recordSlideTime(recordRef.current, from, stamp - slideStartRef.current);
        recordRef.current = nextRec;
        setRecord(nextRec);
        slideStartRef.current = stamp;
        setElapsedMs(0);
      }
      idxRef.current = clamped;
      setIdx(clamped);
    },
    [pres.slides.length, rehearse],
  );

  /**
   * 结算当前页并回传（**幂等**：finishedRef 只在显式结算路径内首次置位）。
   * 结算前把**当前页**停留时长补记进 record 并标记该页已访问，保证最后一页
   * （被 Escape / 末页 next 结算时）的计时不丢失；再用 {@link finalizeRehearsal}
   * 把**未访问**的页转为 NaN（= 无记录 → 保持既有值）后回传。
   *
   * 注意：**不**把 NaN 写进 `recordRef.current`（否则 `recordSlideTime` 求和的 `totalMs`
   * 会被 NaN 污染、排练时钟「累计」显示会变 NaN）；NaN 只出现在结算产出的**副本**里。
   */
  const finishRehearsal = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    const cur = idxRef.current;
    // 补记当前页（recordRef.current 始终只含有限数，保证浮层累计显示正常）
    const recorded = recordSlideTime(recordRef.current, cur, Date.now() - slideStartRef.current);
    recordRef.current = recorded;
    setRecord(recorded);
    // 标记当前页已访问
    visitedRef.current[cur] = true;
    // 结算：未访问页 → NaN（视为「无记录」，写回时保持既有值）；finishedRef 幂等守卫保持不变
    const finalRec = finalizeRehearsal(recorded, visitedRef.current);
    onRehearsalFinishRef.current?.(finalRec);
  }, []);

  /**
   * 下一页。副作用直接在事件处理器内执行，不再放进 setIdx 的函数式 updater：
   *  - 非末页 → 切换下一页；
   *  - 末页 → 排练模式结算回传（不关闭，由父组件决策）；普通模式关闭放映（既有行为）。
   */
  const next = useCallback(() => {
    const i = idxRef.current;
    if (i >= pres.slides.length - 1) {
      if (rehearse) finishRehearsal();
      else onCloseRef.current();
      return;
    }
    navigate(i + 1);
  }, [pres.slides.length, rehearse, finishRehearsal, navigate]);

  const prev = useCallback(() => navigate(idxRef.current - 1), [navigate]);

  /**
   * 打开外部链接：复用 Electron 主进程 system:openExternal 通道（安全，仅放行 https）。
   * 非 Electron 环境（如浏览器预览）无 window.jareking，静默忽略，不硬造 window.open。
   */
  const openExternal = useCallback((url: string) => {
    if (!/^https:\/\//i.test(url)) return;
    const api = (window as unknown as { jareking?: { invoke: (ch: string, payload?: unknown) => Promise<unknown> } })
      .jareking;
    void api?.invoke('system:openExternal', { url });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Esc 语义按模式分流：排练模式 → 结算回传（不关闭）；普通模式 → 直接关闭（既有行为）
        if (rehearse) finishRehearsal();
        else onCloseRef.current();
      } else if (['ArrowRight', 'ArrowDown', ' ', 'PageDown', 'Enter'].includes(e.key)) {
        e.preventDefault();
        next();
      } else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) {
        e.preventDefault();
        prev();
      } else if (e.key === 'Home') navigate(0);
      else if (e.key === 'End') navigate(pres.slides.length - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, prev, pres.slides.length, rehearse, finishRehearsal, navigate]);

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

  // —— 自动换片（非排练模式）：当前页存在合法 advTm → 到时自动 next()，并显示剩余倒计时 ——
  // 切页 / 卸载时清理定时器，避免定时器泄漏与卸载后 setState。
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  useEffect(() => {
    const adv = pres.slides[idx]?.advanceAfterMs;
    if (rehearse || typeof adv !== 'number' || !Number.isFinite(adv) || adv <= 0) {
      setRemainingMs(null);
      return;
    }
    const deadline = Date.now() + adv;
    setRemainingMs(adv);
    const tick = window.setInterval(() => setRemainingMs(Math.max(0, deadline - Date.now())), 200);
    const advance = window.setTimeout(next, adv);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(advance);
    };
  }, [idx, rehearse, pres.slides, next]);

  // 页脚文案：排练模式显示本页/累计用时；自动换片显示倒计时；否则维持既有提示
  const cumulativeMs = record.totalMs + (elapsedMs > 0 ? elapsedMs : 0);
  const footerText = (() => {
    const pos = `${idx + 1} / ${pres.slides.length}`;
    if (rehearse) {
      return `${pos} · 本页 ${formatClock(elapsedMs)} · 累计 ${formatClock(cumulativeMs)} · Esc 结束排练`;
    }
    if (remainingMs !== null) {
      return `${pos} · ${Math.ceil(remainingMs / 1000)}s 后自动换片 · Esc 退出`;
    }
    return `${pos} · Esc 退出 · 右键上一页`;
  })();

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
        {/* 超链接热区：放映时点击带 hyperlink 的形状 → 打开外部链接（阻止翻页冒泡） */}
        {slide?.shapes
          .filter((shape) => !!shape.hyperlink)
          .map((shape, i) => (
            <div
              key={`lnk-${shape.id ?? i}`}
              title={shape.hyperlink}
              style={{
                position: 'absolute',
                left: shape.x * scale,
                top: shape.y * scale,
                width: shape.w * scale,
                height: shape.h * scale,
                cursor: 'pointer',
              }}
              onClick={(e) => {
                e.stopPropagation();
                openExternal(shape.hyperlink ?? '');
              }}
            />
          ))}
      </div>
      <div
        className="absolute bottom-4 rounded-full bg-black/60 px-4 py-1 text-sm text-white/90"
        onClick={(e) => e.stopPropagation()}
      >
        {footerText}
      </div>
    </div>
  );
}
