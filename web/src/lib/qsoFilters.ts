// Shared band/mode/country/state/date-range filter panel, used by both /log and
// /map. Assumes the standard filter panel markup (see FilterPanel.astro) is
// present on the page. Fetches the available options, wires up all the chip
// interactions, and calls `onChange(query)` with a URLSearchParams-ready query
// string any time the selection changes (including once, after the initial
// chips are built).
//
// Chip counts are faceted: after the initial (unfiltered) chip list is built,
// every filter change re-fetches /api/qsos/facets and updates each chip's count
// to reflect the OTHER active filters — so a chip shows "how many results if I
// also enable this," not a fixed global total. Chips are never added/removed/
// reordered after creation, only their count text changes.
//
// Two interaction modes, picked per page via options.startUnselected:
//  - opt-out (default, used by /log): every chip starts selected; a category
//    filters only once you've deselected at least one chip, and deselecting
//    ALL of them means "match nothing" (so e.g. a None click is unambiguous).
//  - opt-in (/map): every chip starts unselected and a category is unrestricted
//    until you select some (but not all) of its chips — so building a narrow
//    query is "click the few things I want," not "click None then re-add
//    everything else I still want." 0 selected and "all" selected both mean
//    unrestricted here; only a partial selection actually filters.

type Count = { count: number } & Record<string, string>;
type Facets = { bands: Count[]; modes: Count[]; countries: Count[]; states: Count[] };

async function fetchCounts(url: string): Promise<Count[]> {
  const res = await fetch(url);
  return res.ok ? res.json() : [];
}

function setChipState(chip: HTMLElement, activeSet: Set<string>, active: boolean) {
  const value = chip.dataset.value!;
  chip.setAttribute('aria-pressed', String(active));
  if (active) activeSet.add(value);
  else activeSet.delete(value);
}

function makeChip(
  container: HTMLElement,
  value: string,
  count: number,
  activeSet: Set<string>,
  swatchColor: string | null,
  startSelected: boolean,
  onClick: () => void,
) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip';
  chip.dataset.value = value;
  chip.dataset.count = String(count);
  chip.innerHTML = swatchColor
    ? `<span class="swatch" style="background:${swatchColor};"></span>${value} <span class="chip-count" style="color:var(--muted);">${count}</span>`
    : `${value} <span class="chip-count" style="color:var(--muted);">${count}</span>`;
  setChipState(chip, activeSet, startSelected);
  chip.addEventListener('click', () => {
    setChipState(chip, activeSet, chip.getAttribute('aria-pressed') !== 'true');
    onClick();
  });
  container.appendChild(chip);
}

// A chip is visible only if it has a nonzero count under the current filters AND
// (when the category has a search box) its text matches the current search query.
// Both checks live here so a facet refresh and a search keystroke never fight
// over which one "wins" — each just recomputes the same combined visibility.
function applyChipVisibility(container: HTMLElement, search?: HTMLInputElement | null) {
  const q = search ? search.value.trim().toLowerCase() : '';
  container.querySelectorAll<HTMLElement>('.chip').forEach((chip) => {
    const hasResults = Number(chip.dataset.count ?? '0') > 0;
    const matchesSearch = !q || chip.textContent!.toLowerCase().includes(q);
    chip.style.display = hasResults && matchesSearch ? '' : 'none';
  });
}

function updateChipCounts(container: HTMLElement, counts: { value: string; count: number }[] | undefined, search?: HTMLInputElement | null) {
  if (!counts) return;
  const byValue = new Map(counts.map((c) => [c.value, c.count]));
  container.querySelectorAll<HTMLElement>('.chip').forEach((chip) => {
    const count = byValue.get(chip.dataset.value!) ?? 0;
    chip.dataset.count = String(count);
    const countEl = chip.querySelector<HTMLElement>('.chip-count');
    if (countEl) countEl.textContent = String(count);
  });
  applyChipVisibility(container, search);
}

function wireSelectAllNone(prefix: string, container: HTMLElement, activeSet: Set<string>, onClick: () => void) {
  document.getElementById(`${prefix}-all`)!.addEventListener('click', () => {
    container.querySelectorAll<HTMLElement>('.chip').forEach((chip) => setChipState(chip, activeSet, true));
    onClick();
  });
  document.getElementById(`${prefix}-none`)!.addEventListener('click', () => {
    container.querySelectorAll<HTMLElement>('.chip').forEach((chip) => setChipState(chip, activeSet, false));
    onClick();
  });
}

// Whether a category with `size` of `total` chips selected should actually filter.
function isRestricting(size: number, total: number, startUnselected: boolean): boolean {
  return startUnselected ? size > 0 && size < total : size < total;
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

const DATE_PRESETS: { label: string; from: () => string }[] = [
  { label: 'All time', from: () => '' },
  { label: 'This year', from: () => `${new Date().getFullYear()}-01-01` },
  { label: 'Last 12 mo', from: () => isoDaysAgo(365) },
  { label: 'Last 30 days', from: () => isoDaysAgo(30) },
  { label: 'Last 7 days', from: () => isoDaysAgo(7) },
  { label: 'Last 3 days', from: () => isoDaysAgo(3) },
];

// A simple multi-select category: chips + All/None + (optionally) a search box
// narrowing which chips are visible. Countries and states both use this shape.
function makeCategory(prefix: string, endpoint: string, param: string, valueKey: string, startUnselected: boolean, onClick: () => void) {
  const container = document.getElementById(`${prefix}-chips`)!;
  const search = document.getElementById(`${prefix}-search`) as HTMLInputElement | null;
  const activeSet = new Set<string>();
  let total = 0;

  wireSelectAllNone(prefix, container, activeSet, onClick);
  if (search) {
    search.addEventListener('input', () => applyChipVisibility(container, search));
  }

  return {
    container,
    search,
    async load() {
      const items = await fetchCounts(endpoint);
      total = items.length;
      items.forEach((item) => makeChip(container, item[valueKey], item.count, activeSet, null, !startUnselected, onClick));
    },
    reset() {
      container.querySelectorAll<HTMLElement>('.chip').forEach((chip) => {
        setChipState(chip, activeSet, !startUnselected);
        chip.style.display = '';
      });
      if (search) search.value = '';
    },
    queryParam(): [string, string] | null {
      return isRestricting(activeSet.size, total, startUnselected) ? [param, [...activeSet].join(',')] : null;
    },
  };
}

export async function initQsoFilters(
  onChange: (query: string) => void,
  options: { colorForBand?: (band: string) => string; startUnselected?: boolean } = {},
) {
  const { colorForBand, startUnselected = false } = options;

  const bandChips = document.getElementById('band-chips')!;
  const modeChips = document.getElementById('mode-chips')!;
  const datePresets = document.getElementById('date-presets')!;
  const customDateRow = document.getElementById('custom-date-row')!;
  const dateFrom = document.getElementById('date-from') as HTMLInputElement;
  const dateTo = document.getElementById('date-to') as HTMLInputElement;

  const activeBands = new Set<string>();
  const activeModes = new Set<string>();
  let totalBands = 0;
  let totalModes = 0;

  function buildQuery(): string {
    const params = new URLSearchParams();
    if (isRestricting(activeBands.size, totalBands, startUnselected)) params.set('bands', [...activeBands].join(','));
    if (isRestricting(activeModes.size, totalModes, startUnselected)) params.set('modes', [...activeModes].join(','));
    for (const category of [country, state]) {
      const entry = category.queryParam();
      if (entry) params.set(...entry);
    }
    if (dateFrom.value) params.set('from', dateFrom.value);
    if (dateTo.value) params.set('to', dateTo.value);
    return params.toString();
  }

  async function refreshFacetCounts() {
    const res = await fetch(`/api/qsos/facets?${buildQuery()}`);
    if (!res.ok) return;
    const facets: Facets = await res.json();
    updateChipCounts(bandChips, facets.bands);
    updateChipCounts(modeChips, facets.modes);
    updateChipCounts(country.container, facets.countries, country.search);
    updateChipCounts(state.container, facets.states, state.search);
  }

  function notify() {
    onChange(buildQuery());
    refreshFacetCounts();
  }

  const country = makeCategory('country', '/api/qsos/countries', 'countries', 'country', startUnselected, notify);
  const state = makeCategory('state', '/api/qsos/states', 'states', 'state', startUnselected, notify);

  wireSelectAllNone('band', bandChips, activeBands, notify);
  wireSelectAllNone('mode', modeChips, activeModes, notify);

  function setActiveDateChip(target: HTMLButtonElement) {
    datePresets.querySelectorAll<HTMLButtonElement>('.chip').forEach((b) => b.setAttribute('aria-pressed', String(b === target)));
  }

  function resetDateRange() {
    customDateRow.hidden = true;
    dateFrom.value = '';
    dateTo.value = '';
    setActiveDateChip(datePresets.querySelector('.chip')!);
  }

  DATE_PRESETS.forEach((preset, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.textContent = preset.label;
    btn.setAttribute('aria-pressed', String(i === 0));
    btn.addEventListener('click', () => {
      setActiveDateChip(btn);
      customDateRow.hidden = true;
      dateFrom.value = preset.from();
      dateTo.value = '';
      notify();
    });
    datePresets.appendChild(btn);
  });

  const customBtn = document.createElement('button');
  customBtn.type = 'button';
  customBtn.className = 'chip';
  customBtn.textContent = 'Custom';
  customBtn.setAttribute('aria-pressed', 'false');
  customBtn.addEventListener('click', () => {
    setActiveDateChip(customBtn);
    customDateRow.hidden = false;
  });
  datePresets.appendChild(customBtn);

  dateFrom.addEventListener('change', notify);
  dateTo.addEventListener('change', notify);

  // Deep-link support: ?from=YYYY-MM-DD&to=YYYY-MM-DD pre-fills a custom
  // date range on load (used by the Stats page's Activity heatmap, whose
  // day cells link to /log?from=X&to=X for that day's QSOs). Every other
  // filter (band/mode/country/state) starts at its normal default
  // regardless of the URL -- only date range is deep-linkable here.
  const urlParams = new URLSearchParams(location.search);
  const urlFrom = urlParams.get('from');
  if (urlFrom) {
    dateFrom.value = urlFrom;
    dateTo.value = urlParams.get('to') ?? urlFrom;
    setActiveDateChip(customBtn);
    customDateRow.hidden = false;
  }

  document.getElementById('reset-filters')!.addEventListener('click', () => {
    bandChips.querySelectorAll<HTMLElement>('.chip').forEach((chip) => setChipState(chip, activeBands, !startUnselected));
    modeChips.querySelectorAll<HTMLElement>('.chip').forEach((chip) => setChipState(chip, activeModes, !startUnselected));
    country.reset();
    state.reset();
    resetDateRange();
    notify();
  });

  const [bands, modes] = await Promise.all([fetchCounts('/api/qsos/bands'), fetchCounts('/api/qsos/modes')]);
  totalBands = bands.length;
  totalModes = modes.length;
  bands.forEach((b) => makeChip(bandChips, b.band, b.count, activeBands, colorForBand ? colorForBand(b.band) : null, !startUnselected, notify));
  modes.forEach((m) => makeChip(modeChips, m.mode, m.count, activeModes, null, !startUnselected, notify));
  await Promise.all([country.load(), state.load()]);

  notify();
}
