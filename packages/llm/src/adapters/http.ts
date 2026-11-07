// Shared by the HTTP adapters. No SDK imports, so any adapter may use it.

/** Supports retry-after-ms, retry-after in seconds, and retry-after as an HTTP date. */
export function parseRetryAfterMs(headers: Headers | undefined, now: number): number | undefined {
  const rawMs = headers?.get('retry-after-ms')?.trim();
  // A blank retry-after-ms counts as absent, as a blank retry-after does; Number('') would be 0.
  const ms = rawMs ? Number(rawMs) : Number.NaN;
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const raw = headers?.get('retry-after');
  if (raw === null || raw === undefined || raw.trim() === '') return undefined;
  const seconds = Number(raw);
  // A numeric value never falls through to Date.parse, which leniently accepts strings such as "-1".
  if (!Number.isNaN(seconds)) return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/**
 * Drops trailing '/' characters in linear time. A regex such as /\/+$/ is quadratic on a long run of
 * slashes that is not at the end (CodeQL js/polynomial-redos), so base URLs are trimmed with a loop.
 */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end--;
  return value.slice(0, end);
}
