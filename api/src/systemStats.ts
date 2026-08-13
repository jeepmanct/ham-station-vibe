import os from 'node:os';
import { DATA_DIR } from './db';

export type DiskUsage = { path: string; totalBytes: number; usedBytes: number; availableBytes: number; usedPercent: number };

export type SystemStats = {
  hostname: string;
  platform: string;
  arch: string;
  uptimeSec: number;
  loadAvg: [number, number, number];
  cpu: { model: string; cores: number };
  cpuTempC: number | null;
  memory: { totalBytes: number; availableBytes: number; usedBytes: number; usedPercent: number };
  disks: DiskUsage[];
};

/** SoC temperature from the standard Linux thermal-zone sysfs path -- present on Raspberry Pi and most ARM SBCs, absent (gracefully) on a generic x86 box. */
async function readCpuTempC(): Promise<number | null> {
  try {
    const raw = await Bun.file('/sys/class/thermal/thermal_zone0/temp').text();
    const milliC = Number(raw.trim());
    return Number.isFinite(milliC) ? milliC / 1000 : null;
  } catch {
    return null;
  }
}

/** os.cpus()[0].model reads /proc/cpuinfo's "model name" field, which plain ARM boards (Raspberry Pi included) don't populate -- reports "unknown" there instead of a real CPU identity. /proc/cpuinfo's separate "Model" line (Pi-specific, one line for the whole board) is a much more useful fallback: "Raspberry Pi 4 Model B Rev 1.5" beats "unknown". */
async function readArmBoardModel(): Promise<string | null> {
  try {
    const raw = await Bun.file('/proc/cpuinfo').text();
    return raw.match(/^Model\s*:\s*(.+)$/m)?.[1].trim() ?? null;
  } catch {
    return null;
  }
}

/** /proc/meminfo's MemAvailable accounts for reclaimable disk cache, unlike os.freemem()'s raw free-pages count, which looks artificially low on Linux (most "free" RAM is actually cache reclaimed on demand). Falls back to os.freemem() if /proc isn't available (non-Linux). */
async function readMemAvailableBytes(): Promise<number | null> {
  try {
    const raw = await Bun.file('/proc/meminfo').text();
    const match = raw.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

async function diskUsage(targetPath: string): Promise<DiskUsage | null> {
  try {
    const proc = Bun.spawn(['df', '-B1', '--output=size,used,avail', targetPath], { stdout: 'pipe', stderr: 'ignore' });
    const output = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    const dataLine = output.trim().split('\n').at(-1)?.trim().split(/\s+/);
    if (!dataLine || dataLine.length < 3) return null;
    const [totalBytes, usedBytes, availableBytes] = dataLine.map(Number);
    if (![totalBytes, usedBytes, availableBytes].every(Number.isFinite)) return null;
    return { path: targetPath, totalBytes, usedBytes, availableBytes, usedPercent: (usedBytes / totalBytes) * 100 };
  } catch {
    return null;
  }
}

export async function getSystemStats(): Promise<SystemStats> {
  const totalBytes = os.totalmem();
  const availableBytes = (await readMemAvailableBytes()) ?? os.freemem();
  const cpus = os.cpus();

  // Root filesystem, plus DATA_DIR's own filesystem if it's a separate
  // mount (e.g. an external SSD) -- deduped so a default install (DATA_DIR
  // under the app's own directory, same filesystem as /) doesn't list the
  // same disk twice.
  const diskPaths = [...new Set(['/', DATA_DIR])];
  const disks = (await Promise.all(diskPaths.map(diskUsage))).filter((d): d is DiskUsage => d !== null);

  const rawCpuModel = cpus[0]?.model;
  const cpuModel = rawCpuModel && rawCpuModel !== 'unknown' ? rawCpuModel : ((await readArmBoardModel()) ?? 'Unknown');

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    uptimeSec: os.uptime(),
    loadAvg: os.loadavg() as [number, number, number],
    cpu: { model: cpuModel, cores: cpus.length },
    cpuTempC: await readCpuTempC(),
    memory: {
      totalBytes,
      availableBytes,
      usedBytes: totalBytes - availableBytes,
      usedPercent: ((totalBytes - availableBytes) / totalBytes) * 100,
    },
    disks,
  };
}

/**
 * Reboots the host. Requires a narrowly-scoped sudoers rule (see
 * deploy/hamstation-system-sudoers) granting this process's user
 * passwordless sudo for exactly `systemctl reboot` -- nothing broader.
 * `systemctl reboot` schedules the shutdown and returns quickly, so the
 * HTTP response reaches the caller before the machine actually goes down.
 */
export async function rebootSystem(): Promise<void> {
  const proc = Bun.spawn(['sudo', '/usr/bin/systemctl', 'reboot'], { stdout: 'ignore', stderr: 'pipe' });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(stderr.trim() || `reboot command exited with code ${exitCode}`);
  }
}
