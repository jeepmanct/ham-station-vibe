// Live status client for a FlexRadio 6000-series transceiver on the local
// network (verified against a real Flex 6400, firmware V1.4.0.0). Unlike
// every other integration in this project, the radio doesn't answer one-shot
// HTTP requests -- it's a persistent TCP session (port 4992) that pushes
// plain-text status lines, plus a separate live meter stream (SWR, power,
// PA temperature, voltage) sent as binary VITA-49 packets over UDP once the
// TCP session asks for it. So this runs as a background connection inside
// the long-running API process rather than a periodic sync script.
//
// The connection is opt-in, not always-on: toggled from /radio (persisted in
// radio_monitoring, defaulting to off) rather than held open for the whole
// process lifetime, since the point is checking in on demand, not constant
// capture.
//
// The initial connection only ever sends read-only/subscribe commands
// (client udpport, sub slice all, sub meter all, meter list). The one
// exception is sendSliceControl() below -- an admin-gated, receive-only
// remote-tuning control (see routes/radio.ts) that can change frequency/
// mode/antenna but is architecturally incapable of transmitting: it never
// sends tx=1 or `atu start` (which FlexRadio's own docs describe as
// initiating an actual transmit tune cycle), and it hard-enforces "ANT2,
// tuner bypassed" on every call rather than trusting that state persists.
import net from 'node:net';
import dgram from 'node:dgram';
import { OpusDecoder } from 'opus-decoder';
import { db } from './db';
import { getFlexRadioIp } from './serviceCredentials';

const TCP_PORT = 4992;
const RECONNECT_DELAY_MS = 10_000;

export type SliceStatus = {
  index: number;
  frequencyMhz: number | null;
  mode: string | null;
  txActive: boolean;
  active: boolean;
  clientHandle: string | null;
  signalDbm: number | null;
};

export type FlexRadioStatus = {
  configured: boolean;
  monitoringEnabled: boolean;
  controlVisible: boolean;
  hardwareVisible: boolean;
  connected: boolean;
  lastUpdate: string | null;
  slices: SliceStatus[];
  controlSliceIndex: number | null;
  txActive: boolean;
  swr: number | null;
  fwdPowerDbm: number | null;
  refPowerDbm: number | null;
  paTempC: number | null;
  voltage: number | null;
  fanRpm: number | null;
  signalDbm: number | null;
  currentSessionStartedAt: string | null;
};

const status: FlexRadioStatus = {
  configured: !!getFlexRadioIp(),
  monitoringEnabled: false,
  controlVisible: false,
  hardwareVisible: true,
  connected: false,
  lastUpdate: null,
  slices: [],
  controlSliceIndex: null,
  txActive: false,
  swr: null,
  fwdPowerDbm: null,
  refPowerDbm: null,
  paTempC: null,
  voltage: null,
  fanRpm: null,
  signalDbm: null,
  currentSessionStartedAt: null,
};

export function getFlexRadioStatus(): FlexRadioStatus {
  // Recomputed on every call, not just at module init -- an admin saving a
  // new IP (or clearing one) via Service Credentials should be reflected
  // immediately, not just after the next process restart.
  status.configured = !!getFlexRadioIp();
  return status;
}

export function getRecentRadioSessions(limit = 20) {
  return db
    .query('SELECT started_at as startedAt, ended_at as endedAt, frequency_mhz as frequencyMhz, mode FROM radio_sessions ORDER BY started_at DESC LIMIT ?')
    .all(limit);
}

export type DiscoveredRadio = { ip: string; model: string | null; serial: string | null; callsign: string | null; nickname: string | null };

// Every FlexRadio on the 6000-series broadcasts a UDP discovery beacon on
// port 4992 roughly once per second, whether or not anyone's connected to
// it -- confirmed live against a real FLEX-6400, not from docs (couldn't
// find this documented anywhere public). Same 28-byte VITA-49 header as
// every other packet type on this radio (meters, audio), but with its own
// packet_class (0xffff, distinct from meters' 0x8002 and audio's 0x8003),
// followed by a plain ASCII space-separated key=value payload --
// `discovery_protocol_version=3.1.0.2 model=FLEX-6400 serial=... ip=...
// port=4992 status=Available ...` -- `ip=` is the one field this actually
// needs. Binding a temporary listener to 4992 alongside this module's own
// already-open connection (a completely separate ephemeral-port UDP
// socket for meter/audio data) was verified live to work without any
// conflict, since UDP broadcast delivery isn't exclusive the way a TCP
// port bind would be.
const DISCOVERY_PACKET_CLASS = 0xffff;

export function discoverFlexRadios(timeoutMs = 3000): Promise<DiscoveredRadio[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredRadio>();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const finish = () => {
      clearTimeout(timer);
      sock.close();
      resolve([...found.values()]);
    };
    sock.on('message', (data) => {
      if (data.length <= 28 || data.readUInt16BE(14) !== DISCOVERY_PACKET_CLASS) return;
      const kv: Record<string, string> = {};
      for (const m of data.subarray(28).toString('latin1').matchAll(/(\S+?)=(\S*)/g)) kv[m[1]] = m[2];
      if (!kv.ip) return;
      found.set(kv.ip, { ip: kv.ip, model: kv.model || null, serial: kv.serial || null, callsign: kv.callsign || null, nickname: kv.nickname || null });
    });
    sock.on('error', finish);
    sock.bind(TCP_PORT, () => {
      try {
        sock.setBroadcast(true);
      } catch {
        // Not fatal -- broadcast reception doesn't actually require this on
        // every platform, only sending does.
      }
    });
    const timer = setTimeout(finish, timeoutMs);
  });
}

// Command sequence numbers for anything sent after the initial connect
// handshake (which uses its own fixed C1-C4) -- starts well clear of that
// range so there's no risk of a duplicate seq number confusing response
// matching.
let controlSeq = 100;

// Resolvers for commands that need their actual response parsed (currently
// just `slice create`, to learn the new slice's assigned index) -- every
// other control command is fire-and-forget, same as the rest of this file.
// Response format confirmed from FlexRadio's own docs:
// `R<seq>|<status>|<rest...>`.
const pendingResponses = new Map<number, (parts: string[]) => void>();

function sendRadioCommand(cmd: string): number {
  if (!tcpSocket) throw new Error('Not connected to the radio');
  const seq = ++controlSeq;
  tcpSocket.write(`C${seq}|${cmd}\n`);
  return seq;
}

function sendRadioCommandAwaitingResponse(cmd: string, timeoutMs = 5000): Promise<string[]> {
  if (!tcpSocket) return Promise.reject(new Error('Not connected to the radio'));
  const seq = ++controlSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingResponses.delete(seq);
      reject(new Error('Radio did not respond in time'));
    }, timeoutMs);
    pendingResponses.set(seq, (parts) => {
      clearTimeout(timer);
      resolve(parts);
    });
    tcpSocket!.write(`C${seq}|${cmd}\n`);
  });
}

// Confirmed live against real ADIF status broadcasts (mode_list on the
// active slice) rather than assumed -- FM/NFM/DFM/SAM are real options this
// radio reports but aren't the usual ham-band suspects, included anyway
// since the radio itself lists them as valid.
const VALID_SLICE_MODES = new Set(['LSB', 'USB', 'AM', 'CW', 'DIGL', 'DIGU', 'SAM', 'FM', 'NFM', 'DFM', 'RTTY']);
// Flex 6000-series general-coverage receive range.
const MIN_FREQ_MHZ = 0.03;
const MAX_FREQ_MHZ = 77;

// The remote-control feature gets its OWN slice, never "whichever slice is
// active" -- discovered live why this matters: while testing this feature,
// the radio's only slice was mid-transmission on a real, in-progress QSO.
// Retuning that slice out from under a live contact (or even just fighting
// the user's own SmartSDR app for control of it while only listening) would
// be a real problem this design avoids entirely.
//
// Originally this created that slice explicitly (`slice create`). Revised
// after discovering, while adding audio support, that `remote_audio_rx`
// requires the connection to declare itself a `client gui` first (a plain
// API/status client gets "Invalid command for this client type") -- and
// declaring `client gui` makes the radio *automatically* create its own
// default slice, whether asked to or not. A Flex 6400 only supports 2
// slices total; the real operating session already uses one, so an
// explicitly-created slice on top of the GUI-client's auto-created one
// would exceed that limit (confirmed live: the explicit `slice create`
// failed with a license-check error once a GUI client was already
// connected). So this now leans into the auto-created slice instead of
// fighting it -- one shared slice for both tuning and audio, not two.
let guiClientDeclared = false;
const DEFAULT_CONTROL_FREQ_MHZ = 14.1;
const DEFAULT_CONTROL_MODE = 'USB';

async function declareGuiClientIfNeeded() {
  if (guiClientDeclared) return;
  const parts = await sendRadioCommandAwaitingResponse('client gui');
  if (parts[0] !== '0') throw new Error(`Radio refused GUI client declaration (status ${parts[0]})`);
  guiClientDeclared = true;
}

/**
 * Removes the current control slice (if any exists on the radio yet, our
 * own or the GUI-client-auto-created one) and creates a fresh one at the
 * given frequency/mode -- returns its index. This dance, not a follow-up
 * `slice t`/`slice s mode=` on an existing slice, is the part that actually
 * works: confirmed live, repeatedly, that plain `slice t` on a
 * `client gui`-auto-created slice returns a success response but the
 * frequency never actually changes (even waited several seconds, even
 * after explicitly setting the slice active=1 first) -- while removing it
 * and creating a fresh one with `freq=`/`mode=` baked directly into the
 * `slice create` command reliably takes hold immediately. Not fully
 * understood why the follow-up command silently no-ops; verified thoroughly
 * enough (multiple isolated single-connection tests) to trust the
 * workaround rather than the "obvious" API.
 */
async function recreateControlSlice(freqMhz: number, mode: string): Promise<number> {
  if (!tcpSocket || !status.connected) throw new Error('Not connected to the radio -- turn monitoring on first');
  if (!myClientHandle) throw new Error('Radio connection not fully established yet -- try again in a moment');
  await declareGuiClientIfNeeded();

  // A running audio stream does NOT get torn down automatically when its
  // underlying slice is removed -- confirmed live the hard way: retuning
  // while listening left the old (now-orphaned) stream still emitting
  // stale audio, and the follow-up `stream create` for the new slice was
  // then refused outright (status 5000008E), presumably because a stream
  // was still considered active for this client. Remove it explicitly
  // before touching the slice at all.
  if (audioStreamId) {
    sendRadioCommand(`stream remove ${audioStreamId}`);
    audioStreamId = null;
  }

  const existing = status.slices.find((s) => s.clientHandle === myClientHandle);
  if (existing) {
    sendRadioCommand(`slice r ${existing.index}`);
    await new Promise((resolve) => setTimeout(resolve, 400));
  } else {
    // First time this connection has ever needed a slice: `client gui`
    // itself auto-creates a default one, which hasn't shown up in a status
    // broadcast yet the very first time this runs. Wait for it so it can be
    // removed just like an existing one, rather than ending up with two.
    const autoCreated = await new Promise<SliceStatus>((resolve, reject) => {
      const start = Date.now();
      const poll = setInterval(() => {
        const found = status.slices.find((s) => s.clientHandle === myClientHandle);
        if (found) {
          clearInterval(poll);
          resolve(found);
        } else if (Date.now() - start > 5000) {
          clearInterval(poll);
          reject(new Error('Radio did not create a slice for this client in time'));
        }
      }, 100);
    });
    sendRadioCommand(`slice r ${autoCreated.index}`);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  const parts = await sendRadioCommandAwaitingResponse(`slice create ant=ANT2 mode=${mode} freq=${freqMhz}`);
  if (parts[0] !== '0') {
    throw new Error(`Radio refused to create a slice (status ${parts[0]}) -- it may already have the maximum number of slices open`);
  }
  const index = Number(parts[1]);
  if (!Number.isInteger(index)) throw new Error('Radio did not report a slice index');
  status.controlSliceIndex = index;

  sendRadioCommand(`slice s ${index} rxant=ANT2 txant=ANT2`);
  sendRadioCommand('atu bypass');
  // The (re)created slice gets its own fresh meter IDs (including its own
  // "LEVEL" S-meter) not present in the meter list fetched at initial
  // connect or after any prior recreation -- re-fetch so handleMeterPacket
  // can resolve them.
  sendRadioCommand('meter list');

  // A running audio stream doesn't survive its underlying slice being torn
  // down -- restart it against the new one so listening doesn't silently
  // go dead the next time someone changes frequency.
  if (audioListeners.size > 0) await startAudioStream();

  return index;
}

async function ensureControlSlice(): Promise<number> {
  if (status.controlSliceIndex !== null && status.slices.some((s) => s.index === status.controlSliceIndex)) {
    return status.controlSliceIndex;
  }
  return recreateControlSlice(DEFAULT_CONTROL_FREQ_MHZ, DEFAULT_CONTROL_MODE);
}

/**
 * Receive-only remote tuning: change frequency and/or mode on this
 * feature's own dedicated slice, created (or recreated, if one already
 * exists) via recreateControlSlice() -- see that function's comment for why
 * a straightforward "tune the existing slice" doesn't actually work here.
 * Every call re-asserts ANT2 + tuner bypass regardless of whether
 * frequency/mode actually changed -- "always antenna two, tuner off" is a
 * standing invariant of using this control, not a one-time default.
 */
export async function sendSliceControl(opts: { frequencyMhz?: number; mode?: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!tcpSocket || !status.connected) return { ok: false, error: 'Not connected to the radio -- turn monitoring on first' };

  if (opts.mode !== undefined && !VALID_SLICE_MODES.has(opts.mode)) {
    return { ok: false, error: `Invalid mode: ${opts.mode}` };
  }
  if (opts.frequencyMhz !== undefined && (!Number.isFinite(opts.frequencyMhz) || opts.frequencyMhz < MIN_FREQ_MHZ || opts.frequencyMhz > MAX_FREQ_MHZ)) {
    return { ok: false, error: `Frequency must be between ${MIN_FREQ_MHZ} and ${MAX_FREQ_MHZ} MHz` };
  }

  const current = status.controlSliceIndex !== null ? status.slices.find((s) => s.index === status.controlSliceIndex) : undefined;
  const freqMhz = opts.frequencyMhz ?? current?.frequencyMhz ?? DEFAULT_CONTROL_FREQ_MHZ;
  const mode = opts.mode ?? current?.mode ?? DEFAULT_CONTROL_MODE;

  try {
    await recreateControlSlice(freqMhz, mode);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Command failed' };
  }
  return { ok: true };
}

// --- Receive audio (Opus over the control slice) ---
//
// Endpoint/format confirmed live, not from FlexRadio's sparse docs: request
// with `stream create type=remote_audio_rx compression=opus` (needs the
// `client gui` declaration above first, same "Invalid command for this
// client type" error otherwise). Packets carry the same 28-byte VITA-49
// header as meters (packet_class 0x8003 instead of meters' 0x8002), then a
// fixed 10-byte FlexRadio sub-header, then a 2-byte per-packet sequence
// number, THEN the actual Opus frame -- found by capturing real packets and
// searching for which byte position increments by exactly 1 across
// consecutive packets (byte 38 of the full packet), not by trusting any
// single packet's structure alone. Decoded server-side (via the `opus-
// decoder` WASM package, verified against real captured audio -- decoded
// energy varies packet-to-packet in exactly the pattern real receiver noise
// would, not the near-identical "succeeds either way" result a wrong byte
// offset gave during testing) rather than relayed raw to the browser, so
// playback only needs the universally-supported Web Audio API, not
// WebCodecs.
const AUDIO_SUBHEADER_AND_SEQ_LEN = 12;
type AudioListener = (pcm: Int16Array) => void;
const audioListeners = new Set<AudioListener>();
let opusDecoder: OpusDecoder | null = null;
let audioStreamId: string | null = null;

function interleaveToInt16(channelData: Float32Array[]): Int16Array {
  const channels = channelData.length;
  const frames = channelData[0]?.length ?? 0;
  const out = new Int16Array(frames * channels);
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < channels; ch++) {
      const sample = Math.max(-1, Math.min(1, channelData[ch][i]));
      out[i * channels + ch] = Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff);
    }
  }
  return out;
}

// The radio doesn't scope UDP audio delivery to the TCP connection that
// requested it -- confirmed live, the hard way: it just keeps sending every
// still-active remote_audio_rx stream's packets to whatever UDP port was
// most recently registered via `client udpport`, including stale streams
// left over from an entirely different, already-ended session (even a full
// `client disconnect` and a radio power cycle didn't stop this in testing --
// it reappeared with a *fresh* stream ID each time, so it isn't simply
// "orphaned state" either). Feeding two interleaved streams' frames into one
// Opus decoder instance produces exactly the clicking/popping this was built
// to avoid. Rather than chase the exact mechanism further, this locks onto
// whichever stream is actually continuing sequentially (via the per-packet
// seq at payload byte 10-11, see this section's header comment) and drops
// anything that doesn't fit that continuation -- protocol-agnostic to *why*
// a second stream's packets show up, since the fix is the same either way.
let expectedAudioSeq: number | null = null;
let audioSeqMismatchStreak = 0;
// If the real stream itself hiccups/restarts, its packets would also stop
// matching -- give up waiting after this many consecutive mismatches (a few
// hundred ms) and resync to whatever's currently arriving, rather than
// silently discarding audio forever.
const AUDIO_RESYNC_AFTER_MISMATCHES = 15;

function handleAudioPacket(payload: Buffer) {
  if (audioListeners.size === 0 || !opusDecoder) return;
  if (payload.length <= AUDIO_SUBHEADER_AND_SEQ_LEN) return;
  const seq = payload.readUInt16BE(10);
  if (expectedAudioSeq !== null && seq !== expectedAudioSeq) {
    audioSeqMismatchStreak++;
    if (audioSeqMismatchStreak < AUDIO_RESYNC_AFTER_MISMATCHES) return;
  }
  audioSeqMismatchStreak = 0;
  expectedAudioSeq = (seq + 1) & 0xffff;
  const opusFrame = payload.subarray(AUDIO_SUBHEADER_AND_SEQ_LEN);
  try {
    const result = opusDecoder.decodeFrame(opusFrame);
    if (result.errors?.length) return;
    const pcm = interleaveToInt16(result.channelData);
    for (const listener of audioListeners) listener(pcm);
  } catch {
    // One bad frame shouldn't take down the whole stream.
  }
}

/** (Re)starts the radio-side audio stream against whatever the current control slice is -- shared by registerAudioListener() (first listener) and recreateControlSlice() (a running stream following a retune, since it doesn't survive its slice being torn down). */
async function startAudioStream() {
  if (!opusDecoder) {
    opusDecoder = new OpusDecoder({ channels: 2, sampleRate: 24000 });
    await opusDecoder.ready;
  }
  const parts = await sendRadioCommandAwaitingResponse('stream create type=remote_audio_rx compression=opus');
  if (parts[0] !== '0') throw new Error(`Radio refused to start the audio stream (status ${parts[0]})`);
  // The create response's stream ID comes back bare hex (e.g. "400000A"),
  // but the corresponding status broadcast and the docs' own `stream
  // remove` example both show it zero-padded with a 0x prefix
  // ("0x0400000A") -- confirmed live these are the same ID, just formatted
  // differently between the two messages.
  audioStreamId = `0x${parts[1].padStart(8, '0')}`;
  // Fresh stream -- forget whatever sequence we were locked onto before, so
  // handleAudioPacket() re-locks onto this new stream's own numbering
  // immediately instead of spending a moment rejecting its packets.
  expectedAudioSeq = null;
  audioSeqMismatchStreak = 0;
}

/**
 * Registers a callback that receives interleaved Int16 PCM (2ch, 24kHz) as
 * it's decoded. The first listener registering triggers the actual
 * radio-side audio stream (and the shared control slice, if not already
 * up); the last one unregistering tears both back down, so audio is only
 * ever flowing when someone's actually listening. Never anything but a
 * receive stream -- see sendSliceControl()'s and this file's header
 * comments for the broader receive-only guarantee this is part of.
 */
export async function registerAudioListener(listener: AudioListener): Promise<{ ok: true } | { ok: false; error: string }> {
  audioListeners.add(listener);
  if (audioListeners.size > 1) return { ok: true }; // stream already running for an earlier listener
  try {
    // ensureControlSlice() may itself have to (re)create the slice via
    // recreateControlSlice(), which -- seeing this listener already added
    // above -- starts the audio stream as part of that same call. Only
    // start it here if that didn't already happen, otherwise this becomes a
    // second `stream create` against an already-active stream, which the
    // radio refuses (status 5000008E) -- confirmed live: this double-call
    // was the actual cause of that error, not orphaned state from earlier
    // testing as first suspected.
    await ensureControlSlice();
    if (!audioStreamId) await startAudioStream();
  } catch (err) {
    audioListeners.delete(listener);
    return { ok: false, error: err instanceof Error ? err.message : 'Could not start audio stream' };
  }
  return { ok: true };
}

export function unregisterAudioListener(listener: AudioListener) {
  audioListeners.delete(listener);
  if (audioListeners.size > 0) return;
  if (audioStreamId && tcpSocket) {
    try {
      sendRadioCommand(`stream remove ${audioStreamId}`);
    } catch {
      // Connection's likely already going down along with it.
    }
  }
  audioStreamId = null;
  opusDecoder?.free();
  opusDecoder = null;
  expectedAudioSeq = null;
  audioSeqMismatchStreak = 0;
}

/** Called on disconnect/monitoring-off -- clears audio state without trying to send a stream remove over a socket that's going away anyway. */
function stopAudioStreamOnDisconnect() {
  audioStreamId = null;
  opusDecoder?.free();
  opusDecoder = null;
  audioListeners.clear();
  expectedAudioSeq = null;
  audioSeqMismatchStreak = 0;
}

/** Releases this feature's dedicated slice, if one is open -- called when monitoring is turned off so the slot doesn't sit reserved. */
function releaseControlSlice() {
  // No explicit `slice r` anymore -- this slice is a side effect of
  // declaring `client gui`, not something created directly, and the whole
  // TCP connection is torn down right after this is called (see
  // setMonitoring/onDown) anyway. A GUI client's own slice/panadapter/
  // waterfall/audio stream all go away on the radio side once that client
  // disconnects, same as closing the real SmartSDR app would.
  stopAudioStreamOnDisconnect();
  status.controlSliceIndex = null;
  guiClientDeclared = false;
  myClientHandle = null;
}

// Per-meter fixed-point scale factor (real value = raw / scale). The docs
// describe this generically by unit type ("dBm: 7 fractional bits", "Volts:
// 10 fractional bits"), but that didn't hold exactly for every meter on this
// specific radio/firmware -- these were determined empirically by checking
// against known-good reference values (SWR must read 1.00 at idle; the PA
// voltage meter is literally named "+13.8A" so it should read ~13.8; PA temp
// must land in a physically plausible idle range) rather than trusted from
// the docs alone.
const METER_SCALE: Record<string, number> = {
  SWR: 128,
  FWDPWR: 128,
  REFPWR: 128,
  PATEMP: 64,
  '+13.8A': 256,
  '+13.8B': 256,
  MAINFAN: 1,
  // Signal strength: tried the "AGC+" meter first (post-AGC level) since it
  // sounds like the obvious S-meter candidate, but live testing showed its
  // whole point is normalizing the level regardless of actual signal
  // strength -- readings barely moved. "LEVEL" ("signal strength of signals
  // in the filter passband", i.e. pre-AGC) tracked real conditions properly
  // and its /128 scale landed in a physically sane HF noise-floor range
  // (~-87 to -103 dBm), so that's the one used here.
  LEVEL: 128,
};

// Meter list entries carry a `src`/`num` pair identifying which slice (or
// non-slice source, e.g. "TX-"/"RAD"/"COD-") a given meter ID belongs to --
// discovered live that the existing name-only lookup would be ambiguous
// once a second slice exists, since each slice gets its own same-named
// "LEVEL" meter at a different ID. sliceNum is null for non-slice sources.
const meterInfo = new Map<number, { name: string; sliceNum: number | null }>();
let udpSocket: dgram.Socket | null = null;
let tcpSocket: net.Socket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
// This connection's own client handle (e.g. "0x3EA5957A"), captured from the
// very first line of every session -- needed to identify which slice
// belongs to *this* client once `client gui` auto-creates one, since other
// clients' slices show up in the same status broadcasts.
let myClientHandle: string | null = null;

function getMonitoringEnabledFromDb(): boolean {
  const row = db.query('SELECT enabled FROM radio_monitoring WHERE id = 1').get() as { enabled: number } | null;
  return row?.enabled === 1;
}

function setMonitoringEnabledInDb(enabled: boolean) {
  db.query(
    `INSERT INTO radio_monitoring (id, enabled) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled`,
  ).run(enabled ? 1 : 0);
}

function getControlVisibleFromDb(): boolean {
  const row = db.query('SELECT control_visible FROM radio_monitoring WHERE id = 1').get() as { control_visible: number } | null;
  return row?.control_visible === 1;
}

function setControlVisibleInDb(visible: boolean) {
  db.query(
    `INSERT INTO radio_monitoring (id, control_visible) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET control_visible = excluded.control_visible`,
  ).run(visible ? 1 : 0);
}

/** Admin-only site setting: whether the Remote Control (Receive Only) card shows up on /radio at all, independent of whether monitoring is on. */
export function setRadioControlVisible(visible: boolean) {
  status.controlVisible = visible;
  setControlVisibleInDb(visible);
}

function getHardwareVisibleFromDb(): boolean {
  const row = db.query('SELECT hardware_visible FROM radio_monitoring WHERE id = 1').get() as { hardware_visible: number } | null;
  // Defaults true (unlike control_visible's false) if no row exists yet at
  // all -- see db.ts's migration comment for why.
  return row ? row.hardware_visible === 1 : true;
}

function setHardwareVisibleInDb(visible: boolean) {
  db.query(
    `INSERT INTO radio_monitoring (id, hardware_visible) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET hardware_visible = excluded.hardware_visible`,
  ).run(visible ? 1 : 0);
}

/**
 * Admin-only site setting: whether the FlexRadio hardware-status section on
 * /radio (Monitor toggle, On the Air, meters, Recent Sessions) shows up at
 * all -- for an installer without a FlexRadio. Turning it off also turns
 * monitoring off, so there's no orphaned background connection nobody can
 * see or control anymore. PSK/WSPR/RBN reception reports are untouched --
 * see this flag's db.ts comment for why they're independent of it.
 */
export function setRadioHardwareVisible(visible: boolean) {
  status.hardwareVisible = visible;
  setHardwareVisibleInDb(visible);
  if (!visible) setMonitoring(false);
}

function recordTxStart() {
  if (status.currentSessionStartedAt) return;
  const now = new Date().toISOString();
  status.currentSessionStartedAt = now;
  const activeSlice = status.slices.find((s) => s.txActive);
  db.query('INSERT INTO radio_sessions (started_at, frequency_mhz, mode) VALUES (?, ?, ?)').run(
    now,
    activeSlice?.frequencyMhz ?? null,
    activeSlice?.mode ?? null,
  );
}

function recordTxEnd() {
  if (!status.currentSessionStartedAt) return;
  const startedAt = status.currentSessionStartedAt;
  status.currentSessionStartedAt = null;
  db.query('UPDATE radio_sessions SET ended_at = ? WHERE started_at = ? AND ended_at IS NULL').run(new Date().toISOString(), startedAt);
}

function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/(\S+?)=(\S*)/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

function handleMeterListResponse(text: string) {
  meterInfo.clear();
  // Each meter's fields (#<id>.src=... #<id>.num=... #<id>.nam=...) are
  // scattered across the response, not adjacent, so this indexes by ID
  // first rather than assuming a fixed field order.
  const byId = new Map<number, { src?: string; num?: string; nam?: string }>();
  for (const m of text.matchAll(/#?(\d+)\.(src|num|nam)=([^#]+)/g)) {
    const id = Number(m[1]);
    const entry = byId.get(id) ?? {};
    (entry as Record<string, string>)[m[2]] = m[3];
    byId.set(id, entry);
  }
  for (const [id, entry] of byId) {
    if (!entry.nam) continue;
    const sliceNum = entry.src === 'SLC' && entry.num !== undefined ? Number(entry.num) : null;
    meterInfo.set(id, { name: entry.nam, sliceNum });
  }
}

function handleSliceLine(line: string) {
  const afterPipe = line.slice(line.indexOf('|') + 1);
  const m = afterPipe.match(/^slice (\d+)\s+(.*)$/);
  if (!m) return;
  const index = Number(m[1]);
  const kv = parseKeyValues(m[2]);

  // `in_use=0` is how the radio signals a slice was removed (e.g. by
  // slice r, including this project's own dedicated control slice being
  // torn down) -- discovered live, since nothing in this line's shape
  // otherwise distinguishes "removed" from an ordinary property update.
  // Without this, a removed slice's stale entry would linger in
  // status.slices forever, which is exactly what happened during testing:
  // ensureControlSlice()'s "does my tracked slice still exist" check reads
  // this array, so a ghost entry would make it think a since-removed slice
  // was still usable.
  let slice: SliceStatus | undefined;
  if (kv.in_use === '0') {
    status.slices = status.slices.filter((s) => s.index !== index);
  } else {
    slice = status.slices.find((s) => s.index === index);
    if (!slice) {
      slice = { index, frequencyMhz: null, mode: null, txActive: false, active: false, clientHandle: null, signalDbm: null };
      status.slices.push(slice);
    }
    if (kv.RF_frequency) slice.frequencyMhz = Number(kv.RF_frequency);
    if (kv.mode) slice.mode = kv.mode;
    if (kv.in_use) slice.active = kv.in_use === '1';
    if (kv.tx) slice.txActive = kv.tx === '1';
    if (kv.client_handle) slice.clientHandle = kv.client_handle;
  }

  // Recomputed regardless of which branch above ran -- a removed slice that
  // happened to still be marked txActive must still clear status.txActive
  // and close out its session, not just disappear from the array silently.
  //
  // Excludes the remote-control feature's own slice -- discovered live,
  // disturbingly, that FlexRadio sets `tx=1` on it by default the moment
  // it's created, even though nothing ever transmits through it. That
  // field means "this slice is TX-selected/capable" (which slice would
  // handle a keydown, if one happened), not "this slice is actually
  // radiating right now" -- a distinction that never mattered before this
  // feature existed, since there was only ever one slice and for a real
  // operating session those two things are the same moment. Left
  // unexcluded, this would have silently started logging fake on-air
  // sessions to radio_sessions the instant this feature's slice was
  // created, and kept status.txActive stuck true even after the real
  // session ended, for as long as the control slice remained open.
  const wasTx = status.txActive;
  status.txActive = status.slices.some((s) => s.txActive && s.index !== status.controlSliceIndex);
  if (!wasTx && status.txActive) recordTxStart();
  else if (wasTx && !status.txActive) recordTxEnd();
  // Slice fields (frequency/mode/tx) each arrive as their own status line
  // rather than atomically, so a session's frequency/mode can still be
  // settling in the moment TX first goes true (observed live: a session
  // was recorded as "CW" for a few seconds before the real "DIGU" mode line
  // arrived). Keep updating the open session's row for as long as it's
  // running, not just once at recordTxStart(), so it reflects the latest
  // known values by the time it ends.
  else if (status.txActive && status.currentSessionStartedAt && slice?.txActive && slice.index !== status.controlSliceIndex) {
    db.query('UPDATE radio_sessions SET frequency_mhz = ?, mode = ? WHERE started_at = ? AND ended_at IS NULL').run(
      slice.frequencyMhz,
      slice.mode,
      status.currentSessionStartedAt,
    );
  }
}

function handleTcpLine(line: string) {
  if (!line) return;
  status.lastUpdate = new Date().toISOString();
  // The very first line of every connection: our own client handle for this
  // session (e.g. "H19E6D1AC"), needed to tell "my" slices apart from
  // anyone else's once client gui auto-creates one -- see
  // ensureControlSlice(). No pipe/fields, unlike every other message type.
  if (line.startsWith('H') && /^H[0-9A-Fa-f]+$/.test(line)) {
    myClientHandle = `0x${line.slice(1)}`;
  } else if (line.startsWith('R') && line.includes('meter ')) {
    handleMeterListResponse(line);
  } else if (line.startsWith('S') && line.includes('|slice ')) {
    handleSliceLine(line);
  } else if (line.startsWith('R')) {
    const m = line.match(/^R(\d+)\|(.*)$/);
    if (m) {
      const seq = Number(m[1]);
      const resolver = pendingResponses.get(seq);
      if (resolver) {
        pendingResponses.delete(seq);
        resolver(m[2].split('|'));
      }
    }
  }
}

// VITA-49 header observed at 28 bytes for every packet type on this radio
// (meters, audio, panadapter/waterfall alike -- confirmed empirically).
// Bytes 14-15 (big-endian uint16) are the "packet_class" field, which is
// what actually distinguishes them -- confirmed live by comparing a meter
// packet's header against an audio packet's byte-for-byte: 0x8002 for
// meters, 0x8003 for remote_audio_rx (Opus). Two more classes (0x8004,
// 0x8005) were seen alongside audio once `client gui` was declared --
// almost certainly panadapter/waterfall data from the auto-created display,
// not needed here, so left unhandled rather than guessed at.
const METER_PACKET_CLASS = 0x8002;
const AUDIO_PACKET_CLASS = 0x8003;

function handleMeterPacket(payload: Buffer) {
  const count = Math.floor(payload.length / 4);
  for (let i = 0; i < count; i++) {
    const meterId = payload.readUInt16BE(i * 4);
    const raw = payload.readInt16BE(i * 4 + 2);
    const info = meterInfo.get(meterId);
    if (!info || !(info.name in METER_SCALE)) continue;
    const value = raw / METER_SCALE[info.name];
    if (info.name === 'LEVEL' && info.sliceNum !== null) {
      const slice = status.slices.find((s) => s.index === info.sliceNum);
      if (slice) slice.signalDbm = value;
      // Keep the top-level reading tied specifically to slice 0 (the
      // original single-slice behavior, before this feature could ever add
      // a second slice) rather than whichever slice's meter last happened
      // to update -- otherwise this project's own remote-control slice
      // would randomly stomp on the real session's displayed S-meter.
      if (info.sliceNum === 0) status.signalDbm = value;
      continue;
    }
    switch (info.name) {
      case 'SWR': status.swr = value; break;
      case 'FWDPWR': status.fwdPowerDbm = value; break;
      case 'REFPWR': status.refPowerDbm = value; break;
      case 'PATEMP': status.paTempC = value; break;
      case '+13.8A': status.voltage = value; break;
      case 'MAINFAN': status.fanRpm = value; break;
    }
  }
}

function handleUdpPacket(data: Buffer) {
  if (data.length <= 28) return;
  const packetClass = data.readUInt16BE(14);
  const payload = data.subarray(28);
  if (packetClass === METER_PACKET_CLASS) {
    handleMeterPacket(payload);
  } else if (packetClass === AUDIO_PACKET_CLASS) {
    handleAudioPacket(payload);
  } else {
    return; // panadapter/waterfall/other -- not needed, don't touch lastUpdate for these
  }
  status.lastUpdate = new Date().toISOString();
}

function scheduleReconnect() {
  if (reconnectTimer || !status.monitoringEnabled) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (status.monitoringEnabled) connect();
  }, RECONNECT_DELAY_MS);
}

function connect() {
  const radioIp = getFlexRadioIp();
  if (!radioIp || tcpSocket) return;

  if (!udpSocket) {
    udpSocket = dgram.createSocket('udp4');
    udpSocket.on('message', handleUdpPacket);
    udpSocket.on('error', () => {});
    udpSocket.bind(0);
  }

  const socket = net.createConnection({ host: radioIp, port: TCP_PORT });
  tcpSocket = socket;
  let buffer = '';

  // Only guards the initial connection attempt -- deliberately NOT a
  // general socket idle timeout. A live radio session can go quiet for
  // long stretches whenever nothing on the radio changes, and treating
  // that as a dead connection (net.Socket's built-in `timeout` option
  // does exactly this) caused spurious reconnects every ~8s during actual
  // testing against the real radio.
  const connectTimer = setTimeout(() => socket.destroy(), 8000);
  socket.on('connect', () => {
    clearTimeout(connectTimer);
    status.connected = true;
    const localPort = udpSocket?.address().port;
    socket.write(`C1|client udpport ${localPort}\n`);
    socket.write('C2|sub slice all\n');
    socket.write('C3|sub meter all\n');
    socket.write('C4|meter list\n');
  });

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) handleTcpLine(line);
  });

  const onDown = () => {
    clearTimeout(connectTimer);
    status.connected = false;
    if (status.txActive) {
      status.txActive = false;
      status.slices.forEach((s) => (s.txActive = false));
      recordTxEnd();
    }
    // The dedicated control slice (if any) doesn't survive the radio-side
    // session ending along with this connection -- just forget it rather
    // than trying to remove it over a socket that's already gone; a fresh
    // one gets created on demand next time the control feature is used.
    // Same for the GUI-client declaration, our handle, and any audio stream.
    status.controlSliceIndex = null;
    guiClientDeclared = false;
    myClientHandle = null;
    stopAudioStreamOnDisconnect();
    tcpSocket = null;
    scheduleReconnect();
  };
  socket.on('close', onDown);
  socket.on('error', onDown);
}

function resetLiveReadings() {
  status.connected = false;
  status.slices = [];
  status.txActive = false;
  status.swr = null;
  status.fwdPowerDbm = null;
  status.refPowerDbm = null;
  status.paTempC = null;
  status.voltage = null;
  status.fanRpm = null;
  status.signalDbm = null;
}

/** Turns the background connection on or off, persisting the choice so it survives an api restart. */
export function setMonitoring(enabled: boolean) {
  if (enabled === status.monitoringEnabled) return;
  status.monitoringEnabled = enabled;
  setMonitoringEnabledInDb(enabled);

  if (enabled) {
    const radioIp = getFlexRadioIp();
    if (!radioIp) return;
    console.log(`FlexRadio: monitoring enabled, connecting to ${radioIp}:${TCP_PORT}`);
    connect();
    return;
  }

  console.log('FlexRadio: monitoring disabled.');
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (status.currentSessionStartedAt) recordTxEnd();
  releaseControlSlice();
  tcpSocket?.destroy();
  tcpSocket = null;
  udpSocket?.close();
  udpSocket = null;
  resetLiveReadings();
}

/** Called once at API boot -- reconnects only if monitoring was left on before the last restart. */
export function startFlexRadioClient() {
  const radioIp = getFlexRadioIp();
  if (!radioIp) {
    console.log('FlexRadio: no radio IP configured (Service Credentials, or the old FLEX_RADIO_IP .env var) -- skipping.');
    return;
  }
  // In-memory session tracking resets on every process restart, so a
  // session that was genuinely still open at the moment of a restart (a
  // deploy, a crash, a reboot) would otherwise sit with ended_at = NULL
  // forever -- the next TX-start after reconnecting always looks like a
  // fresh session to a cold process. Closing out any already-open row here
  // means a mid-transmission restart shows as two adjacent sessions rather
  // than one impossible never-ending one.
  db.query("UPDATE radio_sessions SET ended_at = datetime('now') WHERE ended_at IS NULL").run();

  // Independent of whether monitoring itself ends up enabled below -- these
  // are pure UI-visibility settings, not tied to the live connection.
  status.controlVisible = getControlVisibleFromDb();
  status.hardwareVisible = getHardwareVisibleFromDb();

  status.monitoringEnabled = getMonitoringEnabledFromDb();
  if (!status.monitoringEnabled) {
    console.log('FlexRadio: monitoring is off (leave it on at /radio to reconnect automatically next time).');
    return;
  }
  console.log(`FlexRadio: monitoring was left on, connecting to ${radioIp}:${TCP_PORT}`);
  connect();
}
