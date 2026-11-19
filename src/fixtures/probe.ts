import type { Probe } from "../terminal_info";

/** What passes through `probe` as input when the terminal sends `bytes` one byte at a time. */
export function fragmented(probe: Probe, bytes: string): string {
  return Buffer.concat(Array.from(Buffer.from(bytes), byte => probe.feed(Buffer.from([byte])))).toString();
}
