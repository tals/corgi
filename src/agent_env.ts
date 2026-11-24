/** Bounded public metadata; provider credentials stay in the agent process. */
export function read(entries: Iterable<readonly [string, unknown]>): Record<string, string> {
  const out: Record<string, string> = {};
  let bytes = 0,
    count = 0;
  for (const [key, value] of entries) {
    if (!key.startsWith("CORGI_") || typeof value !== "string") continue;
    const size = Buffer.byteLength(key) + Buffer.byteLength(value);
    if (size > 4096 || bytes + size > 32768 || count >= 128) continue;
    out[key] = value;
    bytes += size;
    count++;
  }
  return out;
}

/** Runtime necessities plus the public namespace; never inherit provider secrets. */
export function trick(source: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = read(Object.entries(source));
  for (const key of ["HOME", "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "TMPDIR"])
    if (source[key] !== undefined) env[key] = source[key];
  return env;
}
