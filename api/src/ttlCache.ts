// Tiny in-memory TTL memoizer for expensive/upstream-hitting handlers --
// same pattern dxNeeded.ts's workedEntitiesByCallsign() already used for its
// own cache, generalized so awards.ts/conditions.ts/pota.ts/solar.ts/
// stats.ts can all reuse it instead of each hand-rolling the same
// `{value, at}` + `Date.now() - at < ttlMs` check. Per-process, per-key --
// resets on a restart, which is fine for data this short-lived anyway.
const stores = new Map<string, { value: unknown; at: number }>();

/** Wraps an async fetcher so repeated calls within `ttlMs` return the cached value instead of re-running it. `key` scopes the cache entry -- reuse the same key for calls that should share a cache slot. */
export function ttlCached<T>(key: string, ttlMs: number, fn: () => Promise<T>): () => Promise<T> {
  return async () => {
    const cached = stores.get(key);
    if (cached && Date.now() - cached.at < ttlMs) return cached.value as T;
    const value = await fn();
    stores.set(key, { value, at: Date.now() });
    return value;
  };
}

/** Drops every cached entry whose key starts with `keyPrefix` -- called after a QSO import so a just-completed sync shows up immediately rather than waiting out whatever TTL the stale entry was cached under. */
export function invalidateCache(keyPrefix: string) {
  for (const key of stores.keys()) {
    if (key.startsWith(keyPrefix)) stores.delete(key);
  }
}
