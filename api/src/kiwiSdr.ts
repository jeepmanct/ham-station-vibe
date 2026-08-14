// Live client for a KiwiSDR receiver on the local network (verified live
// against a real Kiwi, firmware v1.902). KiwiSDR has no official protocol
// documentation -- this is ported from the community
// reference implementation (github.com/jks-prv/kiwiclient's kiwi/client.py)
// and confirmed byte-for-byte against real captured frames (see the probe
// scripts used during development), not trusted from the Python source
// alone -- notably the "skip one extra byte after the tag" quirk on MSG/W-F
// frames (but NOT on SND frames), and the "audio doesn't start flowing
// until you reply to the sample_rate MSG with squelch/gen/mod/agc/
// compression, in that order" handshake, which isn't obvious from a
// surface read of the client and was only confirmed by watching real
// traffic.
//
// Same lazy connect-on-demand shape as flexRadio.ts's audio listeners: the
// Kiwi only has a handful of channels free for password-less connections
// (chan_no_pwd=4 on this station's unit), so this only holds one open while
// at least one browser viewer is actually on the page, fanned out from here
// to however many browser WebSocket clients are connected -- one upstream
// Kiwi channel no matter how many people are listening on the site.
//
// Tuning is open to everyone, not admin-gated -- unlike flexRadio.ts's
// control slice, there's no remote-control risk here to design around
// (KiwiSDR is receive-only hardware, there's no TX to accidentally key), so
// there's no safety reason to restrict it. A retune does affect every
// current listener at once (one shared upstream channel, see below), which
// is a deliberate tradeoff for a public showcase receiver rather than an
// oversight.
import { db } from './db';
import { getKiwiSdrHost } from './serviceCredentials';

const DEFAULT_PORT = 8073;
const DEFAULT_FREQ_KHZ = 7255;
const DEFAULT_MODE = 'lsb';
const WF_ZOOM = 10; // ~29.3kHz span (30000kHz / 2^10) centered on the tuned frequency
const RECONNECT_DELAY_MS = 10_000;
const KEEPALIVE_INTERVAL_MS = 1000;
const CONNECT_TIMEOUT_MS = 8000;

// Current tuning -- starts at the fixed default above, but is just regular
// mutable state now that setFrequency() below can change it. Deliberately
// NOT persisted to the database: resets to the default on every API
// restart, same as flexRadio.ts's control slice always resetting to
// DEFAULT_CONTROL_FREQ_MHZ rather than remembering its last frequency.
let currentFreqKhz = DEFAULT_FREQ_KHZ;
let currentMode = DEFAULT_MODE;

function getEnabledRow(): { enabled: number } | null {
  return db.query('SELECT enabled FROM kiwisdr_settings WHERE id = 1').get() as { enabled: number } | null;
}

/** Whether the /kiwisdr page shows its content at all -- defaults true, see db.ts's table comment for why. */
export function getKiwiSdrEnabled(): boolean {
  const row = getEnabledRow();
  return row ? row.enabled === 1 : true;
}

export function setKiwiSdrEnabled(enabled: boolean) {
  db.query(
    `INSERT INTO kiwisdr_settings (id, enabled) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled`,
  ).run(enabled ? 1 : 0);
}

// Default passbands, ported verbatim from kiwiclient's own table -- only
// the entries reachable via DEFAULT_MODE actually matter today, but kept
// as a small table (not a single hardcoded pair) so changing DEFAULT_MODE
// later doesn't also require hand-deriving new cut values.
const MODE_PASSBANDS: Record<string, [number, number]> = {
  am: [-4900, 4900],
  amn: [-2500, 2500],
  sam: [-4900, 4900],
  lsb: [-2700, -300],
  usb: [300, 2700],
  cw: [300, 700],
  nbfm: [-6000, 6000],
};

function parseHost(): { hostname: string; port: number } | null {
  const raw = getKiwiSdrHost();
  if (!raw) return null;
  const [hostname, portStr] = raw.split(':');
  if (!hostname) return null;
  const port = portStr ? Number(portStr) : DEFAULT_PORT;
  return { hostname, port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT };
}

function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/(\S+?)=(\S*)/g)) out[m[1]] = m[2];
  return out;
}

// Semi-unique session id embedded in the connection URL -- the server
// doesn't validate it against anything, it's just how a client's
// "instance" is named in the URL path (confirmed live: an arbitrary value
// works fine, matching kiwiclient's own int(time.time()+pid) & 0xffffffff
// approach of "unique enough, not actually checked").
function wsTimestamp(): number {
  return (Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 100_000)) & 0xffffffff;
}

type ConnectResult = { ok: true } | { ok: false; error: string };
type AudioListener = (pcm: Int16Array) => void;
type WaterfallListener = (bins: Uint8Array) => void;

const audioListeners = new Set<AudioListener>();
const wfListeners = new Set<WaterfallListener>();

let sndSocket: WebSocket | null = null;
let wfSocket: WebSocket | null = null;
let sndKeepalive: ReturnType<typeof setInterval> | null = null;
let wfKeepalive: ReturnType<typeof setInterval> | null = null;
let sndReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wfReconnectTimer: ReturnType<typeof setTimeout> | null = null;

const status = {
  sndConnected: false,
  wfConnected: false,
  sampleRate: null as number | null,
  smeterDbm: null as number | null,
};

export type KiwiSdrStatus = {
  configured: boolean;
  enabled: boolean;
  sndConnected: boolean;
  wfConnected: boolean;
  freqKhz: number;
  mode: string;
  sampleRate: number | null;
  smeterDbm: number | null;
};

export function getKiwiSdrStatus(): KiwiSdrStatus {
  return {
    configured: !!parseHost(),
    enabled: getKiwiSdrEnabled(),
    sndConnected: status.sndConnected,
    wfConnected: status.wfConnected,
    freqKhz: currentFreqKhz,
    mode: currentMode,
    sampleRate: status.sampleRate,
    smeterDbm: status.smeterDbm,
  };
}

/** Retunes the shared receiver -- affects every current listener/viewer at once (see this file's header comment). Sends live SET commands to any already-open upstream connections; if nothing's connected right now, just updates what the next connection will tune to. */
export function setFrequency(freqKhz: number, mode: string): ConnectResult {
  if (!getKiwiSdrEnabled()) return { ok: false, error: 'KiwiSDR is currently disabled' };
  const passband = MODE_PASSBANDS[mode];
  if (!passband) return { ok: false, error: `Unknown mode: ${mode}` };
  if (!Number.isFinite(freqKhz) || freqKhz < 0 || freqKhz > 30_000) {
    return { ok: false, error: 'Frequency must be between 0 and 30000 kHz' };
  }
  currentFreqKhz = freqKhz;
  currentMode = mode;
  const [lowCut, highCut] = passband;
  if (sndSocket && status.sndConnected) {
    sndSocket.send(`SET mod=${mode} low_cut=${lowCut} high_cut=${highCut} freq=${freqKhz.toFixed(3)}`);
  }
  if (wfSocket && status.wfConnected) {
    wfSocket.send(`SET zoom=${WF_ZOOM} cf=${freqKhz.toFixed(3)}`);
  }
  return { ok: true };
}

// SND frame layout (confirmed live): 3-byte tag, then flags(1) seq(4 LE)
// smeter(2 BE), then audio data -- no extra skip byte here, unlike MSG/W-F
// below. Requested uncompressed (SET compression=0) specifically so this
// doesn't need to also port kiwiclient's IMA-ADPCM decoder -- the Kiwi is
// on the same LAN as this server, so the bandwidth compression exists to
// save isn't a real concern here.
function handleSndFrame(data: Uint8Array) {
  if (data.length < 10) return;
  const smeterRaw = (data[8] << 8) | data[9];
  status.smeterDbm = 0.1 * smeterRaw - 127;
  const audioBytes = data.subarray(10);
  const sampleCount = audioBytes.length >> 1;
  if (sampleCount === 0 || audioListeners.size === 0) return;
  const view = new DataView(audioBytes.buffer, audioBytes.byteOffset, audioBytes.byteLength);
  const pcm = new Int16Array(sampleCount);
  // Big-endian on the wire (confirmed live) -- only camping clients (not
  // used here) ever see little-endian samples, per SND_FLAG_LITTLE_ENDIAN's
  // scope in the reference client.
  for (let i = 0; i < sampleCount; i++) pcm[i] = view.getInt16(i * 2, false);
  for (const listener of audioListeners) listener(pcm);
}

// Raw waterfall bytes turned out NOT to span anything close to the full
// 0-255 range in practice -- confirmed live by histogramming a real
// capture: virtually every value on this station's Kiwi landed between
// ~130 and ~170, a ~40-value-wide band out of the 256 available. A fixed
// byte->color mapping assuming full range renders that whole real-world
// spread as a near-solid color (this is why the waterfall first shipped
// looking uniformly green -- 130-170 all fell in one narrow slice of the
// gradient). No official calibration formula exists to convert these bytes
// to real dBm either (see this file's header comment), so rather than
// guess one, this contrast-stretches each row to ITS OWN observed range
// instead of trusting the byte values' absolute scale.
//
// Per-row 2nd/98th percentiles (not raw min/max) so a single stuck pixel
// or one strong spike doesn't blow out the whole row's contrast, then
// exponentially smoothed across rows so the display doesn't visibly jump
// between frames as those percentiles wobble.
let wfLo: number | null = null;
let wfHi: number | null = null;
const WF_SMOOTHING = 0.05;
const WF_MIN_SPAN = 8; // floor so a dead-quiet band doesn't get amplified into pure noise

function handleWfFrame(data: Uint8Array) {
  if (data.length < 16 || wfListeners.size === 0) return;
  const raw = data.subarray(16);
  const sorted = Uint8Array.from(raw).sort();
  const p2 = sorted[Math.floor(sorted.length * 0.02)];
  const p98 = sorted[Math.floor(sorted.length * 0.98)];
  wfLo = wfLo === null ? p2 : wfLo * (1 - WF_SMOOTHING) + p2 * WF_SMOOTHING;
  wfHi = wfHi === null ? p98 : wfHi * (1 - WF_SMOOTHING) + p98 * WF_SMOOTHING;
  const span = Math.max(wfHi - wfLo, WF_MIN_SPAN);

  const bins = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const normalized = ((raw[i] - wfLo) / span) * 255;
    bins[i] = normalized < 0 ? 0 : normalized > 255 ? 255 : normalized;
  }
  for (const listener of wfListeners) listener(bins);
}

function scheduleSndReconnect() {
  if (sndReconnectTimer) return;
  sndReconnectTimer = setTimeout(() => {
    sndReconnectTimer = null;
    if (audioListeners.size > 0) connectSnd();
  }, RECONNECT_DELAY_MS);
}

function scheduleWfReconnect() {
  if (wfReconnectTimer) return;
  wfReconnectTimer = setTimeout(() => {
    wfReconnectTimer = null;
    if (wfListeners.size > 0) connectWf();
  }, RECONNECT_DELAY_MS);
}

function connectSnd(): Promise<ConnectResult> {
  return new Promise((resolve) => {
    const host = parseHost();
    if (!host) {
      resolve({ ok: false, error: "KiwiSDR host not configured -- set it under Admin → KiwiSDR Configuration" });
      return;
    }
    if (sndSocket) {
      resolve({ ok: true });
      return;
    }

    let settled = false;
    const finish = (result: ConnectResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      resolve(result);
    };

    const ws = new WebSocket(`ws://${host.hostname}:${host.port}/${wsTimestamp()}/SND`);
    ws.binaryType = 'arraybuffer';
    sndSocket = ws;

    const timeoutTimer = setTimeout(() => {
      finish({ ok: false, error: 'Timed out connecting to the KiwiSDR' });
      ws.close();
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      ws.send('SET auth t=kiwi p=');
      sndKeepalive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('SET keepalive');
      }, KEEPALIVE_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      const data = new Uint8Array(event.data as ArrayBuffer);
      if (data.length < 3) return;
      const tag = String.fromCharCode(data[0], data[1], data[2]);
      if (tag === 'MSG') {
        const kv = parseKeyValues(new TextDecoder().decode(data.subarray(4)));
        if (kv.badp === '1') {
          finish({ ok: false, error: 'KiwiSDR rejected the connection (bad password, or all free channels are busy)' });
          ws.close();
          return;
        }
        if (kv.down !== undefined) {
          finish({ ok: false, error: 'KiwiSDR reports it is down' });
          ws.close();
          return;
        }
        if (kv.audio_rate) {
          ws.send(`SET AR OK in=${kv.audio_rate} out=44100`);
        }
        if (kv.sample_rate) {
          status.sampleRate = Number(kv.sample_rate);
          const [lowCut, highCut] = MODE_PASSBANDS[currentMode] ?? MODE_PASSBANDS.lsb;
          // This exact order -- squelch/gen before mod/agc/compression --
          // is required to get audio flowing at all; confirmed live that
          // sending mod/agc/compression immediately on open (before this
          // MSG arrives) connects fine but never produces a single SND
          // frame. Matches kiwiclient's own "Required to get rolling"
          // comment on this same sequence.
          ws.send('SET squelch=0 max=0');
          ws.send('SET genattn=0');
          ws.send('SET gen=0 mix=-1');
          ws.send(`SET mod=${currentMode} low_cut=${lowCut} high_cut=${highCut} freq=${currentFreqKhz.toFixed(3)}`);
          ws.send('SET agc=1 hang=0 thresh=-100 slope=6 decay=1000 manGain=50');
          ws.send('SET compression=0');
          ws.send('SET keepalive');
          status.sndConnected = true;
          finish({ ok: true });
        }
      } else if (tag === 'SND') {
        handleSndFrame(data);
      }
    };

    ws.onerror = () => {
      finish({ ok: false, error: 'Could not connect to the KiwiSDR' });
    };

    ws.onclose = () => {
      finish({ ok: false, error: 'KiwiSDR connection closed' });
      sndSocket = null;
      status.sndConnected = false;
      if (sndKeepalive) {
        clearInterval(sndKeepalive);
        sndKeepalive = null;
      }
      if (audioListeners.size > 0) scheduleSndReconnect();
    };
  });
}

function connectWf(): Promise<ConnectResult> {
  return new Promise((resolve) => {
    const host = parseHost();
    if (!host) {
      resolve({ ok: false, error: "KiwiSDR host not configured -- set it under Admin → KiwiSDR Configuration" });
      return;
    }
    if (wfSocket) {
      resolve({ ok: true });
      return;
    }

    let settled = false;
    const finish = (result: ConnectResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      resolve(result);
    };

    const ws = new WebSocket(`ws://${host.hostname}:${host.port}/${wsTimestamp()}/W/F`);
    ws.binaryType = 'arraybuffer';
    wfSocket = ws;

    const timeoutTimer = setTimeout(() => {
      finish({ ok: false, error: 'Timed out connecting to the KiwiSDR waterfall' });
      ws.close();
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      // Unlike SND, waterfall frames start flowing right after these
      // (confirmed live) -- no need to wait for a sample_rate-style ack
      // first.
      ws.send('SET auth t=kiwi p=');
      ws.send(`SET zoom=${WF_ZOOM} cf=${currentFreqKhz.toFixed(3)}`);
      ws.send('SET maxdb=-10 mindb=-110');
      ws.send('SET wf_speed=4');
      ws.send('SET wf_comp=0');
      wfKeepalive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('SET keepalive');
      }, KEEPALIVE_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      const data = new Uint8Array(event.data as ArrayBuffer);
      if (data.length < 3) return;
      const tag = String.fromCharCode(data[0], data[1], data[2]);
      if (tag === 'MSG') {
        const kv = parseKeyValues(new TextDecoder().decode(data.subarray(4)));
        if (kv.badp === '1') {
          finish({ ok: false, error: 'KiwiSDR rejected the waterfall connection (bad password, or all free channels are busy)' });
          ws.close();
        }
      } else if (tag === 'W/F') {
        if (!status.wfConnected) {
          status.wfConnected = true;
          finish({ ok: true });
        }
        handleWfFrame(data);
      }
    };

    ws.onerror = () => {
      finish({ ok: false, error: 'Could not connect to the KiwiSDR waterfall' });
    };

    ws.onclose = () => {
      finish({ ok: false, error: 'KiwiSDR waterfall connection closed' });
      wfSocket = null;
      status.wfConnected = false;
      if (wfKeepalive) {
        clearInterval(wfKeepalive);
        wfKeepalive = null;
      }
      if (wfListeners.size > 0) scheduleWfReconnect();
    };
  });
}

/** First listener triggers the actual upstream connection; every listener after that shares it. */
export async function registerAudioListener(listener: AudioListener): Promise<ConnectResult> {
  if (!getKiwiSdrEnabled()) return { ok: false, error: 'KiwiSDR is currently disabled' };
  audioListeners.add(listener);
  const result = await connectSnd();
  if (!result.ok) audioListeners.delete(listener);
  return result;
}

export function unregisterAudioListener(listener: AudioListener) {
  audioListeners.delete(listener);
  if (audioListeners.size > 0) return;
  if (sndReconnectTimer) {
    clearTimeout(sndReconnectTimer);
    sndReconnectTimer = null;
  }
  if (sndKeepalive) {
    clearInterval(sndKeepalive);
    sndKeepalive = null;
  }
  sndSocket?.close();
  sndSocket = null;
  status.sndConnected = false;
}

export async function registerWaterfallListener(listener: WaterfallListener): Promise<ConnectResult> {
  if (!getKiwiSdrEnabled()) return { ok: false, error: 'KiwiSDR is currently disabled' };
  wfListeners.add(listener);
  const result = await connectWf();
  if (!result.ok) wfListeners.delete(listener);
  return result;
}

export function unregisterWaterfallListener(listener: WaterfallListener) {
  wfListeners.delete(listener);
  if (wfListeners.size > 0) return;
  if (wfReconnectTimer) {
    clearTimeout(wfReconnectTimer);
    wfReconnectTimer = null;
  }
  if (wfKeepalive) {
    clearInterval(wfKeepalive);
    wfKeepalive = null;
  }
  wfSocket?.close();
  wfSocket = null;
  status.wfConnected = false;
}

const NOISE_FLOOR_SAMPLE_MS = 1500;
const NOISE_FLOOR_POLL_MS = 200;

/**
 * A brief spot-check, not a live stream -- registers a throwaway audio
 * listener just long enough to average a handful of S-meter readings, then
 * unregisters it. If nobody else is listening, this opens the upstream
 * connection for ~1.5s and then closes it again (registerAudioListener/
 * unregisterAudioListener's normal open-on-first-listener/close-on-last
 * behavior handles that automatically); if someone already is, it just
 * piggybacks on their existing connection without disturbing it. Used for
 * /conditions' "how busy is this band right now" widget -- deliberately
 * NOT a continuous poll, which would mean quietly holding one of the
 * Kiwi's few free channels open just for that page to exist, the exact
 * thing every other lazy-connect choice in this file exists to avoid.
 */
export async function sampleNoiseFloor(): Promise<
  { ok: true; smeterDbm: number; freqKhz: number; mode: string } | { ok: false; error: string }
> {
  if (!getKiwiSdrEnabled()) return { ok: false, error: 'KiwiSDR is currently disabled' };
  const listener: AudioListener = () => {};
  const result = await registerAudioListener(listener);
  if (!result.ok) return result;
  try {
    const samples: number[] = [];
    const ticks = Math.round(NOISE_FLOOR_SAMPLE_MS / NOISE_FLOOR_POLL_MS);
    for (let i = 0; i < ticks; i++) {
      await new Promise((resolve) => setTimeout(resolve, NOISE_FLOOR_POLL_MS));
      if (status.smeterDbm !== null) samples.push(status.smeterDbm);
    }
    if (samples.length === 0) return { ok: false, error: 'No signal reading yet -- try again' };
    const avgDbm = samples.reduce((a, b) => a + b, 0) / samples.length;
    return { ok: true, smeterDbm: avgDbm, freqKhz: currentFreqKhz, mode: currentMode };
  } finally {
    unregisterAudioListener(listener);
  }
}
