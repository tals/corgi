//! Microphone level and the voice threshold. The threshold is a 0..100 scale,
//! logarithmic over frame RMS 0.001 to 0.5, so each step feels even in quiet
//! and loud rooms.

const floor = Math.log(0.001),
  span = Math.log(500);
/** About RMS 0.015, -36.5 dBFS. */
export const default_threshold = 44;

/** A frame's RMS, full scale 1. */
export function rms(frame: Int16Array): number {
  if (!frame.length) return 0;
  let sum = 0;
  for (const sample of frame) sum += sample * sample;
  return Math.sqrt(sum / frame.length) / 32768;
}
export function percentToRms(pct: number): number {
  return Math.exp(floor + (pct / 100) * span);
}
/** A level on the threshold scale, clamped to 0..100. */
export function rmsToPercent(rms: number): number {
  if (rms <= 0) return 0;
  return clamp(((Math.log(rms) - floor) / span) * 100);
}
/** The threshold one key press or wheel notch away. */
export function step(threshold: number, dir: 1 | -1): number {
  return clamp(threshold + 2 * dir);
}
function clamp(pct: number): number {
  return Math.min(100, Math.max(0, pct));
}
