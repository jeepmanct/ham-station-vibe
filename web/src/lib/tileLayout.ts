import { TOKEN_KEY } from './auth';

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

/**
 * Generic pointer-based drag-to-reorder: press on `handle`, drag anywhere on
 * the page, and `item` moves within `container`'s children based on Y
 * position (inserted before whichever sibling's vertical midpoint the
 * pointer is currently above, or appended to the end once past all of
 * them). Includes the same auto-scroll-near-edge behavior as
 * autoScrollWhileDragging (shares its RAF loop, doesn't duplicate it).
 * Shared by this file's own inline tile dragging and admin.astro's list-row
 * dragging -- the only real difference between the two was which DOM shape
 * got dragged and what CSS class marks the item mid-drag, not the
 * algorithm itself.
 */
export function makeDraggable(options: {
  item: HTMLElement;
  handle: HTMLElement;
  container: HTMLElement;
  draggingClass: string;
  /** This container's other reorderable children, excluding `item` itself. */
  getSiblings: () => HTMLElement[];
  onDrop: () => void;
}): void {
  const { item, handle, container, draggingClass, getSiblings, onDrop } = options;
  handle.addEventListener('pointerdown', (e) => {
    const ev = e as PointerEvent;
    // Lets a nested interactive control's own click through -- relevant for
    // admin.astro's row drag (whole row is the drag zone, including a
    // visibility checkbox inside a <label>); a no-op for a dedicated
    // drag-handle element with no such descendant.
    if ((ev.target as HTMLElement).closest('label')) return;
    // Without this, iOS Safari claims the gesture for its own touch
    // handling (text-selection callout) before pointermove ever gets a
    // chance to fire; on desktop it also stops an accidental text
    // selection drag from competing with the reorder.
    ev.preventDefault();
    const draggingPointerId = ev.pointerId;
    item.classList.add(draggingClass);

    let lastClientY = ev.clientY;
    const stopAutoScroll = autoScrollWhileDragging(() => lastClientY);

    function onMove(moveEv: PointerEvent) {
      if (moveEv.pointerId !== draggingPointerId) return;
      lastClientY = moveEv.clientY;
      const after = getSiblings().find((el) => {
        const box = el.getBoundingClientRect();
        return moveEv.clientY < box.top + box.height / 2;
      });
      if (after) container.insertBefore(item, after);
      else container.appendChild(item);
    }
    function onEnd(endEv: PointerEvent) {
      if (endEv.pointerId !== draggingPointerId) return;
      item.classList.remove(draggingClass);
      stopAutoScroll();
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onEnd);
      document.removeEventListener('pointercancel', onEnd);
      onDrop();
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onEnd);
    document.addEventListener('pointercancel', onEnd);
  });
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

  const toolbar = document.createElement('div');
  toolbar.className = 'tile-edit-toolbar';
  document.body.appendChild(toolbar);

  // DOM order matters here even though the toolbar is right-anchored:
  // flex justify-content:flex-end packs children in source order, so this
  // reads left-to-right as [status] [Reset] [Edit Layout] with the main
  // toggle staying pinned at the fixed right edge regardless of whether the
  // other two are currently shown.
  const status = document.createElement('span');
  status.className = 'tile-edit-status';
  status.hidden = true;
  toolbar.appendChild(status);

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'btn secondary tile-edit-reset';
  resetBtn.textContent = 'Reset';
  resetBtn.hidden = true; // only shown while editing -- resetting outside edit mode has nothing to preview the result of
  toolbar.appendChild(resetBtn);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'btn tile-edit-toggle';
  toggle.textContent = 'Edit Layout';
  toolbar.appendChild(toggle);

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

  function makeTileDraggable(tile: HTMLElement, container: HTMLElement, handle: HTMLElement) {
    makeDraggable({
      item: tile,
      handle,
      container,
      draggingClass: 'tile-dragging',
      getSiblings: () => tileChildren(container).filter((el) => el !== tile),
      onDrop: save,
    });
  }

  function addControls(tile: HTMLElement, container: HTMLElement) {
    const bar = document.createElement('div');
    bar.className = 'tile-edit-controls';

    const handle = document.createElement('span');
    handle.className = 'tile-edit-handle';
    handle.innerHTML = '&#9776;';
    handle.setAttribute('aria-label', 'Drag to reorder this tile');
    handle.setAttribute('role', 'img');

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

  // Strips the injected edit-mode UI and re-fetches+re-applies the real
  // saved order/hidden state -- shared by exit() (just leaving edit mode)
  // and resetToDefault() (which needs the *default* state reflected before
  // it re-enters edit mode), so neither has to duplicate applyTileLayout's
  // own logic.
  async function stripEditingUi() {
    for (const container of containers) {
      for (const tile of tileChildren(container)) {
        tile.classList.remove('tile-editing', 'tile-edit-hidden', 'tile-dragging');
        tile.querySelector('.tile-edit-controls')?.remove();
      }
      await applyTileLayout(page, container);
    }
  }

  function exit() {
    stripEditingUi();
  }

  async function resetToDefault() {
    status.hidden = false;
    status.textContent = 'Resetting…';
    try {
      const res = await fetch(`/api/tile-layout/${page}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${sessionStorage.getItem(TOKEN_KEY)}` },
      });
      status.textContent = res.ok ? 'Reset to default' : 'Reset failed';
    } catch {
      status.textContent = 'Reset failed';
    }
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      status.hidden = true;
    }, 2000);

    // Re-enters edit mode on the now-default state, rather than just
    // exiting -- resetting is something you do *while* editing, so landing
    // back in edit mode (with nothing hidden, default order, all controls
    // present) is more useful than being dropped out of it.
    await stripEditingUi();
    enter();
  }
  resetBtn.addEventListener('click', resetToDefault);

  toggle.addEventListener('click', () => {
    editing = !editing;
    toggle.textContent = editing ? 'Done Editing' : 'Edit Layout';
    toggle.classList.toggle('active', editing);
    resetBtn.hidden = !editing;
    if (editing) enter();
    else exit();
  });
}
