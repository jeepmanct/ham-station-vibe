// Minimal hand-rolled SVG bar/line charts — no charting library, consistent
// with the rest of this site staying dependency-light. attachHover() adds a
// shared crosshair/tooltip layer (pointer events, so it works on touch too);
// the native <title> per mark stays as the no-JS/screen-reader fallback.

type HoverTarget = {
  /** Mark center in SVG viewBox units. */
  x: number;
  heading: string;
  rows: { color: string; label?: string; value: string; y?: number }[];
  barIndex?: number;
};

/**
 * Snaps to the nearest target by x as the pointer moves over the chart and
 * shows an HTML tooltip -- a crosshair + ringed points for line charts, a
 * highlighted bar for bar charts. The hit area is the whole plot, not just
 * the 2.5px dots, so it's usable with a finger.
 */
function attachHover(container: HTMLElement, targets: HoverTarget[], plot: { top: number; bottom: number }) {
  const svg = container.querySelector('svg');
  if (!svg || !targets.length) return;
  container.classList.add('chart-hoverable');
  const ns = 'http://www.w3.org/2000/svg';
  const layer = document.createElementNS(ns, 'g');
  layer.setAttribute('class', 'chart-hover-layer');
  layer.style.display = 'none';
  svg.appendChild(layer);
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  container.appendChild(tip);
  const bars = Array.from(svg.querySelectorAll<SVGRectElement>('rect.bar'));
  const vb = svg.viewBox.baseVal;

  function show(clientX: number) {
    const box = svg!.getBoundingClientRect();
    const scale = box.width / vb.width;
    const x = (clientX - box.left) / scale;
    const t = targets.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a));
    let markup = '';
    if (t.barIndex == null) {
      markup += `<line x1="${t.x}" x2="${t.x}" y1="${plot.top}" y2="${plot.bottom}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3"/>`;
      for (const r of t.rows) {
        if (r.y != null) markup += `<circle cx="${t.x}" cy="${r.y}" r="4.5" fill="${r.color}" stroke="var(--card)" stroke-width="2"/>`;
      }
    }
    layer.innerHTML = markup;
    layer.style.display = '';
    bars.forEach((b, i) => b.classList.toggle('bar-dim', t.barIndex != null && i !== t.barIndex));

    tip.innerHTML =
      `<div class="chart-tip-head">${t.heading}</div>` +
      t.rows
        .map((r) => `<div class="chart-tip-row"><span class="chart-tip-swatch" style="background:${r.color}"></span>${r.label ? `<span class="chart-tip-label">${r.label}</span>` : ''}<span class="chart-tip-value">${r.value}</span></div>`)
        .join('');
    tip.hidden = false;
    const cBox = container.getBoundingClientRect();
    const px = box.left - cBox.left + t.x * scale;
    const left = Math.min(Math.max(px - tip.offsetWidth / 2, 0), cBox.width - tip.offsetWidth);
    tip.style.left = `${left}px`;
    tip.style.top = `${box.top - cBox.top + plot.top * scale - tip.offsetHeight - 6}px`;
  }
  function hide() {
    layer.style.display = 'none';
    tip.hidden = true;
    bars.forEach((b) => b.classList.remove('bar-dim'));
  }
  svg.addEventListener('pointermove', (e) => show(e.clientX));
  svg.addEventListener('pointerdown', (e) => show(e.clientX));
  svg.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') hide();
  });
  // Touch: a tap shows the tooltip; tapping elsewhere dismisses it. Charts
  // re-render in place (metric pickers, resizes), so the previous render's
  // document listener is aborted rather than left to pile up.
  hoverAborts.get(container)?.abort();
  const abort = new AbortController();
  hoverAborts.set(container, abort);
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!container.contains(e.target as Node)) hide();
    },
    { signal: abort.signal },
  );
}
const hoverAborts = new WeakMap<HTMLElement, AbortController>();

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
  attachHover(
    container,
    data.map((d, i) => ({
      x: padding.left + i * barSlot + barSlot / 2,
      heading: d.label,
      rows: [{ color: d.color ?? color, value: d.title ?? formatValue(d.value) }],
      barIndex: i,
    })),
    { top: padding.top, bottom: padding.top + plotH },
  );
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
  attachHover(
    container,
    data.map((d) => ({
      x: xScale(d.x),
      heading: formatX(d.x),
      rows: [{ color, value: `${d.y.toFixed(1)}${opts.suffix ?? ''}`, y: yScale(d.y) }],
    })),
    { top: padding.top, bottom: padding.top + plotH },
  );
}

export type LineSeries = { label: string; color: string; data: LinePoint[] };

/**
 * Same shape as renderLineChart, but multiple series sharing one set of
 * axes -- for genuinely comparative questions (e.g. this solar cycle vs.
 * the previous one) where a shared y-axis is the whole point, not two
 * separate small-multiple charts. A simple HTML legend (colored dot + label)
 * is prepended since more than one line needs a way to tell them apart.
 */
export function renderMultiLineChart(
  container: HTMLElement,
  series: LineSeries[],
  opts: { minY?: number; suffix?: string; formatX?: (x: number) => string } = {},
) {
  const formatX = opts.formatX ?? String;
  const width = container.clientWidth || 400;
  const height = 180;
  const padding = { top: 14, right: 12, bottom: 22, left: 34 };
  const nonEmpty = series.filter((s) => s.data.length);
  if (!nonEmpty.length) {
    container.innerHTML = '<p class="status-line">No data.</p>';
    return;
  }
  const allPoints = nonEmpty.flatMap((s) => s.data);
  const xs = allPoints.map((d) => d.x);
  const ys = allPoints.map((d) => d.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = opts.minY ?? Math.min(...ys) * 0.95;
  const maxY = Math.max(...ys) * 1.08;
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const xScale = (x: number) => padding.left + (maxX === minX ? 0 : ((x - minX) / (maxX - minX)) * plotW);
  const yScale = (y: number) => padding.top + plotH - (maxY === minY ? 0 : ((y - minY) / (maxY - minY)) * plotH);

  let svg = `<svg viewBox="0 0 ${width} ${height}" class="chart-svg" preserveAspectRatio="xMidYMid meet">`;
  svg += `<line x1="${padding.left}" y1="${padding.top + plotH}" x2="${width - padding.right}" y2="${padding.top + plotH}" stroke="var(--border)" stroke-width="1"/>`;
  for (const s of nonEmpty) {
    const path = s.data.map((d, i) => `${i === 0 ? 'M' : 'L'}${xScale(d.x).toFixed(1)},${yScale(d.y).toFixed(1)}`).join(' ');
    svg += `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    for (const d of s.data) {
      svg += `<circle cx="${xScale(d.x).toFixed(1)}" cy="${yScale(d.y).toFixed(1)}" r="2.5" fill="${s.color}"><title>${s.label} — ${formatX(d.x)}: ${d.y.toFixed(1)}${opts.suffix ?? ''}</title></circle>`;
    }
  }
  svg += `<text x="${padding.left}" y="${padding.top - 2}" font-size="10" fill="var(--muted)">${maxY.toFixed(0)}${opts.suffix ?? ''}</text>`;
  svg += `<text x="${padding.left}" y="${padding.top + plotH + 4}" font-size="10" fill="var(--muted)">${minY.toFixed(0)}</text>`;
  svg += `<text x="${padding.left}" y="${height - 4}" font-size="10" fill="var(--muted)">${formatX(minX)}</text>`;
  svg += `<text x="${width - padding.right}" y="${height - 4}" font-size="10" fill="var(--muted)" text-anchor="end">${formatX(maxX)}</text>`;
  svg += '</svg>';

  const legend = nonEmpty
    .map((s) => `<span class="chart-legend-item"><span class="chart-legend-dot" style="background:${s.color};"></span>${s.label}</span>`)
    .join('');
  container.innerHTML = `<div class="chart-legend">${legend}</div>${svg}`;
  // One target per distinct x, listing every series that has a value there.
  const byX = new Map<number, HoverTarget>();
  for (const s of nonEmpty) {
    for (const d of s.data) {
      const t = byX.get(d.x) ?? { x: xScale(d.x), heading: formatX(d.x), rows: [] };
      t.rows.push({ color: s.color, label: s.label, value: `${d.y.toFixed(1)}${opts.suffix ?? ''}`, y: yScale(d.y) });
      byX.set(d.x, t);
    }
  }
  attachHover(container, [...byX.values()], { top: padding.top, bottom: padding.top + plotH });
}
