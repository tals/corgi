import { test, expect } from "bun:test";
import { Segmenter, type Segment, type Timing } from "./segmenter";
import { shapes, concat, silence, tone } from "../../tests/fixtures/voice/make_pcm";

/** Feeds `pcm` in 20 ms frames on a clock that moves with the frames. */
function feed(pcm: Int16Array, opts: { threshold?: number } & Partial<Timing> = {}) {
  let clock = 0;
  const { threshold = 44, ...timing } = opts;
  const s = new Segmenter({ threshold, timing, now: () => clock }),
    out: Segment[] = [];
  for (let at = 0; at < pcm.length; at += 320) {
    clock += 20;
    out.push(...s.push(pcm.subarray(at, at + 320)));
  }
  return { segmenter: s, segments: out };
}

test("one burst of speech is one utterance, with pre-roll and trimmed silence", () => {
  const { segments, segmenter } = feed(concat(silence(1), shapes.speech()));
  expect(segments).toHaveLength(1);
  // 0.3 s pre-roll, 1.5 s of speech, 0.3 s of the silence.
  expect(segments[0].duration).toBeCloseTo(2.1, 5);
  expect(segments[0].pcm.length).toBe(2.1 * 16000);
  expect(segments[0].started_at).toBe(1000 - 300 + 20);
  expect(segmenter.recording).toBe(false);
});

test("noise below the threshold is no utterance", () => {
  const { segments, segmenter } = feed(shapes.noise());
  expect(segments).toHaveLength(0);
  expect(segmenter.recording).toBe(false);
  // The same noise above the threshold would have been one.
  expect(feed(shapes.noise(), { threshold: 0 }).segments).toHaveLength(1);
});

test("a long utterance goes out at 30 s and listening carries on", () => {
  const { segments } = feed(concat(shapes.long(), silence(3)));
  expect(segments).toHaveLength(2);
  expect(segments[0].duration).toBe(30);
  expect(segments[1].duration).toBeCloseTo(5.3, 5);
});

test("two bursts are two utterances", () => {
  // The first starts the stream, so only the second has pre-roll.
  expect(feed(shapes.two()).segments.map(s => s.duration)).toEqual([1.8, 2.1]);
});

test("short peaks, as in music under the threshold, do not hold an utterance open", () => {
  // A 20 ms beat every 0.2 s for 4 s after the speech.
  const beats = Array.from({ length: 20 }, () => concat(silence(0.18), tone(0.02)));
  const { segments } = feed(concat(tone(1.5), ...beats, silence(3)), { silence: 1 });
  // The speech ends 1 s after it stops, not after the beats; the beats alone are too little speech.
  expect(segments.map(s => s.duration)).toEqual([1.5 + 0.3]);
  // Speech that resumes within the window still continues the utterance.
  expect(feed(concat(tone(1), silence(0.6), tone(1), silence(3)), { silence: 1 }).segments).toHaveLength(1);
});

test("too little speech is dropped", () => {
  expect(feed(concat(tone(0.1), silence(3))).segments).toHaveLength(0);
});

test("the threshold and the silence window apply", () => {
  expect(feed(shapes.speech(), { threshold: 90 }).segments).toHaveLength(0);
  expect(feed(concat(tone(1), silence(1), tone(1), silence(3)), { silence: 0.5 }).segments).toHaveLength(2);
  const { segmenter } = feed(concat(tone(1), silence(1)));
  segmenter.setThreshold(100);
  expect(segmenter.recording).toBe(true);
});

test("the silence window can change mid-stream, and the pause shows how far it is", () => {
  let clock = 0;
  const s = new Segmenter({ threshold: 44, now: () => clock }),
    out: Segment[] = [];
  const push = (pcm: Int16Array) => {
    for (let at = 0; at < pcm.length; at += 320) {
      clock += 20;
      out.push(...s.push(pcm.subarray(at, at + 320)));
    }
  };
  push(concat(tone(1), silence(0.5)));
  expect(s.pause).toBeCloseTo(0.2, 5);
  // A shorter window ends the utterance on the next quiet frame.
  s.setTiming("silence", 0.5);
  push(silence(0.02));
  expect(out).toHaveLength(1);
  expect(s.pause).toBe(0);
});

test("pre-roll, minimum speech and burst length apply, also when changed", () => {
  // No pre-roll: the utterance starts with the speech.
  expect(feed(concat(silence(1), shapes.speech()), { pre_roll: 0 }).segments[0].duration).toBeCloseTo(1.8, 5);
  expect(feed(concat(silence(1), shapes.speech()), { pre_roll: 0.5 }).segments[0].duration).toBeCloseTo(2.3, 5);
  // 0.1 s of speech counts once the minimum is lower.
  expect(feed(concat(tone(0.1), silence(3)), { min_speech: 0.05 }).segments).toHaveLength(1);
  // With 20 ms bursts counting as speech, the beats hold the utterance open.
  const beats = Array.from({ length: 20 }, () => concat(silence(0.18), tone(0.02)));
  expect(feed(concat(tone(1.5), ...beats, silence(3)), { silence: 1, burst: 0.02 }).segments[0].duration).toBeCloseTo(
    1.5 + 4 + 0.3,
    5,
  );
  // A pre-roll shortened mid-stream keeps only the new length.
  let clock = 0;
  const s = new Segmenter({ threshold: 44, now: () => clock }),
    out: Segment[] = [];
  const push = (pcm: Int16Array) => {
    for (let at = 0; at < pcm.length; at += 320) {
      clock += 20;
      out.push(...s.push(pcm.subarray(at, at + 320)));
    }
  };
  push(silence(1));
  s.setTiming("pre_roll", 0.1);
  push(concat(tone(1), silence(3)));
  expect(out.map(s => s.duration)).toEqual([1.4]);
});

test("abort drops the utterance in progress", () => {
  const s = new Segmenter({ threshold: 44, now: () => 0 });
  const pcm = shapes.speech();
  for (let at = 0; at < 16000; at += 320) s.push(pcm.subarray(at, at + 320));
  expect(s.recording).toBe(true);
  s.abort();
  expect(s.recording).toBe(false);
  const out: Segment[] = [];
  for (let at = 16000; at < pcm.length; at += 320) out.push(...s.push(pcm.subarray(at, at + 320)));
  // Only the rest of the burst comes out: 0.5 s of it and 0.3 s of silence.
  expect(out.map(s => s.duration)).toEqual([0.8]);
});
