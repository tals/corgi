/**
 * The resource sampler's OS layer on the landing page, which samples nothing:
 * the page draws Corgi's resource card from the samples the recorder kept in
 * frames.json, and imports the tracker only for its figures' formatting.
 * package.json's "browser" field puts this in place of
 * src/trackers/resource_os.ts.
 */
import type { Counters, Host, Inventory } from "../../src/trackers/resource_os";

export function inventory(_roots?: number[]): Inventory {
  return { items: [], truncated: false, counters };
}
export function counters(_pid: number): Counters | null {
  return null;
}
export function host(): Host {
  return { busy: 0n, total: 0n, cores: 1, memory: 0n, pressure: "unknown" };
}
export function exists(_pid: number): boolean {
  return false;
}
export function nvidiaFiles(_pid: number): number[] | null {
  return null;
}
