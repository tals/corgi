//! The threshold gauge: replays a recording of the background through fresh
//! segmenters to find the lowest threshold at which it starts no utterance.
import * as level from "./level";
import { Segmenter, type Timing } from "./segmenter";

/** How a gauge ended; a cancelled one leaves no outcome. */
export type Outcome = "applied" | "applied_quiet_speech" | "no_speech_to_compare" | "too_loud" | "mic_failed";
/** How long a gauge listens, in seconds and in 20 ms frames. */
export const listen_seconds = 10,
  listen_frames = listen_seconds * 50;

/** Whether `frames`, replayed at threshold `pct`, start an utterance: one
 * comes out, or one with enough speech is still open at the end. */
function starts(frames: Int16Array[], timing: Timing, pct: number): boolean {
  const s = new Segmenter({ threshold: pct, timing, now: () => 0 });
  for (const f of frames) if (s.push(f).length) return true;
  return s.counts;
}
/** The threshold one key step above the highest at which `frames` start an
 * utterance, never below the default 44 (or `old`, when that was lower).
 * Audio that starts one even at 100 is `too_loud`, and `old` stays. */
export function choose(
  frames: Int16Array[],
  timing: Timing,
  old: number,
): { threshold: number; loudest: number; outcome: "applied" | "too_loud" } {
  let loudest = 0;
  for (const f of frames) loudest = Math.max(loudest, level.rmsToPercent(level.rms(f)));
  let top = 100;
  while (top >= 0 && !starts(frames, timing, top)) top--;
  if (top === 100) return { threshold: old, loudest, outcome: "too_loud" };
  // `top + 1` is the lowest that starts none, as does every one above it.
  const floor = Math.min(level.default_threshold, old);
  return { threshold: Math.min(100, Math.max(floor, top + 1 + 2)), loudest, outcome: "applied" };
}
/** Whether earlier speech would still clear `threshold`: a warning when more
 * than half of the last 10 delivered utterances peak below it. */
export function warn(peaks: number[], threshold: number): "applied" | "applied_quiet_speech" | "no_speech_to_compare" {
  if (!peaks.length) return "no_speech_to_compare";
  const last = peaks.slice(-10);
  return last.filter(p => p < threshold).length * 2 > last.length ? "applied_quiet_speech" : "applied";
}
