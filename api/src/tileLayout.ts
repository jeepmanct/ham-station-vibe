import { db } from './db';

export type TileLayoutEntry = { tileId: string; hidden: boolean };

/** Saved order/visibility for a page's tiles, or [] if never customized (caller falls back to default markup order). */
export function getTileLayout(page: string): TileLayoutEntry[] {
  const rows = db
    .query('SELECT tile_id, hidden FROM tile_layout WHERE page = ? ORDER BY position ASC')
    .all(page) as { tile_id: string; hidden: number }[];
  return rows.map((r) => ({ tileId: r.tile_id, hidden: r.hidden === 1 }));
}

/** Replaces the full saved layout for a page -- position is just the array index, so callers always pass the complete desired order. */
export function setTileLayout(page: string, tiles: TileLayoutEntry[]) {
  const tx = db.transaction((entries: TileLayoutEntry[]) => {
    db.query('DELETE FROM tile_layout WHERE page = ?').run(page);
    const insert = db.query('INSERT INTO tile_layout (page, tile_id, position, hidden) VALUES (?, ?, ?, ?)');
    entries.forEach((e, i) => insert.run(page, e.tileId, i, e.hidden ? 1 : 0));
  });
  tx(tiles);
}

/** Reverts a page to its default markup order (deletes all customization). */
export function clearTileLayout(page: string) {
  db.query('DELETE FROM tile_layout WHERE page = ?').run(page);
}
