import { test, expect } from "bun:test";
import * as gauge from "./gauge";
import * as level from "./level";
import { Segmenter, default_timing, type Timing } from "./segmenter";
import { concat, music, silence, tone } from "../../tests/fixtures/voice/make_pcm";

/** `pcm` in 20 ms frames. */
const framed = (pcm: Int16Array) =>
  Array.from({ length: pcm.length / 320 }, (_, i) => pcm.subarray(i * 320, i * 320 + 320));
/** A replay at `pct`: the segments that came out, and whether one with enough speech is still open. */
function replay(frames: Int16Array[], pct: number, timing: Timing = default_timing) {
  const s = new Segmenter({ threshold: pct, timing, now: () => 0 });
  let segments = 0;
  for (const f of frames) segments += s.push(f).length;
  return { segments, counts: s.counts };
}
const starts = (frames: Int16Array[], pct: number, timing?: Timing) => {
  const r = replay(frames, pct, timing);
  return r.segments > 0 || r.counts;
};

test("a gauge listens for 10 s of 20 ms frames", () => {
  expect([gauge.listen_seconds, gauge.listen_frames]).toEqual([10, 500]);
});

test("a steady tone sets the threshold one key step above the lowest it starts nothing at", () => {
  const frames = framed(tone(10, level.percentToRms(55.5))),
    measured = level.rmsToPercent(level.rms(frames[0])),
    result = gauge.choose(frames, default_timing, 44);
  // Loud at every whole threshold up to the measured level, none above it.
  expect(result).toEqual({ threshold: Math.floor(measured) + 1 + 2, loudest: measured, outcome: "applied" });
  expect(result.threshold).toBe(58);
  // The tone never pauses: no utterance comes out, but one is open with enough speech.
  expect(replay(frames, Math.floor(measured))).toEqual({ segments: 0, counts: true });
  expect(replay(frames, Math.floor(measured) + 1)).toEqual({ segments: 0, counts: false });
});

test("music starts nothing at the result, nor two below it, but one at three below", () => {
  const frames = framed(music(10, 7)).slice(0, gauge.listen_frames),
    { threshold, outcome } = gauge.choose(frames, default_timing, 44);
  expect(outcome).toBe("applied");
  // Neither clamped at 44 nor at 100.
  expect(threshold).toBeGreaterThan(46);
  expect(threshold).toBeLessThan(98);
  for (let pct = threshold - 2; pct <= 100; pct++) expect(starts(frames, pct)).toBe(false);
  expect(starts(frames, threshold - 3)).toBe(true);
});

test("gauged on the first 10 s, the next 30 s of the same music start no utterance", () => {
  for (const seed of [1, 7, 42]) {
    const frames = framed(music(40, seed)),
      { threshold } = gauge.choose(frames.slice(0, gauge.listen_frames), default_timing, 44);
    expect(replay(frames.slice(gauge.listen_frames), threshold)).toEqual({ segments: 0, counts: false });
  }
});

test("the replay follows the timings it is given", () => {
  const frames = framed(music(10, 7)),
    usual = gauge.choose(frames, default_timing, 44).threshold,
    // Clicks are too short to make a second of speech: only the notes count.
    patient = gauge.choose(frames, { ...default_timing, min_speech: 1 }, 44).threshold;
  expect(patient).toBeLessThan(usual);
  expect(starts(frames, patient - 3, { ...default_timing, min_speech: 1 })).toBe(true);
});

test("the result clears every higher threshold, not only the first that starts nothing", () => {
  // At 50 and below the click opens the utterance early, so the short note
  // never resets the pause and it ends with too little speech: this audio
  // starts utterances from 51 to 70 only.
  const frames = framed(
    concat(
      silence(1),
      tone(0.02, level.percentToRms(50.5)),
      silence(0.2),
      tone(0.06, level.percentToRms(70.5)),
      silence(2.4),
      tone(0.14, level.percentToRms(70.5)),
      silence(3.5),
    ),
  );
  expect([starts(frames, 50), starts(frames, 51), starts(frames, 70), starts(frames, 71)]).toEqual([
    false,
    true,
    true,
    false,
  ]);
  expect(gauge.choose(frames, default_timing, 44).threshold).toBe(73);
});

test("silence sets the default 44, or keeps a lower threshold", () => {
  const frames = framed(silence(10));
  expect(gauge.choose(frames, default_timing, 44)).toEqual({ threshold: 44, loudest: 0, outcome: "applied" });
  expect(gauge.choose(frames, default_timing, 30).threshold).toBe(30);
  expect(gauge.choose(frames, default_timing, 60).threshold).toBe(44);
  // At the bottom of the scale, one key step above 0 still.
  expect([0, 1].map(old => gauge.choose(frames, default_timing, old).threshold)).toEqual([2, 2]);
});

test("under a lower old threshold, music between it and 44 sets its own", () => {
  const frames = framed(tone(10, level.percentToRms(35.5)));
  expect(gauge.choose(frames, default_timing, 30).threshold).toBe(38);
});

test("audio that starts utterances even at 100 is too loud, and the threshold stays", () => {
  const frames = framed(tone(10, 0.6));
  expect(gauge.choose(frames, default_timing, 50)).toEqual({ threshold: 50, loudest: 100, outcome: "too_loud" });
});

test("the result never passes 100", () => {
  // Loud at 99, quiet at 100: one above is 100, and two more stay 100.
  const frames = framed(tone(10, level.percentToRms(99.5)));
  expect(gauge.choose(frames, default_timing, 44)).toMatchObject({ threshold: 100, outcome: "applied" });
});

test("it warns when more than half of the last ten utterances peak below the result", () => {
  const peaks = (below: number, n = 10) => Array.from({ length: n }, (_, i) => (i < below ? 50 : 70));
  expect(gauge.warn(peaks(6), 58)).toBe("applied_quiet_speech");
  expect(gauge.warn(peaks(5), 58)).toBe("applied");
  expect(gauge.warn(peaks(2, 3), 58)).toBe("applied_quiet_speech");
  expect(gauge.warn(peaks(1, 2), 58)).toBe("applied");
  expect(gauge.warn([], 58)).toBe("no_speech_to_compare");
  // Only the last ten: two quiet ones before them no longer count.
  expect(gauge.warn([50, 50, ...peaks(5)], 58)).toBe("applied");
  // A peak at the result clears it.
  expect(gauge.warn([58], 58)).toBe("applied");
});
