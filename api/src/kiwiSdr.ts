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
const DEFAULT_WF_ZOOM = 10; // ~29.3kHz span (30000kHz / 2^10) centered on the tuned frequency
const MAX_WF_ZOOM = 14; // KiwiSDR's own zoom range is 0 (full 30MHz span) to 14 (~1.8kHz span)
const RECONNECT_DELAY_MS = 10_000;
const KEEPALIVE_INTERVAL_MS = 1000;
const CONNECT_TIMEOUT_MS = 8000;

// Current tuning -- starts at the fixed defaults above, but is just regular
// mutable state now that setFrequency() and friends below can change it.
// Deliberately NOT persisted to the database: resets to the defaults on
// every API restart, same as flexRadio.ts's control slice always resetting
// to DEFAULT_CONTROL_FREQ_MHZ rather than remembering its last frequency.
let currentFreqKhz = DEFAULT_FREQ_KHZ;
let currentMode = DEFAULT_MODE;
// null means a custom width from the fine filter-width slider is in
// effect instead of one of the three named presets -- see setFilterWidth().
let currentBandwidth: BandwidthPreset | null = 'normal';
let currentAgcEnabled = true;
let currentWfZoom = DEFAULT_WF_ZOOM;

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

// Passband (low_cut/high_cut in Hz relative to the tuned carrier) per mode,
// at three width presets. "normal" is ported verbatim from kiwiclient's own
// table (the same values this file used before the Bandwidth control
// existed); narrow/wide are hand-picked tighter/looser variants of the same
// shape -- symmetric around 0 for AM-family/NBFM, one-sided for SSB (LSB
// stays anchored at -300Hz from carrier, USB at +300Hz, only the far edge
// moves), and CW's already-narrow default just gets narrower/wider still.
type BandwidthPreset = 'narrow' | 'normal' | 'wide';
const MODE_PASSBAND_PRESETS: Record<string, Record<BandwidthPreset, [number, number]>> = {
  am: { narrow: [-2500, 2500], normal: [-4900, 4900], wide: [-8000, 8000] },
  amn: { narrow: [-1500, 1500], normal: [-2500, 2500], wide: [-4000, 4000] },
  sam: { narrow: [-2500, 2500], normal: [-4900, 4900], wide: [-8000, 8000] },
  lsb: { narrow: [-2100, -300], normal: [-2700, -300], wide: [-3300, -300] },
  usb: { narrow: [300, 2100], normal: [300, 2700], wide: [300, 3300] },
  cw: { narrow: [400, 600], normal: [300, 700], wide: [200, 800] },
  nbfm: { narrow: [-4000, 4000], normal: [-6000, 6000], wide: [-8000, 8000] },
};

// Every preset pair above is reproducible from just its total width plus
// the anchoring rule described in the comment above (symmetric for AM-
// family/NBFM/CW, one-sided for LSB/USB) -- confirmed against all three
// presets in every mode. The fine width slider reuses that same rule for
// an arbitrary width instead of one of the three fixed ones, so a custom
// width still "looks like" this app's own filters rather than an
// unrelated shape, and narrowing/widening it keeps the signal centered
// where the operator expects (the CW pitch, or the carrier for AM/NBFM).
const MIN_FILTER_WIDTH_HZ = 50;
const MAX_FILTER_WIDTH_HZ = 16_000;
const CW_PITCH_HZ = 500; // matches the center of every existing CW preset (300-700, 400-600, 200-800)
function cutsForWidth(mode: string, widthHz: number): [number, number] {
  if (mode === 'lsb') return [-(widthHz + 300), -300];
  if (mode === 'usb') return [300, 300 + widthHz];
  if (mode === 'cw') return [CW_PITCH_HZ - widthHz / 2, CW_PITCH_HZ + widthHz / 2];
  return [-widthHz / 2, widthHz / 2]; // am, amn, sam, nbfm -- symmetric around the carrier
}

// Only meaningful while currentBandwidth is null; holds whatever width the
// fine slider last requested, so a reconnect (e.g. switching public
// receivers) re-applies it instead of silently falling back to a preset.
let currentWidthHz = MODE_PASSBAND_PRESETS[DEFAULT_MODE].normal[1] - MODE_PASSBAND_PRESETS[DEFAULT_MODE].normal[0];

/** Single source of truth for the currently active passband -- either a named preset or, when currentBandwidth is null, the slider's custom width. */
function currentCuts(): [number, number] {
  if (currentBandwidth) return MODE_PASSBAND_PRESETS[currentMode]?.[currentBandwidth] ?? [0, 0];
  return cutsForWidth(currentMode, currentWidthHz);
}

// When set, this station's own configured Kiwi is temporarily set aside in
// favor of a public receiver picked from /kiwisdr's directory browser --
// see switchToPublicReceiver() below. Deliberately in-memory only, same as
// currentFreqKhz/currentMode above: an API restart reverts to this
// station's own receiver rather than remembering the last public pick,
// which is the sane default for a showcase page.
let publicOverride: { hostname: string; port: number; label: string } | null = null;

function parseHost(): { hostname: string; port: number } | null {
  if (publicOverride) return { hostname: publicOverride.hostname, port: publicOverride.port };
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
/** Notified when a connection that already reported success later turns out to have been lost/rejected -- see registerAudioListener's comment for why this exists separately from ConnectResult. */
type LossListener = (error: string) => void;

const audioListeners = new Set<AudioListener>();
const wfListeners = new Set<WaterfallListener>();
const audioLossListeners = new Set<LossListener>();
const wfLossListeners = new Set<LossListener>();

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
  /** null means a custom width from the fine slider is active, not one of the three named presets. */
  bandwidth: BandwidthPreset | null;
  widthHz: number;
  lowCutHz: number;
  highCutHz: number;
  minWidthHz: number;
  maxWidthHz: number;
  agcEnabled: boolean;
  wfZoom: number;
  maxWfZoom: number;
  listenerCount: number | null;
  listenerMax: number | null;
  source: { isPublic: boolean; label: string };
  /** How many browsers on THIS site currently have audio open against the
   * shared receiver -- distinct from listenerCount/listenerMax above,
   * which are the Kiwi's OWN /status numbers and can include listeners
   * who reached it some other way entirely (its own web UI, another
   * site). audioListeners' size already tracks exactly this, one entry
   * per connected /ws/kiwisdr-audio socket -- no separate presence
   * tracking needed. */
  siteListeners: number;
};

export async function getKiwiSdrStatus(): Promise<KiwiSdrStatus> {
  const [lowCutHz, highCutHz] = currentCuts();
  const listeners = await fetchListenerCount();
  return {
    configured: !!parseHost(),
    enabled: getKiwiSdrEnabled(),
    source: publicOverride ? { isPublic: true, label: publicOverride.label } : { isPublic: false, label: 'This station' },
    sndConnected: status.sndConnected,
    wfConnected: status.wfConnected,
    freqKhz: currentFreqKhz,
    mode: currentMode,
    sampleRate: status.sampleRate,
    smeterDbm: status.smeterDbm,
    bandwidth: currentBandwidth,
    widthHz: highCutHz - lowCutHz,
    lowCutHz,
    highCutHz,
    minWidthHz: MIN_FILTER_WIDTH_HZ,
    maxWidthHz: MAX_FILTER_WIDTH_HZ,
    agcEnabled: currentAgcEnabled,
    wfZoom: currentWfZoom,
    maxWfZoom: MAX_WF_ZOOM,
    listenerCount: listeners?.users ?? null,
    listenerMax: listeners?.usersMax ?? null,
    siteListeners: audioListeners.size,
  };
}

/** Retunes the shared receiver -- affects every current listener/viewer at once (see this file's header comment). Sends live SET commands to any already-open upstream connections; if nothing's connected right now, just updates what the next connection will tune to. A mode change resets the bandwidth preset back to "normal" (a fresh mode's own default filter shape), same as a real radio; a frequency-only retune within the same mode keeps whatever preset was already selected. */
export function setFrequency(freqKhz: number, mode: string): ConnectResult {
  if (!getKiwiSdrEnabled()) return { ok: false, error: 'KiwiSDR is currently disabled' };
  const presets = MODE_PASSBAND_PRESETS[mode];
  if (!presets) return { ok: false, error: `Unknown mode: ${mode}` };
  if (!Number.isFinite(freqKhz) || freqKhz < 0 || freqKhz > 30_000) {
    return { ok: false, error: 'Frequency must be between 0 and 30000 kHz' };
  }
  if (mode !== currentMode) currentBandwidth = 'normal';
  currentFreqKhz = freqKhz;
  currentMode = mode;
  const [lowCut, highCut] = currentCuts();
  if (sndSocket && status.sndConnected) {
    sndSocket.send(`SET mod=${mode} low_cut=${lowCut} high_cut=${highCut} freq=${freqKhz.toFixed(3)}`);
  }
  if (wfSocket && status.wfConnected) {
    wfSocket.send(`SET zoom=${currentWfZoom} cf=${freqKhz.toFixed(3)}`);
  }
  return { ok: true };
}

/** Adjusts the receive filter width for the current mode without changing frequency or mode. */
export function setBandwidth(preset: BandwidthPreset): ConnectResult {
  if (!getKiwiSdrEnabled()) return { ok: false, error: 'KiwiSDR is currently disabled' };
  const presets = MODE_PASSBAND_PRESETS[currentMode];
  if (!presets?.[preset]) return { ok: false, error: `Unknown bandwidth preset: ${preset}` };
  currentBandwidth = preset;
  const [lowCut, highCut] = presets[preset];
  if (sndSocket && status.sndConnected) {
    sndSocket.send(`SET mod=${currentMode} low_cut=${lowCut} high_cut=${highCut} freq=${currentFreqKhz.toFixed(3)}`);
  }
  return { ok: true };
}

/**
 * Fine filter-width control, alongside (not replacing) the three named
 * presets above -- lets an operator dial in exactly how wide the passband
 * is instead of only picking from narrow/normal/wide. Reuses the same
 * per-mode anchoring rule as the presets (cutsForWidth), so a custom width
 * still keeps the signal centered where it's expected (the CW pitch, the
 * carrier for AM/NBFM, the edge for SSB) rather than drifting off it.
 */
export function setFilterWidth(widthHz: number): ConnectResult {
  if (!getKiwiSdrEnabled()) return { ok: false, error: 'KiwiSDR is currently disabled' };
  if (!Number.isFinite(widthHz) || widthHz < MIN_FILTER_WIDTH_HZ || widthHz > MAX_FILTER_WIDTH_HZ) {
    return { ok: false, error: `Filter width must be between ${MIN_FILTER_WIDTH_HZ} and ${MAX_FILTER_WIDTH_HZ} Hz` };
  }
  currentWidthHz = widthHz;
  currentBandwidth = null;
  const [lowCut, highCut] = cutsForWidth(currentMode, widthHz);
  if (sndSocket && status.sndConnected) {
    sndSocket.send(`SET mod=${currentMode} low_cut=${lowCut} high_cut=${highCut} freq=${currentFreqKhz.toFixed(3)}`);
  }
  return { ok: true };
}

function agcCommand(): string {
  // manGain only takes effect when agc=0 -- it's the fixed gain used in
  // place of AGC's automatic adjustment, not a separate control (there's no
  // manual gain slider here, just this off/on toggle). 50 (of 0-100) was
  // the first value tried and turned out to be far too quiet -- confirmed
  // live by measuring real PCM RMS amplitude on a known-strong WWV carrier:
  // manGain=50 measured RMS~310 vs AGC-on's own RMS~2746 on the same
  // signal, roughly a ninth as loud, which reads as "no sound" at normal
  // listening volume. 70 was the highest value that still measured 0
  // clipped samples in that same test (manGain=80 already clips), and
  // lands close to AGC-on's own peak level.
  return currentAgcEnabled
    ? 'SET agc=1 hang=0 thresh=-100 slope=6 decay=1000 manGain=50'
    : 'SET agc=0 hang=0 thresh=-100 slope=6 decay=1000 manGain=70';
}

/** Toggles the Kiwi's own automatic gain control for the shared audio stream. */
export function setAgc(enabled: boolean): ConnectResult {
  if (!getKiwiSdrEnabled()) return { ok: false, error: 'KiwiSDR is currently disabled' };
  currentAgcEnabled = enabled;
  if (sndSocket && status.sndConnected) {
    sndSocket.send(agcCommand());
  }
  return { ok: true };
}

/** Adjusts how much spectrum the waterfall/spectrum display spans around the tuned frequency -- 0 is the Kiwi's full 30MHz, MAX_WF_ZOOM is its narrowest ~1.8kHz span. */
export function setWfZoom(zoom: number): ConnectResult {
  if (!getKiwiSdrEnabled()) return { ok: false, error: 'KiwiSDR is currently disabled' };
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > MAX_WF_ZOOM) {
    return { ok: false, error: `Zoom must be an integer between 0 and ${MAX_WF_ZOOM}` };
  }
  currentWfZoom = zoom;
  if (wfSocket && status.wfConnected) {
    wfSocket.send(`SET zoom=${currentWfZoom} cf=${currentFreqKhz.toFixed(3)}`);
  }
  return { ok: true };
}

// Tears down whatever's currently connected (if anything) and, if there are
// still listeners waiting, immediately reconnects -- against whatever host
// parseHost() now resolves to, since callers run this only after flipping
// publicOverride. Also resets the waterfall's contrast-stretch state: it's
// tuned to the PREVIOUS receiver's noise floor (see handleWfFrame's
// comment), which has no reason to still apply to a different receiver in a
// different RF environment.
function forceReconnect() {
  sndSocket?.close();
  sndSocket = null;
  status.sndConnected = false;
  if (sndKeepalive) {
    clearInterval(sndKeepalive);
    sndKeepalive = null;
  }
  if (sndReconnectTimer) {
    clearTimeout(sndReconnectTimer);
    sndReconnectTimer = null;
  }
  wfSocket?.close();
  wfSocket = null;
  status.wfConnected = false;
  if (wfKeepalive) {
    clearInterval(wfKeepalive);
    wfKeepalive = null;
  }
  if (wfReconnectTimer) {
    clearTimeout(wfReconnectTimer);
    wfReconnectTimer = null;
  }
  wfLo = null;
  wfHi = null;
  // Also scoped to the PREVIOUS receiver (see fetchListenerCount's
  // comment below) -- without clearing it here, /status can keep
  // reporting the old receiver's channel usage for up to
  // LISTENER_COUNT_TTL_MS after a switch.
  listenerCountCache = null;
  if (audioListeners.size > 0) connectSnd();
  if (wfListeners.size > 0) connectWf();
}

/**
 * Points the shared receiver at a public KiwiSDR picked from /kiwisdr's
 * directory browser instead of this station's own. `hostname`/`port` must
 * come from the route handler's own lookup against the cached public
 * directory (fetchPublicKiwiDirectory), never taken directly from client
 * input -- otherwise this function would turn into an open relay to
 * whatever host/port a visitor supplies, including this server's own LAN.
 * Same "open to everyone" reasoning as setFrequency/setAgc/etc above
 * applies to WHICH already-vetted public receiver is picked, just not to
 * WHAT host gets connected to.
 */
export function switchToPublicReceiver(hostname: string, port: number, label: string): ConnectResult {
  publicOverride = { hostname, port, label };
  forceReconnect();
  return { ok: true };
}

/** Back to this station's own configured Kiwi. */
export function switchToOwnReceiver(): ConnectResult {
  if (!publicOverride) return { ok: true };
  publicOverride = null;
  forceReconnect();
  return { ok: true };
}

// Polled from the Kiwi's own plain-HTTP /status page (confirmed live: a GET
// to http://host:port/status returns key=value lines including "users=N"
// and "users_max=M" -- current/total receive channels), not a WebSocket
// channel, so checking it never competes with the scarce SND/W-F channels
// this file otherwise guards so carefully. That same page also exposes
// operator PII (an email address, GPS coordinates) -- only users/users_max
// are ever extracted here, nothing else from that response is kept or
// exposed through this app's own API.
// Not host-scoped -- there's only ever one active receiver at a time, so a
// single cache slot is enough as long as forceReconnect() clears it on
// every switch (otherwise this would keep answering with the PREVIOUS
// receiver's numbers for up to LISTENER_COUNT_TTL_MS after switching).
let listenerCountCache: { users: number; usersMax: number; fetchedAt: number } | null = null;
const LISTENER_COUNT_TTL_MS = 4000;

async function fetchListenerCount(): Promise<{ users: number; usersMax: number } | null> {
  const host = parseHost();
  if (!host) return null;
  if (listenerCountCache && Date.now() - listenerCountCache.fetchedAt < LISTENER_COUNT_TTL_MS) {
    return listenerCountCache;
  }
  try {
    const res = await fetch(`http://${host.hostname}:${host.port}/status`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return listenerCountCache;
    const kv = parseKeyValues(await res.text());
    const users = Number(kv.users);
    const usersMax = Number(kv.users_max);
    if (!Number.isFinite(users) || !Number.isFinite(usersMax)) return listenerCountCache;
    listenerCountCache = { users, usersMax, fetchedAt: Date.now() };
    return listenerCountCache;
  } catch {
    return listenerCountCache;
  }
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

    // Every handler below starts by checking sndSocket !== ws and bailing
    // out if so -- a switchToPublicReceiver()/switchToOwnReceiver() call
    // can close THIS socket and start a fresh one (to the new host) while
    // this connectSnd() call's handshake is still in flight, which
    // previously still let this stale connection's finish() resolve the
    // ORIGINAL registerAudioListener() call with ok:false. That deleted
    // the listener from audioListeners and told the client's WebSocket to
    // close with an error, even though the NEW connection (already
    // underway, sharing the same audioListeners set) was about to succeed
    // -- confirmed live as the exact cause of "switching to a public
    // receiver connects the waterfall fine but never produces audio"
    // (waterfall's handshake is faster -- no MSG round-trip needed before
    // its first frame -- so it usually wins the race and finishes before
    // a switch lands, while audio's slower handshake is still the one
    // left holding a now-superseded connection). Leaving this stale call's
    // promise unresolved is fine: nothing but its own now-irrelevant
    // .then() awaits it, and the listener stays registered for the new
    // connection to deliver audio to once it completes its own handshake.
    const timeoutTimer = setTimeout(() => {
      if (sndSocket !== ws) return;
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
      if (sndSocket !== ws) return;
      const data = new Uint8Array(event.data as ArrayBuffer);
      if (data.length < 3) return;
      const tag = String.fromCharCode(data[0], data[1], data[2]);
      if (tag === 'MSG') {
        const kv = parseKeyValues(new TextDecoder().decode(data.subarray(4)));
        // badp is a rejection-reason code, not a boolean -- confirmed live
        // against a real public receiver sending badp=5 (a multi-receiver
        // "farm" host, likely rejecting on some non-password-related
        // ground, e.g. too many connections already from this IP across
        // its other receivers). Checking only for the literal "1" the
        // community reference client (kiwiclient) treats as "bad password"
        // let every OTHER nonzero code slip through unnoticed. Any nonzero
        // value here means the channel was refused, whatever the reason.
        if (kv.badp && kv.badp !== '0') {
          const message = 'KiwiSDR rejected the connection (bad password, all free channels busy, or another access restriction)';
          // Confirmed live: on this same "farm" host, badp arrives AFTER
          // sample_rate, not before -- so by the time it shows up, finish()
          // has already resolved this promise as ok:true (registerAudioListener
          // already told its caller "connected", nothing is still awaiting
          // this one). finish() below is then a harmless no-op, and without
          // the loss-listener push, the rejection would vanish silently:
          // the client's WebSocket just sits open forever with no audio and
          // no error, since nothing else was watching for a *later* failure
          // on an already-"successful" connection. This was the actual
          // cause of "picking a public receiver shows spectrum/waterfall
          // but never produces audio" on affected hosts.
          if (status.sndConnected) for (const cb of audioLossListeners) cb(message);
          finish({ ok: false, error: message });
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
          const [lowCut, highCut] = currentCuts();
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
          ws.send(agcCommand());
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
      if (sndSocket !== ws) return;
      finish({ ok: false, error: 'Could not connect to the KiwiSDR' });
    };

    ws.onclose = () => {
      if (sndSocket !== ws) return;
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

    // See connectSnd()'s matching comment -- same stale-connection race:
    // a switch can close this socket and start a fresh one to the new host
    // while this handshake is still in flight, so every handler here bails
    // out first if wfSocket no longer points at this ws.
    const timeoutTimer = setTimeout(() => {
      if (wfSocket !== ws) return;
      finish({ ok: false, error: 'Timed out connecting to the KiwiSDR waterfall' });
      ws.close();
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      // Unlike SND, waterfall frames start flowing right after these
      // (confirmed live) -- no need to wait for a sample_rate-style ack
      // first.
      ws.send('SET auth t=kiwi p=');
      ws.send(`SET zoom=${currentWfZoom} cf=${currentFreqKhz.toFixed(3)}`);
      ws.send('SET maxdb=-10 mindb=-110');
      ws.send('SET wf_speed=4');
      ws.send('SET wf_comp=0');
      wfKeepalive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('SET keepalive');
      }, KEEPALIVE_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      if (wfSocket !== ws) return;
      const data = new Uint8Array(event.data as ArrayBuffer);
      if (data.length < 3) return;
      const tag = String.fromCharCode(data[0], data[1], data[2]);
      if (tag === 'MSG') {
        const kv = parseKeyValues(new TextDecoder().decode(data.subarray(4)));
        // See connectSnd()'s matching comment -- badp is a rejection-reason
        // code, not strictly "1" for bad password, and can arrive after
        // this connection already reported success (in which case finish()
        // below is a no-op and wfLossListeners is what actually informs
        // the caller).
        if (kv.badp && kv.badp !== '0') {
          const message = 'KiwiSDR rejected the waterfall connection (bad password, all free channels busy, or another access restriction)';
          if (status.wfConnected) for (const cb of wfLossListeners) cb(message);
          finish({ ok: false, error: message });
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
      if (wfSocket !== ws) return;
      finish({ ok: false, error: 'Could not connect to the KiwiSDR waterfall' });
    };

    ws.onclose = () => {
      if (wfSocket !== ws) return;
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

/**
 * First listener triggers the actual upstream connection; every listener
 * after that shares it. `onLost`, if given, fires if the connection this
 * call reported as successful later turns out to have been rejected or
 * dropped -- some real KiwiSDR hosts send their accept/reject verdict
 * (the badp field) AFTER the sample_rate MSG that this function already
 * treats as "connected", so a rejection can arrive after the ok:true
 * result has already gone out. Without a way to report that after the
 * fact, the caller would just believe it's connected forever and never
 * see any audio.
 */
export async function registerAudioListener(listener: AudioListener, onLost?: LossListener): Promise<ConnectResult> {
  if (!getKiwiSdrEnabled()) return { ok: false, error: 'KiwiSDR is currently disabled' };
  audioListeners.add(listener);
  if (onLost) audioLossListeners.add(onLost);
  const result = await connectSnd();
  if (!result.ok) {
    audioListeners.delete(listener);
    if (onLost) audioLossListeners.delete(onLost);
  }
  return result;
}

export function unregisterAudioListener(listener: AudioListener, onLost?: LossListener) {
  audioListeners.delete(listener);
  if (onLost) audioLossListeners.delete(onLost);
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

/** See registerAudioListener's comment -- same "badp can arrive after this already reported success" case applies to the waterfall channel on the same hosts. */
export async function registerWaterfallListener(listener: WaterfallListener, onLost?: LossListener): Promise<ConnectResult> {
  if (!getKiwiSdrEnabled()) return { ok: false, error: 'KiwiSDR is currently disabled' };
  wfListeners.add(listener);
  if (onLost) wfLossListeners.add(onLost);
  const result = await connectWf();
  if (!result.ok) {
    wfListeners.delete(listener);
    if (onLost) wfLossListeners.delete(onLost);
  }
  return result;
}

export function unregisterWaterfallListener(listener: WaterfallListener, onLost?: LossListener) {
  wfListeners.delete(listener);
  if (onLost) wfLossListeners.delete(onLost);
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
