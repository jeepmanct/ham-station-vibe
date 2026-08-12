// One-time backfill for photos uploaded before thumbnail generation existed
// (has_thumbnail = 0). Run manually once after deploying that change --
// not on a timer, since it only ever needs to run for the existing backlog;
// every upload going forward generates its own thumbnail inline.
import path from 'node:path';
import sharp from 'sharp';
import { db, PHOTOS_DIR, PHOTOS_THUMBS_DIR } from '../src/db';
import { thumbFilename } from '../src/routes/photos';

const THUMB_WIDTH = 640;

const rows = db.query('SELECT id, filename FROM photos WHERE has_thumbnail = 0').all() as {
  id: number;
  filename: string;
}[];

console.log(`Backfilling thumbnails for ${rows.length} photo(s)...`);

let done = 0;
let failed = 0;
for (const row of rows) {
  try {
    await sharp(path.join(PHOTOS_DIR, row.filename))
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toFile(path.join(PHOTOS_THUMBS_DIR, thumbFilename(row.filename)));
    db.query('UPDATE photos SET has_thumbnail = 1 WHERE id = ?').run(row.id);
    done++;
  } catch (err) {
    failed++;
    console.error(`Failed on photo ${row.id} (${row.filename}):`, err instanceof Error ? err.message : err);
  }
}

console.log(`Done: ${done} thumbnail(s) generated, ${failed} failed.`);
