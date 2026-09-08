import type L from 'leaflet';

// CARTO's basemap tiles (every Leaflet map on this site) started requiring
// a free API key as of late Aug 2026 -- unauthenticated requests still
// resolve but get an "API KEY REQUIRED" watermark stamped over every tile.
// The key is set (optionally) via /admin's Service Credentials form and
// surfaced through the public GET /api/settings -- it's not a secret, it
// has to be usable directly in every visitor's browser, the same way a
// Google Maps JS key is client-visible.
let settingsPromise: Promise<{ cartoApiKey: string | null }> | null = null;
function loadSettings() {
  if (!settingsPromise) settingsPromise = fetch('/api/settings').then((r) => r.json());
  return settingsPromise;
}

export type CartoStyle = 'dark_all' | 'light_all';

export function cartoTileUrl(style: CartoStyle): string {
  return `https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png`;
}

/**
 * Swaps the CARTO API key into an already-created tile layer once site
 * settings load, via setUrl() rather than making the caller await the
 * settings fetch before creating the layer -- deliberately NOT a top-level
 * await in these Astro client `<script>` modules, which breaks Astro's
 * IIFE bundling ("Module format 'iife' does not support top-level await",
 * the same class of gotcha already hit and worked around for satellite.js
 * elsewhere in this codebase). The map renders immediately with keyless
 * (possibly watermarked, until a key is configured) tiles rather than
 * blocking first paint on this fetch.
 */
export function applyCartoKey(layer: L.TileLayer, style: CartoStyle) {
  loadSettings().then(({ cartoApiKey }) => {
    if (cartoApiKey) layer.setUrl(`${cartoTileUrl(style)}?key=${encodeURIComponent(cartoApiKey)}`);
  });
}
