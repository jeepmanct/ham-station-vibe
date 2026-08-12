// Minimal hand-rolled SVG bar/line charts — no charting library, consistent
// with the rest of this site staying dependency-light. Native <title> gives
// a browser tooltip on hover per bar/point without needing custom JS for it.

export type BarDatum = { label: string; value: number; title?: string; color?: string };

/** color: default fill for bars that don't specify their own `color` (e.g. per-band coloring). */
export function renderBarChart(container: HTMLElement, data: BarDatum[], color: string, formatValue: (v: number) => string = String) {
  const width = container.clientWidth || 400;
  const height = 220;
  const padding = { top: 16, right: 8, bottom: 28, left: 8 };
  const max = Math.max(...data.map((d) => d.value), 1);
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const barSlot = plotW / data.length;

  let svg = `<svg viewBox="0 0 ${width} ${height}" class="chart-svg" preserveAspectRatio="xMidYMid meet">`;
  data.forEach((d, i) => {
    const barHeight = (plotH * d.value) / max;
    const x = padding.left + i * barSlot;
    const y = padding.top + plotH - barHeight;
    const barWidth = Math.max(barSlot * 0.7, 1);
    svg += `<rect class="bar" x="${(x + barSlot * 0.15).toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(barHeight, 0).toFixed(1)}" rx="2" fill="${d.color ?? color}"><title>${d.title ?? `${d.label}: ${formatValue(d.value)}`}</title></rect>`;
    if (data.length <= 30) {
      svg += `<text x="${(x + barSlot / 2).toFixed(1)}" y="${height - 10}" text-anchor="middle" font-size="9" fill="var(--muted)">${d.label}</text>`;
    }
  });
  svg += `<text x="${padding.left}" y="${padding.top - 4}" font-size="10" fill="var(--muted)">${formatValue(max)}</text>`;
  svg += '</svg>';
  container.innerHTML = svg;
}

export type LinePoint = { x: number; y: number };

export function renderLineChart(
  container: HTMLElement,
  data: LinePoint[],
  color: string,
  opts: { minY?: number; suffix?: string; formatX?: (x: number) => string } = {},
) {
  const formatX = opts.formatX ?? String;
  const width = container.clientWidth || 400;
  const height = 180;
  const padding = { top: 14, right: 12, bottom: 22, left: 34 };
  if (!data.length) {
    container.innerHTML = '<p class="status-line">No data.</p>';
    return;
  }
  const xs = data.map((d) => d.x);
  const ys = data.map((d) => d.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = opts.minY ?? Math.min(...ys) * 0.95;
  const maxY = Math.max(...ys) * 1.08;
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const xScale = (x: number) => padding.left + (maxX === minX ? 0 : ((x - minX) / (maxX - minX)) * plotW);
  const yScale = (y: number) => padding.top + plotH - (maxY === minY ? 0 : ((y - minY) / (maxY - minY)) * plotH);

  const path = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${xScale(d.x).toFixed(1)},${yScale(d.y).toFixed(1)}`).join(' ');

  let svg = `<svg viewBox="0 0 ${width} ${height}" class="chart-svg" preserveAspectRatio="xMidYMid meet">`;
  svg += `<line x1="${padding.left}" y1="${padding.top + plotH}" x2="${width - padding.right}" y2="${padding.top + plotH}" stroke="var(--border)" stroke-width="1"/>`;
  svg += `<path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  data.forEach((d) => {
    svg += `<circle cx="${xScale(d.x).toFixed(1)}" cy="${yScale(d.y).toFixed(1)}" r="2.5" fill="${color}"><title>${formatX(d.x)}: ${d.y.toFixed(1)}${opts.suffix ?? ''}</title></circle>`;
  });
  svg += `<text x="${padding.left}" y="${padding.top - 2}" font-size="10" fill="var(--muted)">${maxY.toFixed(0)}${opts.suffix ?? ''}</text>`;
  svg += `<text x="${padding.left}" y="${padding.top + plotH + 4}" font-size="10" fill="var(--muted)">${minY.toFixed(0)}</text>`;
  svg += `<text x="${padding.left}" y="${height - 4}" font-size="10" fill="var(--muted)">${formatX(minX)}</text>`;
  svg += `<text x="${width - padding.right}" y="${height - 4}" font-size="10" fill="var(--muted)" text-anchor="end">${formatX(maxX)}</text>`;
  svg += '</svg>';
  container.innerHTML = svg;
}
