import { test, expect } from "bun:test";
import { Segmenter, type Segment, type Timing } from "./segmenter";
import { shapes, concat, silence, tone } from "../../tests/fixtures/voice/make_pcm";

/** A segmenter fed 20 ms frames on a clock that moves with them; `ends` holds
 * the clock at each segment that came out. */
function live(opts: { threshold?: number } & Partial<Timing> = {}) {
  let clock = 0;
  const { threshold = 44, ...timing } = opts;
  const segmenter = new Segmenter({ threshold, timing, now: () => clock }),
    segments: Segment[] = [],
    ends: number[] = [];
  const push = (pcm: Int16Array) => {
    for (let at = 0; at < pcm.length; at += 320) {
      clock += 20;
      for (const s of segmenter.push(pcm.subarray(at, at + 320))) {
        segments.push(s);
        ends.push(clock);
      }
    }
  };
  return { segmenter, segments, ends, push };
}
function feed(pcm: Int16Array, opts: { threshold?: number } & Partial<Timing> = {}) {
  const l = live(opts);
  l.push(pcm);
  return l;
}
/** Speech, then a soft ending under the threshold (44 is RMS about 0.0154),
 * then a pause longer than the silence window. */
const softEnding = () => concat(tone(1.5), tone(0.8, 0.005), silence(3));

test("one burst of speech is one utterance, with pre-roll and trimmed silence", () => {
  const { segments, segmenter } = feed(concat(silence(1), shapes.speech()));
  expect(segments).toHaveLength(1);
  // 0.3 s pre-roll, 1.5 s of speech, 1 s of the silence (the default post-roll).
  expect(segments[0].duration).toBeCloseTo(2.8, 5);
  expect(segments[0].pcm.length).toBe(2.8 * 16000);
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
  expect(segments[1].duration).toBeCloseTo(6, 5);
});

test("two bursts are two utterances", () => {
  // The first starts the stream, so only the second has pre-roll.
  expect(feed(shapes.two()).segments.map(s => s.duration)).toEqual([2.5, 2.8]);
});

test("short peaks, as in music under the threshold, do not hold an utterance open", () => {
  // A 20 ms beat every 0.2 s for 4 s after the speech.
  const beats = Array.from({ length: 20 }, () => concat(silence(0.18), tone(0.02)));
  const { segments } = feed(concat(tone(1.5), ...beats, silence(3)), { silence: 1 });
  // The speech ends 1 s after it stops, not after the beats; the beats alone are too little speech.
  expect(segments.map(s => s.duration)).toEqual([1.5 + 1]);
  // Dense peaks, 60 ms in every 100 ms, count as pause too: it ends 1 s after the speech.
  const dense = Array.from({ length: 40 }, () => concat(silence(0.04), tone(0.06)));
  expect(feed(concat(tone(1.5), ...dense, silence(3)), { silence: 1 }).segments[0].duration).toBeCloseTo(2.5, 5);
  // Speech that resumes within the window still continues the utterance.
  expect(feed(concat(tone(1), silence(0.6), tone(1), silence(3)), { silence: 1 }).segments).toHaveLength(1);
});

test("too little speech is dropped", () => {
  expect(feed(concat(tone(0.1), silence(3))).segments).toHaveLength(0);
});

test("the threshold and the silence window apply", () => {
  expect(feed(shapes.speech(), { threshold: 90 }).segments).toHaveLength(0);
  expect(feed(concat(tone(1), silence(1), tone(1), silence(3)), { silence: 0.5 }).segments).toHaveLength(2);
  // Raised mid-utterance, the threshold makes the same tone quiet: the pause runs out during it.
  const { segmenter } = feed(concat(tone(1), silence(1)));
  segmenter.setThreshold(100);
  const out: Segment[] = [],
    loud = tone(2);
  for (let at = 0; at < loud.length; at += 320) out.push(...segmenter.push(loud.subarray(at, at + 320)));
  expect(out).toHaveLength(1);
  expect(segmenter.recording).toBe(false);
  // At the old threshold, the tone keeps it open.
  const kept = feed(concat(tone(1), silence(1), tone(2)));
  expect(kept.segments).toHaveLength(0);
  expect(kept.segmenter.recording).toBe(true);
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
  expect(feed(concat(silence(1), shapes.speech()), { pre_roll: 0 }).segments[0].duration).toBeCloseTo(2.5, 5);
  expect(feed(concat(silence(1), shapes.speech()), { pre_roll: 0.5 }).segments[0].duration).toBeCloseTo(3, 5);
  // 0.1 s of speech counts once the minimum is lower.
  expect(feed(concat(tone(0.1), silence(3)), { min_speech: 0.05 }).segments).toHaveLength(1);
  // With 20 ms bursts counting as speech, the beats hold the utterance open.
  const beats = Array.from({ length: 20 }, () => concat(silence(0.18), tone(0.02)));
  expect(feed(concat(tone(1.5), ...beats, silence(3)), { silence: 1, burst: 0.02 }).segments[0].duration).toBeCloseTo(
    1.5 + 4 + 1,
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
  expect(out.map(s => s.duration)).toEqual([2.1]);
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
  // Only the rest of the burst comes out: 0.5 s of it and 1 s of silence.
  expect(out.map(s => s.duration)).toEqual([1.5]);
});

test("post-roll keeps a quiet sentence ending under the threshold", () => {
  const pcm = softEnding(),
    ending = pcm.subarray(1.5 * 16000, 2.3 * 16000);
  // The default 1 s holds the whole 0.8 s ending.
  const [kept] = feed(pcm).segments;
  expect(kept.duration).toBeCloseTo(2.5, 5);
  expect(kept.pcm.subarray(1.5 * 16000, 2.3 * 16000)).toEqual(ending);
  expect(kept.post_roll).toBe(1);
  expect(kept.kept).toBeCloseTo(1, 5);
  expect(kept.dropped).toBeCloseTo(1.5, 5);
  // 0.3 s, the old fixed trim, ends it 0.3 s after the last burst.
  const [cut] = feed(pcm, { post_roll: 0.3 }).segments;
  expect(cut.pcm.length).toBe(1.8 * 16000);
  // The speech and the first 0.3 s of the ending; its last 0.5 s is lost.
  expect(cut.pcm).toEqual(pcm.subarray(0, 1.8 * 16000));
  expect(cut.post_roll).toBe(0.3);
  expect(cut.kept).toBeCloseTo(0.3, 5);
  expect(cut.dropped).toBeCloseTo(2.2, 5);
});

test("whole pause, or a post-roll past the silence window, keeps the pause up to the window's end", () => {
  for (const post_roll of [Infinity, 5]) {
    const [s] = feed(softEnding(), { post_roll }).segments;
    expect(s.duration).toBeCloseTo(1.5 + 2.5, 5);
    expect(s.post_roll).toBe(2.5);
    expect(s.kept).toBeCloseTo(2.5, 5);
    expect(s.dropped).toBe(0);
  }
  // None ends the audio with the last burst.
  const [none] = feed(softEnding(), { post_roll: 0 }).segments;
  expect(none.duration).toBeCloseTo(1.5, 5);
  expect(none).toMatchObject({ post_roll: 0, kept: 0 });
  expect(none.dropped).toBeCloseTo(2.5, 5);
});

test("a peak shorter than a burst after the speech does not move the cut", () => {
  // 40 ms over the threshold 0.4 s after the speech; a burst is 0.1 s.
  const pcm = concat(tone(1.5), silence(0.4), tone(0.04), silence(3));
  const [s] = feed(pcm, { post_roll: 0.3 }).segments;
  expect(s.duration).toBeCloseTo(1.8, 5);
  expect(s.kept).toBeCloseTo(0.3, 5);
  // Were it a burst, the cut would follow it.
  expect(feed(pcm, { post_roll: 0.3, burst: 0.04 }).segments[0].duration).toBeCloseTo(1.5 + 0.4 + 0.04 + 0.3, 5);
});

test("with a burst longer than the first loud run, the cut follows that run", () => {
  // 0.2 s of speech, then a 0.1 s peak 0.3 s later; a burst is 0.3 s.
  const [s] = feed(concat(tone(0.2), silence(0.3), tone(0.1), silence(3)), { burst: 0.3, post_roll: 0.3 }).segments;
  expect(s.duration).toBeCloseTo(0.5, 5);
  expect(s.kept).toBeCloseTo(0.3, 5);
  expect(s.dropped).toBeCloseTo(2.2, 5);
});

test("an utterance cut at the cap is sent whole", () => {
  // During speech: nothing follows the last burst.
  const [during] = feed(shapes.long(), { post_roll: 0.3 }).segments;
  expect(during).toMatchObject({ duration: 30, kept: 0, dropped: 0, capped: true });
  // During the closing pause: the second of it so far stays.
  const { segments, segmenter } = feed(concat(tone(29), silence(4)), { post_roll: 0.3 });
  expect(segments).toHaveLength(1);
  expect(segments[0].duration).toBe(30);
  expect(segments[0].kept).toBeCloseTo(1, 5);
  expect(segments[0].dropped).toBe(0);
  expect(segments[0].capped).toBe(true);
  // Listening carried on; the pause alone was too little speech.
  expect(segmenter.recording).toBe(false);
});

test("post-roll never changes when an utterance ends", () => {
  const ends = [0.3, 1, Infinity].map(post_roll => feed(softEnding(), { post_roll }).ends);
  // 1.5 s of speech and the 2.5 s window.
  expect(ends).toEqual([[4000], [4000], [4000]]);
});

test("post-roll changes neither how an utterance starts, which ones count, nor the cap", () => {
  // Pre-roll, speech, a short peak, then a sound too short to count.
  const pcm = concat(silence(1), tone(1.5), silence(0.4), tone(0.04), silence(3), tone(0.1), silence(3)),
    base = feed(pcm, { post_roll: 0 });
  expect(base.segments).toHaveLength(1);
  expect(base.segments[0].capped).toBe(false);
  for (const post_roll of [0.3, 1, Infinity]) {
    const run = feed(pcm, { post_roll });
    expect(run.ends).toEqual(base.ends);
    expect(run.segments.map(s => s.started_at)).toEqual(base.segments.map(s => s.started_at));
    // The same pre-roll and speech, then more of the pause.
    expect(run.segments[0].pcm.subarray(0, base.segments[0].pcm.length)).toEqual(base.segments[0].pcm);
  }
  for (const post_roll of [0, Infinity])
    expect(feed(shapes.long(), { post_roll }).segments[0]).toMatchObject({ duration: 30, capped: true });
});

test("the cut reports the whole frames it kept", () => {
  // 0.75 s is 37.5 frames of 20 ms; the cut keeps 38.
  const [s] = feed(softEnding(), { post_roll: 0.75 }).segments;
  expect(s.post_roll).toBe(0.76);
  expect(s.kept).toBe(0.76);
  expect(s.dropped).toBeCloseTo(1.74, 5);
});

test("post-roll changed mid-utterance applies when it ends, within the silence window then", () => {
  const l = live();
  l.push(concat(tone(1), silence(1)));
  l.segmenter.setTiming("post_roll", 0.5);
  l.push(silence(2));
  expect(l.segments).toHaveLength(1);
  expect(l.segments[0].duration).toBeCloseTo(1.5, 5);
  expect(l.segments[0].post_roll).toBe(0.5);
  expect(l.segments[0].kept).toBeCloseTo(0.5, 5);
  expect(l.segments[0].dropped).toBeCloseTo(2, 5);
  // Whole pause reports the silence window in effect as the utterance ends.
  l.segmenter.setTiming("post_roll", Infinity);
  l.segmenter.setTiming("silence", 1);
  l.push(concat(tone(1), silence(2)));
  expect(l.segments).toHaveLength(2);
  expect(l.segments[1].post_roll).toBe(1);
  expect(l.segments[1].kept).toBeCloseTo(1, 5);
  expect(l.segments[1].dropped).toBe(0);
});

test("whole pause follows a silence window changed mid-utterance", () => {
  const l = live({ silence: 1, post_roll: Infinity });
  l.push(concat(tone(1), silence(0.5)));
  l.segmenter.setTiming("silence", 2);
  l.push(silence(3));
  expect(l.segments).toHaveLength(1);
  expect(l.segments[0].duration).toBeCloseTo(3, 5);
  expect(l.segments[0].post_roll).toBe(2);
  expect(l.segments[0].kept).toBeCloseTo(2, 5);
  expect(l.segments[0].dropped).toBe(0);
  // Shortened below the pause so far, it ends the utterance on the next frame
  // and keeps no more than the new window, as any longer post-roll would.
  for (const post_roll of [Infinity, 1.2]) {
    const short = live({ post_roll });
    short.push(concat(tone(1), silence(1.5)));
    short.segmenter.setTiming("silence", 1);
    short.push(silence(0.02));
    expect(short.segments).toHaveLength(1);
    expect(short.segments[0].post_roll).toBe(1);
    expect(short.segments[0].kept).toBeCloseTo(1, 5);
    expect(short.segments[0].dropped).toBeCloseTo(0.52, 5);
    expect(short.segments[0].duration).toBeCloseTo(2, 5);
  }
});
