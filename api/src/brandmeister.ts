import { io, type Socket } from 'socket.io-client';
import { getBrandmeisterTalkgroups } from './serviceCredentials';
import { ttlCached } from './ttlCache';

export type LastHeardEntry = {
  callsign: string;
  name: string;
  talkgroupId: number;
  talkgroupName: string;
  startTime: number;
  durationSec: number;
};

// BrandMeister's real-time last-heard feed is a public, unauthenticated
// Socket.IO stream -- NOT a simple REST endpoint, unlike everything else
// this site integrates with. It's a firehose of every call on the entire
// BrandMeister network, so this filters to just the admin-configured
// talkgroup(s) and keeps a small rolling buffer in memory (not the DB --
// this is transient live-status data, same category as flexRadio.ts's
// in-memory session tracking).
//
// Requires an explicit `join` emit after connecting or the server never
// pushes a single event (confirmed live 2026-08-11 -- a naive connect+listen
// with no join, matching a since-found-incomplete community bridge script,
// received zero events over 20+ seconds; adding `socket.emit('join',
// 'everything')` per the official wiki example fixed it immediately, 11
// events in the next 15s). Joins the whole firehose rather than a
// per-talkgroup `dst_<id>` room since the watched-talkgroup list can change
// at runtime from Admin with no documented "leave a room" call to go with
// it -- client-side filtering below handles that instead, at the cost of
// receiving (and cheaply discarding) global traffic.
const MAX_BUFFER = 30;
const buffer: LastHeardEntry[] = [];
const talkgroupNameCache = new Map<number, string>();

let socket: Socket | null = null;

async function talkgroupName(id: number): Promise<string> {
  const cached = talkgroupNameCache.get(id);
  if (cached) return cached;
  try {
    const res = await fetch(`https://api.brandmeister.network/v2/talkgroup/${id}`, { signal: AbortSignal.timeout(5000) });
    const data = (await res.json()) as { Name?: string };
    const name = data.Name || String(id);
    talkgroupNameCache.set(id, name);
    return name;
  } catch {
    return String(id);
  }
}

export function getLastHeard(): LastHeardEntry[] {
  return buffer;
}

export function startBrandmeisterListener() {
  if (socket) return;
  socket = io('https://api.brandmeister.network', {
    path: '/lh/socket.io',
    transports: ['websocket'],
  });

  // Re-emitted on every (re)connect, including auto-reconnects after a drop
  // -- the join is per-connection, not persistent server-side state.
  socket.on('connect', () => {
    console.log('BrandMeister last-heard: connected, joining firehose.');
    socket?.emit('join', 'everything');
  });
  socket.on('disconnect', () => console.log('BrandMeister last-heard: disconnected, will auto-reconnect.'));

  // Every call on the network comes through here -- only Session-Stop events
  // (a completed transmission) for a currently-watched talkgroup are kept,
  // same "only finished transmissions" filtering the reference bridge script
  // uses. An empty configured-talkgroups list just means everything gets
  // discarded below rather than the connection being torn down/rebuilt, so
  // turning the feature on in Admin doesn't need a service restart.
  socket.on('mqtt', async (data: { payload: string }) => {
    // BrandMeister's global firehose delivers several events/second forever
    // -- this used to call getBrandmeisterTalkgroups() (a DB query) on every
    // single one of them, before even checking the event type. The
    // talkgroup list only changes when an admin edits it in Admin, so a
    // short cache eliminates that constant background DB traffic entirely.
    const watched = await ttlCached('brandmeister:talkgroups', 60_000, async () => getBrandmeisterTalkgroups())();
    if (!watched.length) return;
    let call: { DestinationID: number; SourceCall: string; SourceName: string; Start: number; Stop: number; Event: string };
    try {
      call = JSON.parse(data.payload);
    } catch {
      return;
    }
    if (call.Event !== 'Session-Stop' || !call.SourceCall || call.Stop <= 0) return;
    if (!watched.includes(call.DestinationID)) return;

    buffer.unshift({
      callsign: call.SourceCall,
      name: call.SourceName || '',
      talkgroupId: call.DestinationID,
      talkgroupName: await talkgroupName(call.DestinationID),
      startTime: call.Start,
      durationSec: Math.max(0, call.Stop - call.Start),
    });
    buffer.length = Math.min(buffer.length, MAX_BUFFER);
  });
}
