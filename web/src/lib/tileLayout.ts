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

  // Plain `.children` + a dataset check, not `:scope > [data-tile-id]` --
  // querySelectorAll(':scope > ...') from a non-document element turned out
  // to silently fail to match anything in real-world Safari (both iOS and
  // macOS), even though it worked fine in jsdom during testing. `.children`
  // is a plain DOM property with no selector-engine involvement at all.
  const tiles = Array.from(container.children).filter((el): el is HTMLElement => el instanceof HTMLElement && !!el.dataset.tileId);
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

const TOKEN_KEY = 'hamstation_admin_token';

/**
 * Auto-scrolls the page while a drag pointer sits near the top/bottom
 * viewport edge -- without this, a drag target taller than the screen
 * (routine on a phone, where a single tile or even a handful of admin list
 * rows can be the whole viewport) can never reach a drop position that's
 * currently off-screen, since the pointer physically can't go past the edge
 * of the glass. Shared between this file's own tile dragging and
 * admin.astro's list-row dragging, which hits the identical problem.
 *
 * `getY()` returns the drag pointer's current viewport-relative clientY --
 * a getter rather than a plain value so the caller's own pointermove handler
 * (which is what actually tracks the latest position) doesn't need to also
 * reach back into this module to keep it updated. Returns a stop function;
 * call it on pointerup/pointercancel.
 */
export function autoScrollWhileDragging(getY: () => number): () => void {
  const EDGE_ZONE = 80;
  const MAX_SPEED = 16;
  let raf: number | null = null;

  function step() {
    const y = getY();
    const fromTop = y;
    const fromBottom = window.innerHeight - y;
    let dy = 0;
    if (fromTop < EDGE_ZONE) dy = -MAX_SPEED * (1 - fromTop / EDGE_ZONE);
    else if (fromBottom < EDGE_ZONE) dy = MAX_SPEED * (1 - fromBottom / EDGE_ZONE);
    if (dy !== 0) window.scrollBy(0, dy);
    raf = requestAnimationFrame(step);
  }
  raf = requestAnimationFrame(step);

  return () => {
    if (raf != null) cancelAnimationFrame(raf);
  };
}

function tileChildren(container: HTMLElement): HTMLElement[] {
  return Array.from(container.children).filter((el): el is HTMLElement => el instanceof HTMLElement && !!el.dataset.tileId);
}

/**
 * Adds a floating "Edit Layout" toggle that lets an admin drag tiles around
 * and hide/show them directly on the real page, instead of the separate
 * page-picker + list editor on /admin (which still exists and still works --
 * this is additive, not a replacement, since it doesn't fit every page, e.g.
 * the nav bar). No-ops entirely -- injects nothing -- if there's no admin
 * session already in this browser tab, same "log in somewhere else first"
 * pattern as the solar-sync buttons on /conditions.
 *
 * `containers` should be the exact same container(s) already passed to
 * applyTileLayout() for this page -- multi-container pages (e.g. Conditions'
 * 3 group divs) keep dragging scoped to within one container at a time,
 * matching applyTileLayout's own per-container semantics, but a save always
 * sends *every* container's current tiles together, since POSTing to
 * /api/tile-layout/:page replaces that whole page's saved layout at once.
 */
export function enableInlineTileEditing(page: string, containers: HTMLElement[]): void {
  if (!sessionStorage.getItem(TOKEN_KEY)) return;
  if (!containers.length) return;

  let editing = false;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'btn tile-edit-toggle';
  toggle.textContent = 'Edit Layout';
  document.body.appendChild(toggle);

  const status = document.createElement('span');
  status.className = 'tile-edit-status';
  status.hidden = true;
  document.body.appendChild(status);

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  async function save() {
    const tiles = containers.flatMap((c) =>
      tileChildren(c).map((el) => ({ id: el.dataset.tileId!, hidden: el.dataset.tileHidden === 'true' })),
    );
    status.hidden = false;
    status.textContent = 'Saving…';
    try {
      const res = await fetch(`/api/tile-layout/${page}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionStorage.getItem(TOKEN_KEY)}` },
        body: JSON.stringify({ tiles }),
      });
      status.textContent = res.ok ? 'Saved' : 'Save failed';
    } catch {
      status.textContent = 'Save failed';
    }
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      status.hidden = true;
    }, 2000);
  }

  // Same pointer-event drag algorithm as admin.astro's makeRowDraggable(),
  // just retargeted from <li> rows to real tile elements, and started only
  // from the handle -- unlike that row list (label + checkbox only), a real
  // tile's content is full of buttons/links/inputs a whole-tile drag zone
  // would break.
  function makeTileDraggable(tile: HTMLElement, container: HTMLElement, handle: HTMLElement) {
    handle.addEventListener('pointerdown', (e) => {
      const ev = e as PointerEvent;
      ev.preventDefault();
      const draggingPointerId = ev.pointerId;
      tile.classList.add('tile-dragging');

      let lastClientY = ev.clientY;
      const stopAutoScroll = autoScrollWhileDragging(() => lastClientY);

      function onMove(moveEv: PointerEvent) {
        if (moveEv.pointerId !== draggingPointerId) return;
        lastClientY = moveEv.clientY;
        const siblings = tileChildren(container).filter((el) => el !== tile);
        const after = siblings.find((el) => {
          const box = el.getBoundingClientRect();
          return moveEv.clientY < box.top + box.height / 2;
        });
        if (after) container.insertBefore(tile, after);
        else container.appendChild(tile);
      }
      function onEnd(endEv: PointerEvent) {
        if (endEv.pointerId !== draggingPointerId) return;
        tile.classList.remove('tile-dragging');
        stopAutoScroll();
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onEnd);
        document.removeEventListener('pointercancel', onEnd);
        save();
      }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onEnd);
      document.addEventListener('pointercancel', onEnd);
    });
  }

  function addControls(tile: HTMLElement, container: HTMLElement) {
    const bar = document.createElement('div');
    bar.className = 'tile-edit-controls';

    const handle = document.createElement('span');
    handle.className = 'tile-edit-handle';
    handle.innerHTML = '&#9776;';

    const hideBtn = document.createElement('button');
    hideBtn.type = 'button';
    hideBtn.className = 'tile-edit-hide-btn';
    function refreshLabel() {
      hideBtn.textContent = tile.dataset.tileHidden === 'true' ? 'Show' : 'Hide';
    }
    refreshLabel();
    hideBtn.addEventListener('click', () => {
      tile.dataset.tileHidden = tile.dataset.tileHidden === 'true' ? 'false' : 'true';
      tile.classList.toggle('tile-edit-hidden', tile.dataset.tileHidden === 'true');
      refreshLabel();
      save();
    });

    bar.appendChild(handle);
    bar.appendChild(hideBtn);
    tile.appendChild(bar);
    makeTileDraggable(tile, container, handle);
  }

  function enter() {
    for (const container of containers) {
      for (const tile of tileChildren(container)) {
        tile.dataset.tileHidden = tile.hidden ? 'true' : 'false';
        tile.hidden = false;
        tile.classList.add('tile-editing');
        if (tile.dataset.tileHidden === 'true') tile.classList.add('tile-edit-hidden');
        addControls(tile, container);
      }
    }
  }

  function exit() {
    for (const container of containers) {
      for (const tile of tileChildren(container)) {
        tile.classList.remove('tile-editing', 'tile-edit-hidden', 'tile-dragging');
        tile.querySelector('.tile-edit-controls')?.remove();
      }
      // Re-fetches the saved layout and re-applies real order/hidden state --
      // avoids duplicating that logic here a second time.
      applyTileLayout(page, container);
    }
  }

  toggle.addEventListener('click', () => {
    editing = !editing;
    toggle.textContent = editing ? 'Done Editing' : 'Edit Layout';
    toggle.classList.toggle('active', editing);
    if (editing) enter();
    else exit();
  });
}
