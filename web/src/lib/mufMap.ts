import L from 'leaflet';
import { cartoTileUrl, applyCartoKey, type CartoStyle } from './basemap';
import { distanceKm, gridToLatLon } from './maidenhead';
import { escapeHtml } from './escapeHtml';

// Interactive MUF map for /conditions, drawn from /api/conditions/muf
// (prop.kc2g.com's contour GeoJSON + live ionosonde readings). Replaces the
// old fixed-palette SVG embed so the map follows the site theme and can
// layer station-specific context on top: QTH, a band picker, live DX spots,
// and this week's QSOs.

type Station = {
  name: string;
  code: string;
  lat: number;
  lon: number;
  mufd: number;
  fof2: number | null;
  confidence: number | null;
  time: number;
};
type ContourFeature = {
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  properties: { 'level-value': number };
};
type MufData = {
  contours: { features: ContourFeature[] };
  stations: Station[];
  runAt: number | null;
  esfi: number | null;
  essn: number | null;
};
type Spot = { call: string; frequency: string; band: string; mode: string; grid: string | null; time: string; needed: string | null };
type QsoPoint = { call: string; qsoDate: string; band: string | null; mode: string | null; lat: number; lon: number };

// kc2g draws its contours at these band-edge frequencies, so "the 14.0
// contour" is literally "20m is open inside this line" for a 3000 km hop.
export const MUF_BANDS = [
  { band: '30m', mhz: 10.1 },
  { band: '20m', mhz: 14.0 },
  { band: '17m', mhz: 18.0 },
  { band: '15m', mhz: 21.0 },
  { band: '12m', mhz: 24.8 },
  { band: '10m', mhz: 28.0 },
];

// MUF(3000) describes the ionosphere at a path's midpoint, so the ring of
// midpoints for every 3000 km single hop from home sits 1500 km out.
const HOP_MIDPOINT_KM = 1500;
const NEARBY_KM = 2000;

const bandMeters = (band: string | null) => (band ? parseInt(band, 10) : NaN);

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** True when the active site theme has a dark background -- checks the resolved --bg rather than prefers-color-scheme, since /admin's theme picker can override the OS setting. */
function isDarkTheme(): boolean {
  const probe = document.createElement('div');
  probe.style.color = cssVar('--bg', '#0b0d10');
  document.body.appendChild(probe);
  const [r, g, b] = getComputedStyle(probe).color.match(/\d+/g)!.map(Number);
  probe.remove();
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

function ago(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ${min % 60} min ago`;
}

export type MufMapElements = {
  map: HTMLElement;
  bandPicker: HTMLElement;
  layerToggles: { spots: HTMLInputElement; qsos: HTMLInputElement; ring: HTMLInputElement };
  status: HTMLElement;
  nearest: HTMLElement;
  fallback: HTMLImageElement;
};

export function initMufMap(el: MufMapElements) {
  // kc2g's contours cover exactly one world (-180..180), so the map is held
  // to that instead of wrapping into contour-less copies. minZoom 1 keeps a
  // phone-width map from shrinking the world smaller than its own box.
  const map = L.map(el.map, { minZoom: 1, maxBounds: [[-85, -200], [85, 200]], maxBoundsViscosity: 1 });
  map.fitBounds([[-55, -170], [72, 170]]);
  if (el.map.clientWidth < 600) map.setView([35, -45], 1);
  let cartoStyle: CartoStyle = isDarkTheme() ? 'dark_all' : 'light_all';
  const baseLayer = L.tileLayer(cartoTileUrl(cartoStyle), {
    attribution:
      'MUF &copy; <a href="https://prop.kc2g.com" target="_blank" rel="noopener">prop.kc2g.com</a> &middot; &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 10,
  }).addTo(map);
  applyCartoKey(baseLayer, cartoStyle);

  const contourLayer = L.layerGroup().addTo(map);
  const stationLayer = L.layerGroup().addTo(map);
  const spotLayer = L.layerGroup();
  const qsoLayer = L.layerGroup();
  const ringLayer = L.layerGroup();

  let data: MufData | null = null;
  let home: { lat: number; lon: number } | null = null;
  let spots: Spot[] = [];
  let qsos: QsoPoint[] = [];
  let selected: (typeof MUF_BANDS)[number] | null = null;

  // --- Band picker ---
  const chips: HTMLButtonElement[] = [];
  const addChip = (label: string, band: (typeof MUF_BANDS)[number] | null) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seg-btn';
    btn.textContent = label;
    btn.setAttribute('aria-pressed', String(band === selected));
    btn.addEventListener('click', () => {
      selected = band;
      chips.forEach((c) => c.setAttribute('aria-pressed', String(c === btn)));
      render();
    });
    chips.push(btn);
    el.bandPicker.appendChild(btn);
  };
  addChip('All', null);
  MUF_BANDS.forEach((b) => addChip(b.band, b));

  // --- Drawing ---
  function renderContours() {
    contourLayer.clearLayers();
    if (!data) return;
    const accent = cssVar('--accent', '#5eead4');
    const muted = cssVar('--muted', '#8d98a1');
    const levels = [...new Set(data.contours.features.map((f) => f.properties['level-value']))].sort((a, b) => a - b);
    for (const f of data.contours.features) {
      const level = f.properties['level-value'];
      const isSelected = selected != null && Math.abs(level - selected.mhz) < 0.05;
      // Sequential, one hue: higher MUF = more opaque accent. A selected
      // band's line goes bold and everything else recedes to muted gray.
      const rank = levels.indexOf(level) / Math.max(1, levels.length - 1);
      const color = selected == null ? accent : isSelected ? accent : muted;
      const opacity = selected == null ? 0.35 + 0.6 * rank : isSelected ? 1 : 0.3;
      const latlngs = f.geometry.coordinates.map(([lon, lat]) => [lat, lon] as [number, number]);
      L.polyline(latlngs, { color, opacity, weight: isSelected ? 4 : 2, interactive: false }).addTo(contourLayer);
      // One direct label per sufficiently long line, at its midpoint --
      // short fragments near the map edge would just clutter.
      if (latlngs.length >= 20 && (selected == null || isSelected)) {
        const mid = latlngs[Math.floor(latlngs.length / 2)];
        L.marker(mid, {
          interactive: false,
          icon: L.divIcon({ className: 'muf-contour-label', html: `${level.toFixed(level % 1 ? 1 : 0)}`, iconSize: undefined }),
        }).addTo(contourLayer);
      }
    }
  }

  function renderStations() {
    stationLayer.clearLayers();
    if (!data) return;
    const accent = cssVar('--accent', '#5eead4');
    const muted = cssVar('--muted', '#8d98a1');
    const surface = cssVar('--card', '#14171c');
    for (const s of data.stations) {
      const open = selected == null || s.mufd >= selected.mhz;
      // Shape carries the state as well as color: filled = band open at
      // this ionosonde, hollow = closed.
      const marker = L.circleMarker([s.lat, s.lon], {
        radius: 7,
        color: open ? surface : muted,
        weight: 2,
        fillColor: open ? accent : surface,
        fillOpacity: 1,
      });
      const verdict = selected ? `<br>${selected.band}: <strong>${open ? 'open' : 'closed'}</strong>` : '';
      marker.bindTooltip(
        `<strong>${escapeHtml(s.name)}</strong> (${escapeHtml(s.code)})<br>MUF(3000): ${s.mufd.toFixed(1)} MHz` +
          (s.fof2 != null ? ` · foF2 ${s.fof2.toFixed(1)}` : '') +
          `${verdict}<br><span class="muf-tip-muted">${ago(s.time)}${s.confidence != null ? ` · confidence ${Math.round(s.confidence)}` : ''}</span>`,
        { direction: 'top', offset: [0, -6] },
      );
      marker.addTo(stationLayer);
    }
  }

  function renderSpots() {
    spotLayer.clearLayers();
    const color = cssVar('--accent-2', '#f5a962');
    const surface = cssVar('--card', '#14171c');
    for (const s of spots) {
      if (selected && bandMeters(s.band) !== parseInt(selected.band, 10)) continue;
      const pos = s.grid ? gridToLatLon(s.grid) : null;
      if (!pos) continue;
      L.circleMarker([pos.lat, pos.lon], { radius: 5, color: surface, weight: 2, fillColor: color, fillOpacity: 1 })
        .bindTooltip(
          `<strong>${escapeHtml(s.call)}</strong> ${escapeHtml(s.frequency)} kHz ${escapeHtml(s.mode ?? '')}` +
            `${s.needed === 'needed' ? ' · <strong>needed</strong>' : ''}<br><span class="muf-tip-muted">${escapeHtml(s.grid!)} · ${escapeHtml(s.time ?? '')}</span>`,
          { direction: 'top', offset: [0, -4] },
        )
        .addTo(spotLayer);
    }
  }

  function renderQsos() {
    qsoLayer.clearLayers();
    const color = cssVar('--fg', '#eef1f3');
    for (const q of qsos) {
      if (selected && bandMeters(q.band) !== parseInt(selected.band, 10)) continue;
      L.circleMarker([q.lat, q.lon], { radius: 4, color, weight: 1.5, fillOpacity: 0 })
        .bindTooltip(`<strong>${escapeHtml(q.call)}</strong> ${escapeHtml(q.band ?? '')} ${escapeHtml(q.mode ?? '')}<br><span class="muf-tip-muted">${escapeHtml(q.qsoDate)}</span>`, {
          direction: 'top',
        })
        .addTo(qsoLayer);
    }
  }

  function renderRing() {
    ringLayer.clearLayers();
    if (!home) return;
    const fg = cssVar('--fg', '#eef1f3');
    L.circle([home.lat, home.lon], { radius: HOP_MIDPOINT_KM * 1000, color: fg, weight: 1.5, dashArray: '6 6', fill: false, interactive: false }).addTo(ringLayer);
    L.circleMarker([home.lat, home.lon], { radius: 6, color: cssVar('--card', '#14171c'), weight: 2, fillColor: fg, fillOpacity: 1 })
      .bindTooltip('Home QTH', { direction: 'top' })
      .addTo(ringLayer);
  }

  function renderNearest() {
    if (!data || !home || data.stations.length === 0) {
      el.nearest.textContent = '';
      return;
    }
    const h = home;
    // Only ionosondes close enough to say something about *your* sky --
    // the nearest one always, a second only if it's also regional.
    const nearest = [...data.stations]
      .sort((a, b) => distanceKm(h, a) - distanceKm(h, b))
      .filter((s, i) => i === 0 || distanceKm(h, s) < NEARBY_KM)
      .slice(0, 2);
    el.nearest.replaceChildren(
      ...nearest.map((s) => {
        const tile = document.createElement('div');
        tile.className = 'muf-nearest-tile';
        const open = MUF_BANDS.filter((b) => s.mufd >= b.mhz).map((b) => b.band);
        tile.innerHTML =
          `<div class="label">${escapeHtml(s.name)} · ${Math.round(distanceKm(h, s))} km</div>` +
          `<div class="value">${s.mufd.toFixed(1)}<span class="unit"> MHz</span></div>` +
          `<div class="sub">${open.length ? `Open up to ${open[open.length - 1]}` : 'Below 30m'} · ${ago(s.time)}</div>`;
        return tile;
      }),
    );
  }

  function render() {
    renderContours();
    renderStations();
    renderSpots();
    renderQsos();
  }

  // --- Layer toggles ---
  const bindToggle = (input: HTMLInputElement, layer: L.LayerGroup) => {
    const apply = () => (input.checked ? layer.addTo(map) : layer.remove());
    input.addEventListener('change', apply);
    apply();
  };
  bindToggle(el.layerToggles.ring, ringLayer);
  bindToggle(el.layerToggles.spots, spotLayer);
  bindToggle(el.layerToggles.qsos, qsoLayer);

  // --- Data ---
  async function loadMuf() {
    try {
      const res = await fetch('/api/conditions/muf');
      if (!res.ok) throw new Error();
      data = (await res.json()) as MufData;
      el.map.hidden = false;
      el.fallback.hidden = true;
      const parts = [];
      if (data.runAt) parts.push(`Model run ${new Date(data.runAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
      if (data.esfi != null) parts.push(`effective SFI ${data.esfi}`);
      if (data.essn != null) parts.push(`SSN ${data.essn}`);
      parts.push(`${data.stations.length} ionosondes reporting`);
      el.status.textContent = parts.join(' · ');
      render();
      renderNearest();
    } catch {
      // kc2g's JSON unreachable through our API: fall back to their
      // pre-rendered SVG so the card never goes blank.
      el.map.hidden = true;
      el.fallback.hidden = false;
      el.fallback.src = `https://prop.kc2g.com/renders/current/mufd-normal-now.svg?_=${Date.now()}`;
      el.status.textContent = 'Interactive data unavailable — showing the static map from prop.kc2g.com.';
    }
  }

  async function loadSpots() {
    try {
      spots = await (await fetch('/api/conditions/spots')).json();
      renderSpots();
    } catch {
      /* spots are an optional overlay */
    }
  }

  fetch('/api/conditions/home')
    .then((r) => r.json())
    .then((h: { lat: number; lon: number } | null) => {
      home = h;
      renderRing();
      renderNearest();
    })
    .catch(() => {});

  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  fetch(`/api/qsos/geo?from=${weekAgo}`)
    .then((r) => r.json())
    .then((d: { points: QsoPoint[] }) => {
      qsos = d.points;
      renderQsos();
    })
    .catch(() => {});

  // Recolor in place when the theme picker changes palettes.
  new MutationObserver(() => {
    const next: CartoStyle = isDarkTheme() ? 'dark_all' : 'light_all';
    if (next !== cartoStyle) {
      cartoStyle = next;
      baseLayer.setUrl(cartoTileUrl(cartoStyle));
      applyCartoKey(baseLayer, cartoStyle);
    }
    render();
    renderRing();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });

  return { refreshMuf: loadMuf, refreshSpots: loadSpots, invalidateSize: () => map.invalidateSize() };
}
