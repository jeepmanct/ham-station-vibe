import { Hono } from 'hono';
import { requireAuth } from '../auth';
import { runBackup, listBackups, backupDestination, downloadBackupStream, saveUploadedBackup, restoreBackup } from '../backup';

export const backupRoutes = new Hono();

// Admin-only throughout -- unlike most status endpoints on this site,
// backup destination/contents reveal real filesystem layout, and every
// action here (run/download/upload/restore) is either a real disk-write
// or, for restore, genuinely destructive.
backupRoutes.get('/status', requireAuth, (c) => {
  const backups = listBackups();
  return c.json({
    destination: backupDestination(),
    backups: backups.map((b) => ({ name: b.name, date: b.date.toISOString(), sizeBytes: b.sizeBytes })),
  });
});

backupRoutes.post('/run', requireAuth, async (c) => {
  try {
    const result = runBackup();
    return c.json({ ok: true, dir: result.dir, dbBytes: result.dbBytes });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Backup failed' }, 500);
  }
});

// The "download to iCloud" half of backup/restore -- there's no
// server-side API for pushing a file into a user's iCloud Drive, so this
// is a plain file download; saving it into iCloud Drive from there is the
// browser's/OS's own "Save to Files" flow.
backupRoutes.get('/:name/download', requireAuth, (c) => {
  const name = c.req.param('name');
  try {
    const stream = downloadBackupStream(name);
    return new Response(stream, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${name}.tar.gz"`,
      },
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Download failed' }, 404);
  }
});

// The "upload from iCloud" half -- picking a file via the OS's native
// file picker (which already shows iCloud Drive as a source) and
// uploading it here adds it to the backup list; it isn't restored until
// a separate, explicit POST /:name/restore.
backupRoutes.post('/upload', requireAuth, async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('backup');
  if (!(file instanceof File)) {
    return c.json({ error: 'backup file is required' }, 400);
  }
  try {
    const name = await saveUploadedBackup(file);
    return c.json({ ok: true, name });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Upload failed' }, 400);
  }
});

// Requires an exact confirmation phrase in the body, not just the
// Authorization header -- a deliberate second, backend-enforced gate on
// top of whatever confirmation the frontend already does, since this is
// the one action on this whole site that can genuinely destroy live data.
backupRoutes.post('/:name/restore', requireAuth, async (c) => {
  const name = c.req.param('name');
  const body = await c.req.json().catch(() => null);
  if (body?.confirmPhrase !== 'RESTORE') {
    return c.json({ error: 'confirmPhrase must be exactly "RESTORE"' }, 400);
  }
  try {
    const result = restoreBackup(name);
    return c.json({ ok: true, safetyBackupDir: result.safetyBackupDir });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Restore failed' }, 500);
  }
});
