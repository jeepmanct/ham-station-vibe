import { mkdirSync, readdirSync, rmSync, cpSync, existsSync, renameSync, unlinkSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { db, DATA_DIR, PHOTOS_DIR, EQSL_CARDS_DIR } from './db';

// Outside DATA_DIR by default -- a backup meant to protect against e.g. an
// external SSD holding DATA_DIR failing shouldn't itself live on that same
// SSD. import.meta.dir is api/src, so '..'/'backups' resolves to api/backups
// on whatever filesystem the app's own code lives on (typically the SD
// card on a Pi, a different physical device than a DATA_DIR pointed at an
// external drive).
const BACKUP_DIR = process.env.BACKUP_DIR ?? path.join(import.meta.dir, '..', 'backups');
const RETENTION_COUNT = Number(process.env.BACKUP_RETENTION_COUNT) || 3;
// Only needs overriding if you renamed the systemd unit from what setup.sh
// installs it as -- see restoreBackup()'s comment for why a restart matters.
const API_SERVICE_NAME = process.env.API_SERVICE_NAME ?? 'hamstation-api';

export type BackupResult = { dir: string; dbBytes: number };
export type BackupEntry = { name: string; date: Date; sizeBytes: number };

// Explicit UTC components rather than toISOString().replace(/[:.]/g, '-')
// -- that approach also strips the trailing "Z", and re-parsing a
// Z-less "YYYY-MM-DDTHH-MM-SS" string back into a Date later reads it as
// *local* time per the ECMAScript date-string spec, silently drifting the
// parsed timestamp by the server's UTC offset. Keeping an explicit Z
// (translated back to ':'-form for Date.parse) makes the round-trip exact.
function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())}-${pad(date.getUTCSeconds())}Z`;
}

function parseTimestamp(name: string): number {
  // Matched at the end of the string, not required to be the whole thing,
  // so an uploaded backup's "uploaded-<timestamp>" name parses the same
  // way a plain "<timestamp>" one does.
  const match = name.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)$/);
  if (!match) return NaN;
  return Date.parse(match[1].replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, 'T$1:$2:$3Z'));
}

/** Validates a backup name came from us (a formatTimestamp()-shaped string, optionally "uploaded-" prefixed) before it's ever used in a filesystem path -- rejects anything else, including path traversal attempts. */
function getBackupPath(name: string): string {
  if (!/^[\w-]+$/.test(name)) throw new Error(`Invalid backup name: "${name}"`);
  const resolved = path.resolve(BACKUP_DIR, name);
  if (path.dirname(resolved) !== path.resolve(BACKUP_DIR)) throw new Error(`Invalid backup name: "${name}"`);
  return resolved;
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSizeBytes(full) : Bun.file(full).size;
  }
  return total;
}

/**
 * Snapshots the database (via VACUUM INTO -- safe to run against a live
 * WAL-mode DB, unlike copying the .sqlite file directly, which can catch a
 * half-written page) plus photos/ and eqsl-cards/, into a new timestamped
 * subdirectory of BACKUP_DIR. Prunes down to the newest RETENTION_COUNT
 * entries afterward (a rolling count, not an age cutoff -- a gap in nightly
 * runs no longer means losing everything at once when the cutoff catches
 * up).
 */
export function runBackup(): BackupResult {
  mkdirSync(BACKUP_DIR, { recursive: true });

  const timestamp = formatTimestamp(new Date());
  const runDir = path.join(BACKUP_DIR, timestamp);
  mkdirSync(runDir, { recursive: true });

  const dbBackupPath = path.join(runDir, 'hamstation.sqlite');
  // Filename is our own timestamp, not external input, but escaped as
  // standard SQL practice anyway -- VACUUM INTO doesn't support `?`
  // parameter binding for its target filename.
  db.exec(`VACUUM INTO '${dbBackupPath.replaceAll("'", "''")}'`);

  if (existsSync(PHOTOS_DIR)) cpSync(PHOTOS_DIR, path.join(runDir, 'photos'), { recursive: true });
  if (existsSync(EQSL_CARDS_DIR)) cpSync(EQSL_CARDS_DIR, path.join(runDir, 'eqsl-cards'), { recursive: true });

  const existing = readdirSync(BACKUP_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, parsed: parseTimestamp(e.name) }))
    .filter((e) => !Number.isNaN(e.parsed))
    .sort((a, b) => b.parsed - a.parsed);
  for (const entry of existing.slice(RETENTION_COUNT)) {
    rmSync(path.join(BACKUP_DIR, entry.name), { recursive: true, force: true });
  }

  return { dir: runDir, dbBytes: Bun.file(dbBackupPath).size };
}

/** Lists existing backups, most recent first -- for the admin status display. */
export function listBackups(): BackupEntry[] {
  if (!existsSync(BACKUP_DIR)) return [];
  return readdirSync(BACKUP_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(BACKUP_DIR, e.name);
      return { name: e.name, date: new Date(parseTimestamp(e.name)), sizeBytes: dirSizeBytes(dir) };
    })
    .filter((b) => !Number.isNaN(b.date.getTime()))
    .sort((a, b) => b.date.getTime() - a.date.getTime());
}

export function backupDestination(): string {
  return BACKUP_DIR;
}

/** Streams a given backup as a .tar.gz -- the "download to iCloud" half of backup/restore. There's no server-side API for pushing a file into a user's iCloud Drive (Apple doesn't expose one to third parties), so this is deliberately just a plain download; saving it into iCloud Drive from there is the browser's/OS's own "Save to Files" flow, not anything this app does. */
export function downloadBackupStream(name: string): ReadableStream {
  const dir = getBackupPath(name);
  if (!existsSync(dir)) throw new Error(`Backup "${name}" not found`);
  const proc = Bun.spawn(['tar', 'czf', '-', '-C', BACKUP_DIR, name], { stdout: 'pipe' });
  return proc.stdout as ReadableStream;
}

/**
 * The "upload from iCloud" half -- accepts a .tar.gz previously produced by
 * downloadBackupStream() (of this backup or a personal one from before, same
 * shape either way), extracts and validates it looks like a real backup,
 * and adds it to BACKUP_DIR as a new "uploaded-<now>" entry. Doesn't
 * restore anything by itself -- the result just shows up in listBackups()
 * like any other entry, restored the same way (via restoreBackup()) once
 * the admin explicitly chooses to.
 */
export async function saveUploadedBackup(file: File): Promise<string> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'hamstation-upload-'));
  try {
    const tmpTar = path.join(tmpRoot, 'upload.tar.gz');
    writeFileSync(tmpTar, Buffer.from(await file.arrayBuffer()));
    const extractDir = path.join(tmpRoot, 'extracted');
    mkdirSync(extractDir);
    const result = Bun.spawnSync(['tar', 'xzf', tmpTar, '-C', extractDir]);
    if (result.exitCode !== 0) throw new Error('Could not extract the uploaded file -- is it a .tar.gz backup archive?');

    const topLevel = readdirSync(extractDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    if (topLevel.length !== 1) throw new Error('Uploaded archive does not look like a single backup (expected exactly one top-level folder).');
    const extractedDir = path.join(extractDir, topLevel[0].name);
    if (!existsSync(path.join(extractedDir, 'hamstation.sqlite'))) {
      throw new Error('Uploaded archive has no hamstation.sqlite -- not a valid backup.');
    }

    mkdirSync(BACKUP_DIR, { recursive: true });
    const newName = `uploaded-${formatTimestamp(new Date())}`;
    // cpSync + remove, not renameSync -- extractDir (under the OS tmpdir)
    // and BACKUP_DIR aren't guaranteed to be on the same filesystem, and a
    // cross-device rename() fails outright.
    cpSync(extractedDir, path.join(BACKUP_DIR, newName), { recursive: true });
    return newName;
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

export type RestoreResult = { safetyBackupDir: string };

/**
 * Restores the live database and photos from a backup. Always takes a
 * fresh safety backup of the CURRENT state first, so even restoring the
 * wrong one is itself recoverable. The database file is swapped in via an
 * atomic rename rather than an in-place overwrite -- the live process
 * keeps working against its already-open file handle to the OLD file
 * completely undisturbed (normal Unix "unlink/rename while open" behavior)
 * right up until it restarts, so nothing is ever corrupted mid-request.
 * Photos/eqsl-cards are replaced wholesale, not merged -- a restore means
 * "back to exactly this point," not "combine with whatever's live now."
 *
 * Finishes by restarting the API service itself (a narrowly-scoped
 * sudoers rule, same pattern as Device Stats' reboot button -- see
 * deploy/hamstation-system-sudoers) so the new process opens the
 * swapped-in database with a clean connection. Stale -wal/-shm files from
 * the PRE-restore database are deleted first: SQLite associates a WAL
 * file with its main database by path, not by content, so leaving the old
 * one in place would have the restarted process try to replay journal
 * frames that don't correspond to the newly-restored file at all.
 */
export function restoreBackup(name: string): RestoreResult {
  const dir = getBackupPath(name);
  const backupDbPath = path.join(dir, 'hamstation.sqlite');
  if (!existsSync(backupDbPath)) throw new Error(`Backup "${name}" has no hamstation.sqlite -- nothing to restore from it.`);

  const safety = runBackup();

  const liveDbPath = path.join(DATA_DIR, 'hamstation.sqlite');
  const stagedPath = `${liveDbPath}.restoring`;
  cpSync(backupDbPath, stagedPath);
  renameSync(stagedPath, liveDbPath);
  for (const suffix of ['-wal', '-shm']) {
    try {
      unlinkSync(`${liveDbPath}${suffix}`);
    } catch {
      // Fine if it never existed.
    }
  }

  const backupPhotosDir = path.join(dir, 'photos');
  if (existsSync(backupPhotosDir)) {
    rmSync(PHOTOS_DIR, { recursive: true, force: true });
    cpSync(backupPhotosDir, PHOTOS_DIR, { recursive: true });
  }
  const backupEqslDir = path.join(dir, 'eqsl-cards');
  if (existsSync(backupEqslDir)) {
    rmSync(EQSL_CARDS_DIR, { recursive: true, force: true });
    cpSync(backupEqslDir, EQSL_CARDS_DIR, { recursive: true });
  }

  // --no-block: without it, `systemctl restart` waits for the full
  // stop-then-start cycle to finish, including this very process
  // receiving SIGTERM and dying mid-await -- with it, the command just
  // queues the job and returns immediately, letting this request's HTTP
  // response actually make it back to the caller first.
  Bun.spawnSync(['sudo', '/usr/bin/systemctl', 'restart', '--no-block', API_SERVICE_NAME]);

  return { safetyBackupDir: safety.dir };
}
