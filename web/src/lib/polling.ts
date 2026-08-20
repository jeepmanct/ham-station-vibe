/**
 * Wraps setInterval so the callback is skipped while the tab is hidden
 * (backgrounded/minimized), and fires once immediately on return to avoid
 * stale data lingering for up to a full interval. Drop-in replacement for
 * setInterval(fn, ms) -- same return value, so existing clearInterval(id)
 * call sites keep working unchanged.
 */
export function pollWhileVisible(fn: () => void, intervalMs: number): ReturnType<typeof setInterval> {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) fn();
  });
  return setInterval(() => {
    if (!document.hidden) fn();
  }, intervalMs);
}
