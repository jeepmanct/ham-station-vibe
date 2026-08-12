export type TileLayoutEntry = { tileId: string; hidden: boolean };

/**
 * Reorders/hides a page's `[data-tile-id]` children inside `container` to
 * match its saved layout (from /api/tile-layout/:page). A tile present in
 * the DOM but not mentioned in the saved layout -- e.g. one added to the
 * page after an admin last customized it -- is appended after the saved
 * ones, visible by default, rather than silently disappearing.
 */
export async function applyTileLayout(page: string, container: HTMLElement): Promise<void> {
  let layout: TileLayoutEntry[];
  try {
    const res = await fetch(`/api/tile-layout/${page}`);
    layout = res.ok ? await res.json() : [];
  } catch {
    return;
  }
  if (!layout.length) return;

  const tiles = Array.from(container.querySelectorAll<HTMLElement>(':scope > [data-tile-id]'));
  const byId = new Map(tiles.map((el) => [el.dataset.tileId!, el]));
  const hiddenById = new Map(layout.map((e) => [e.tileId, e.hidden]));

  const orderedIds = [...layout.map((e) => e.tileId), ...tiles.map((el) => el.dataset.tileId!).filter((id) => !hiddenById.has(id))];
  const finalOrder = [...new Set(orderedIds)];

  for (const id of finalOrder) {
    const el = byId.get(id);
    if (!el) continue;
    el.hidden = hiddenById.get(id) ?? false;
    container.appendChild(el);
  }
}
