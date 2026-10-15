/**
 * 图表渲染器（用户反馈 1：数据可视化）——canvas 绘制 → PNG dataURL。
 *
 * 为什么自绘而不用图表库：只需柱/折线/饼三类；自绘零依赖、体积可控，
 * 输出 PNG 直接作为图片插入文档（Word/WPS 通用）。
 */

export interface ChartSeries {
  name: string;
  values: number[];
}

export type ChartType = 'bar' | 'line' | 'pie';

const WIDTH = 880;
const HEIGHT = 520;
const PADDING = { top: 56, right: 32, bottom: 64, left: 72 };
const PALETTE = ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47', '#264478', '#9E480E'];

/** 中文可用字体栈（渲染时按系统字体回退） */
const FONT = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '-';
  if (Math.abs(n) >= 10000) return n.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
  return String(Math.round(n * 100) / 100);
}

/** 绘制图表 → PNG dataURL（失败返回 null） */
export function renderChartToPng(
  type: ChartType,
  labels: string[],
  series: ChartSeries[],
  title: string,
): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.font = `16px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#1f2937';
  if (title) ctx.fillText(title, WIDTH / 2, 30);

  if (type === 'pie') {
    drawPie(ctx, labels, series[0]?.values ?? []);
  } else {
    drawAxisChart(ctx, type, labels, series);
  }
  return canvas.toDataURL('image/png');
}

function drawAxisChart(ctx: CanvasRenderingContext2D, type: ChartType, labels: string[], series: ChartSeries[]): void {
  const all = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  const max = Math.max(0, ...all);
  const min = Math.min(0, ...all);
  const plotW = WIDTH - PADDING.left - PADDING.right;
  const plotH = HEIGHT - PADDING.top - PADDING.bottom;
  const zeroY = PADDING.top + plotH * (max / (max - min || 1));

  // 网格与坐标轴
  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = 1;
  ctx.font = `12px ${FONT}`;
  ctx.fillStyle = '#6b7280';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const value = min + ((max - min) * i) / 4;
    const y = PADDING.top + plotH - (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(PADDING.left, y);
    ctx.lineTo(WIDTH - PADDING.right, y);
    ctx.stroke();
    ctx.fillText(formatNumber(value), PADDING.left - 8, y + 4);
  }
  ctx.beginPath();
  ctx.moveTo(PADDING.left, PADDING.top);
  ctx.lineTo(PADDING.left, PADDING.top + plotH);
  ctx.lineTo(WIDTH - PADDING.right, PADDING.top + plotH);
  ctx.stroke();

  const slot = plotW / Math.max(1, labels.length);
  const groupW = slot * 0.7;
  const barW = groupW / Math.max(1, series.length);

  labels.forEach((label, li) => {
    const cx = PADDING.left + slot * li + slot / 2;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#374151';
    ctx.fillText(label, cx, PADDING.top + plotH + 20, slot - 4);

    series.forEach((s, si) => {
      const value = s.values[li];
      if (!Number.isFinite(value)) return;
      const color = PALETTE[si % PALETTE.length];
      const h = (Math.abs(value) / (max - min || 1)) * plotH;
      if (type === 'bar') {
        const x = cx - groupW / 2 + barW * si;
        const y = value >= 0 ? zeroY - h : zeroY;
        ctx.fillStyle = color;
        ctx.fillRect(x + 1, y, Math.max(1, barW - 2), h);
      } else {
        const y = zeroY - (value / (max - min || 1)) * plotH;
        if (li === 0) {
          ctx.beginPath();
          ctx.moveTo(cx, y);
        } else {
          ctx.lineTo(cx, y);
        }
      }
    });

    if (type === 'line') {
      series.forEach((s, si) => {
        ctx.strokeStyle = PALETTE[si % PALETTE.length];
        ctx.lineWidth = 2.5;
        ctx.stroke();
        s.values.forEach((v, i) => {
          if (!Number.isFinite(v)) return;
          const x = PADDING.left + slot * i + slot / 2;
          const y = zeroY - (v / (max - min || 1)) * plotH;
          ctx.beginPath();
          ctx.arc(x, y, 4, 0, Math.PI * 2);
          ctx.fillStyle = PALETTE[si % PALETTE.length];
          ctx.fill();
        });
      });
    }
  });

  // 图例
  if (series.length > 1 || series[0]?.name) {
    ctx.textAlign = 'left';
    let lx = PADDING.left;
    series.forEach((s, si) => {
      ctx.fillStyle = PALETTE[si % PALETTE.length];
      ctx.fillRect(lx, 14, 12, 12);
      ctx.fillStyle = '#374151';
      ctx.fillText(s.name || `系列${si + 1}`, lx + 18, 24);
      lx += 18 + ctx.measureText(s.name || `系列${si + 1}`).width + 24;
    });
  }
}

function drawPie(ctx: CanvasRenderingContext2D, labels: string[], values: number[]): void {
  const total = values.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2 + 16;
  const r = Math.min(WIDTH, HEIGHT) / 2 - 90;
  if (total <= 0) {
    ctx.fillStyle = '#9ca3af';
    ctx.textAlign = 'center';
    ctx.fillText('无有效数据', cx, cy);
    return;
  }
  let angle = -Math.PI / 2;
  values.forEach((v, i) => {
    if (!Number.isFinite(v) || v <= 0) return;
    const slice = (v / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + slice);
    ctx.closePath();
    ctx.fillStyle = PALETTE[i % PALETTE.length];
    ctx.fill();
    // 百分比标注
    const mid = angle + slice / 2;
    const lx = cx + Math.cos(mid) * r * 0.65;
    const ly = cy + Math.sin(mid) * r * 0.65;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.font = `bold 13px ${FONT}`;
    ctx.fillText(`${Math.round((v / total) * 100)}%`, lx, ly);
    ctx.font = `12px ${FONT}`;
    angle += slice;
  });
  // 图例
  ctx.textAlign = 'left';
  let ly = cy - r;
  labels.forEach((label, i) => {
    ctx.fillStyle = PALETTE[i % PALETTE.length];
    ctx.fillRect(WIDTH - 190, ly, 12, 12);
    ctx.fillStyle = '#374151';
    ctx.fillText(`${label}（${formatNumber(values[i] ?? 0)}）`, WIDTH - 172, ly + 11, 170);
    ly += 24;
  });
}
