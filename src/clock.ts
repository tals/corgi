import { testBuild } from "./build_assets";
/** How soon a press must follow the last one to extend a click series. */
export const double_click_ms = 300;
let offset_ms = 0;
export function milliTimestamp(): number {
  return Date.now() + offset_ms;
}
export function microTimestamp(): number {
  return milliTimestamp() * 1000;
}
export function advance(ms: number): void {
  if (testBuild) offset_ms += ms;
}
export function reset(): void {
  offset_ms = 0;
}
