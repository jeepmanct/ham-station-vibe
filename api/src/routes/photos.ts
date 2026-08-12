import { Hono } from 'hono';
import path from 'node:path';
import { unlink } from 'node:fs/promises';
import sharp from 'sharp';
import { db, PHOTOS_DIR, PHOTOS_THUMBS_DIR } from '../db';
import { requireAuth } from '../auth';

export const photoRoutes = new Hono();

// Real image types only -- previously any filename/extension was accepted
// and written to disk as-is, then served same-origin with a content-type
// inferred from that same client-supplied extension (e.g. an uploaded
// "x.html" would be served as text/html from this site's own origin).
// Admin-only upload, so this isn't attacker-reachable without an admin
// session, but it's a cheap, correct thing to enforce regardless.
const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB -- generous for a phone/DSLR photo, not unbounded.
const THUMB_WIDTH = 640;

/** Thumbnails are always JPEG (see thumbUrl's comment) -- swaps in .jpg for whatever the original's extension was. */
export function thumbFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/, '.jpg');
}

photoRoutes.get('/', (c) => {
  const rows = db
    .query('SELECT id, filename, caption, has_thumbnail FROM photos ORDER BY uploaded_at DESC')
    .all() as { id: number; filename: string; caption: string | null; has_thumbnail: number }[];
  return c.json(
    rows.map((r) => ({
      id: r.id,
      url: `/media/${r.filename}`,
      // Falls back to the full-size URL for any row without a generated
      // thumbnail yet (pre-thumbnailing uploads, or generation failed) --
      // see backfill-photo-thumbnails.ts for backfilling existing photos.
      // Thumbnails are always re-encoded as JPEG regardless of the
      // original's format, so the thumb filename swaps in .jpg rather than
      // reusing the original extension (which would mislabel e.g. a PNG's
      // thumbnail as image/png when it's actually JPEG bytes).
      thumbUrl: r.has_thumbnail ? `/media/thumbs/${thumbFilename(r.filename)}` : `/media/${r.filename}`,
      caption: r.caption ?? undefined,
    })),
  );
});

photoRoutes.post('/', requireAuth, async (c) => {
  const form = await c.req.formData();
  const file = form.get('photo');
  const caption = form.get('caption');
  if (!(file instanceof File)) {
    return c.json({ error: 'photo file is required' }, 400);
  }
  const ext = ALLOWED_TYPES[file.type];
  if (!ext) {
    return c.json({ error: 'Unsupported file type -- JPEG, PNG, GIF, or WebP only' }, 400);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return c.json({ error: `File too large -- ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB max` }, 400);
  }

  const filename = `${crypto.randomUUID()}${ext}`;
  await Bun.write(path.join(PHOTOS_DIR, filename), file);

  // Best-effort -- a thumbnail failure (corrupt image data past what the
  // content-type check alone can catch) shouldn't fail the whole upload,
  // same "degrade gracefully" pattern used elsewhere in this codebase (e.g.
  // eQSL card fetch failures). has_thumbnail just stays 0 and GET / falls
  // back to serving the full-size original for this photo.
  let hasThumbnail = false;
  try {
    await sharp(await file.arrayBuffer())
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toFile(path.join(PHOTOS_THUMBS_DIR, thumbFilename(filename)));
    hasThumbnail = true;
  } catch (err) {
    console.error('Thumbnail generation failed:', err instanceof Error ? err.message : err);
  }

  db.query('INSERT INTO photos (filename, caption, has_thumbnail) VALUES (?, ?, ?)').run(
    filename,
    typeof caption === 'string' && caption.length ? caption : null,
    hasThumbnail ? 1 : 0,
  );
  return c.json({ ok: true, url: `/media/${filename}` }, 201);
});

photoRoutes.delete('/:id', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  const row = db.query('SELECT filename, has_thumbnail FROM photos WHERE id = ?').get(id) as
    | { filename: string; has_thumbnail: number }
    | null;
  if (!row) return c.json({ error: 'Photo not found' }, 404);
  db.query('DELETE FROM photos WHERE id = ?').run(id);
  try {
    await unlink(path.join(PHOTOS_DIR, row.filename));
  } catch {
    // File already gone from disk — the DB row is still deleted, which is what matters.
  }
  if (row.has_thumbnail) {
    try {
      await unlink(path.join(PHOTOS_THUMBS_DIR, thumbFilename(row.filename)));
    } catch {
      // Same as above -- non-fatal.
    }
  }
  return c.json({ ok: true });
});
