import { test, expect } from "bun:test";
import { VoiceSession } from "./session";
import { Segmenter } from "./segmenter";
import { Events, type VoiceLink, type WatchRequest } from "./link";
import { shapes } from "../../tests/fixtures/voice/make_pcm";

/** A link whose replies the test hands out. */
class FakeLink implements VoiceLink {
  events = new Events();
  calls: { op: string; value?: unknown; at: number }[] = [];
  watched: WatchRequest[] = [];
  sets: object[] = [];
  closed = false;
  /** Whether the runtime has a viewer, as the watch reply says. */
  viewer = true;
  reply: (op: string, value?: unknown) => Promise<any> = async () => ({ pane: 1, viewer: 1 });
  async watch(req: WatchRequest) {
    this.watched.push(req);
    return { voice_id: "v-1", muted: req.muted, viewer: this.viewer, focus: "dictation" };
  }
  async set(state: object) {
    this.sets.push(state);
    return { muted: false };
  }
  type(text: string) {
    this.calls.push({ op: "type", value: text, at: performance.now() });
    return this.reply("type", text);
  }
  on(event: "muted" | "viewer" | "closed", fn: (value: any) => void) {
    this.events.on(event, fn);
  }
  close() {
    this.closed = true;
  }
}
class FakeWhisper {
  heard: string[] = [];
  requests = 0;
  crash: (code: number | null) => void = () => {};
  /** Holds every transcription until it resolves, for a Whisper that is behind. */
  gate: Promise<void> = Promise.resolve();
  constructor(private script: string[]) {}
  async transcribe() {
    this.requests++;
    await this.gate;
    return this.script.shift() ?? "";
  }
  on(_event: "crashed", fn: (code: number | null) => void) {
    this.crash = fn;
  }
}
function session(
  script: string[],
  opts: { link?: FakeLink; links?: (signal: AbortSignal) => Promise<VoiceLink>; timeout?: number } = {},
) {
  const link = opts.link ?? new FakeLink(),
    whisper = new FakeWhisper(script),
    s = new VoiceSession({
      link: opts.links ?? (async () => link),
      transcriber: whisper,
      segmenter: new Segmenter({ threshold: 44, timing: { silence: 0.5 }, now: () => 0 }),
      now: () => performance.now(),
      deliverTimeoutMs: opts.timeout ?? 2000,
      retryMs: 20,
    });
  return { s, link, whisper };
}
/** One utterance: 1.5 s of tone, then enough silence to end it. */
function speak(s: VoiceSession) {
  const pcm = shapes.speech();
  for (let at = 0; at < pcm.length; at += 320) s.frame(pcm.subarray(at, at + 320));
}
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(5);
  expect(check()).toBe(true);
}
const statuses = (s: VoiceSession) => s.history.filter(u => u.status !== "dropped").map(u => [u.status, u.reason]);

test("utterances are typed one delivery at a time", async () => {
  const link = new FakeLink();
  let open = 0,
    most = 0;
  link.reply = async () => {
    most = Math.max(most, ++open);
    await Bun.sleep(30);
    open--;
    return { pane: 1, viewer: 1 };
  };
  const { s } = session(["refactor the parser", "um, add tests"], { link });
  await s.connect();
  speak(s);
  speak(s);
  await until(() => s.history.filter(u => u.status === "delivered").length === 2);
  expect(link.calls.map(c => c.value)).toEqual(["refactor the parser", "add tests"]);
  expect(most).toBe(1);
  // The UI names where the text goes.
  expect(s.focus).toBe("dictation");
});

test("a delivery that never returns fails at the bound without holding up the next", async () => {
  const link = new FakeLink();
  let first = true;
  link.reply = () => {
    if (first) {
      first = false;
      return new Promise(() => {});
    }
    return Promise.resolve({ pane: 1, viewer: 1 });
  };
  const { s, whisper } = session(["stuck", "next one please"], { link, timeout: 300 });
  await s.connect();
  speak(s);
  await until(() => s.history[0]?.status === "delivering");
  const hung = performance.now();
  // Said while the first delivery hangs: heard and transcribed at once.
  speak(s);
  await until(() => whisper.requests === 2 && s.history[1]?.text === "next one please");
  expect(performance.now() - hung).toBeLessThan(300);
  expect(s.history[0].status).toBe("delivering");
  // Delivered as soon as the bound gives up on the first.
  await until(() => s.history[1].status === "delivered");
  expect(s.history[0]).toMatchObject({ status: "failed", reason: "no answer in time; may have been typed" });
  expect(performance.now() - hung).toBeLessThan(300 + 150);
});

test("what is said while disconnected fails and is never sent later", async () => {
  const link = new FakeLink(),
    links = [link, new FakeLink()];
  let connects = 0;
  const { s } = session(["lost words", "after"], { links: async () => links[Math.min(connects++, 1)] });
  await s.connect();
  link.events.emitClosed("runtime_gone");
  expect(s.link_state).toBe("lost");
  speak(s);
  await until(() => s.history[0]?.status === "failed");
  expect(s.history[0].reason).toBe("not connected");
  await until(() => s.link_state === "connected");
  speak(s);
  await until(() => s.history[1]?.status === "delivered");
  expect(links[1].calls.map(c => c.value)).toEqual(["after"]);
  expect(link.calls).toEqual([]);
});

test("reconnecting sends the current mute state", async () => {
  const links = [new FakeLink(), new FakeLink()];
  let connects = 0;
  const { s } = session([], { links: async () => links[connects++] });
  await s.connect();
  s.setMuted(true);
  expect(links[0].sets).toEqual([{ muted: true }]);
  links[0].events.emitClosed("runtime_gone");
  await until(() => s.link_state === "connected");
  expect(links[1].watched[0]).toMatchObject({ muted: true, available: true });
});

test("muting discards what is being said or transcribed", async () => {
  const { s, link, whisper } = session(["first", "second"]);
  await s.connect();
  const pcm = shapes.speech();
  for (let at = 0; at < 16000; at += 320) s.frame(pcm.subarray(at, at + 320));
  expect(s.history[0].status).toBe("recording");
  link.events.emitMuted(true);
  expect(statuses(s)).toEqual([["muted", null]]);
  speak(s);
  await Bun.sleep(30);
  expect(whisper.requests).toBe(0);
  expect(link.calls).toEqual([]);
  // Unmuted mid-transcription, then muted again before delivery.
  s.setMuted(false);
  let release!: (text: string) => void;
  whisper.transcribe = () => new Promise<string>(resolve => (release = resolve));
  speak(s);
  await until(() => s.history.at(-1)?.status === "transcribing");
  s.setMuted(true);
  release("too late");
  await Bun.sleep(30);
  expect(s.history.at(-1)?.status).toBe("muted");
  expect(link.calls).toEqual([]);
});

test("text the runtime refuses as muted is discarded, not failed", async () => {
  const link = new FakeLink();
  link.reply = async () => {
    throw Error("VoiceMuted");
  };
  const { s } = session(["late words"], { link });
  await s.connect();
  speak(s);
  await until(() => s.history[0]?.status === "muted");
  expect(statuses(s)).toEqual([["muted", null]]);
});

test("a Whisper that falls behind is not handed more than four recordings", async () => {
  const { s, whisper, link } = session(["one", "two", "three", "four"]);
  let open!: () => void;
  whisper.gate = new Promise(resolve => (open = resolve));
  await s.connect();
  for (let i = 0; i < 6; i++) speak(s);
  expect(statuses(s).map(([status]) => status)).toEqual([...Array(4).fill("transcribing"), "failed", "failed"]);
  expect(s.history[5].reason).toBe("backlog");
  open();
  await until(() => statuses(s).filter(([status]) => status === "delivered").length === 4);
  expect(link.calls.map(c => c.value)).toEqual(["one", "two", "three", "four"]);
  // With the backlog cleared, speech goes through again.
  speak(s);
  await until(() => s.history.at(-1)?.status === "dropped" || s.history.at(-1)?.status === "delivered");
  expect(s.history.at(-1)?.reason).not.toBe("backlog");
});

test("a runtime that is slow to take text is not handed more than four utterances", async () => {
  const link = new FakeLink();
  link.reply = () => new Promise(() => {});
  const { s } = session(["a", "b", "c", "d", "e", "f"], { link, timeout: 200 });
  await s.connect();
  for (let i = 0; i < 6; i++) speak(s);
  await until(() => s.history[0]?.status === "delivering");
  expect(statuses(s).map(([status]) => status)).toEqual([
    "delivering",
    ...Array(3).fill("transcribing"),
    "failed",
    "failed",
  ]);
  expect(s.history[4].reason).toBe("backlog");
  await until(
    () => statuses(s).filter(([, why]) => why === "no answer in time; may have been typed").length === 4,
    3000,
  );
});

test("an availability update on its way does not undo a mute from a viewer", async () => {
  const link = new FakeLink();
  const { s } = session([], { link });
  await s.connect();
  s.setAvailable(false, "mic_busy");
  // What goes out names only what changed here.
  expect(link.sets).toEqual([{ available: false }]);
  link.events.emitMuted(true);
  s.frame(new Int16Array(320));
  // Updates go one at a time: this one follows the first.
  await until(() => link.sets.length === 2);
  expect(link.sets).toEqual([{ available: false }, { available: true }]);
  expect(s.muted).toBe(true);
});

test("words that sound like commands are typed as text", async () => {
  const { s, link } = session(["Send.", "next"]);
  await s.connect();
  speak(s);
  speak(s);
  await until(() => s.history.filter(u => u.status === "delivered").length === 2);
  expect(link.calls.map(c => [c.op, c.value])).toEqual([
    ["type", "Send."],
    ["type", "next"],
  ]);
});

test("non-speech and phantom text are dropped, not typed", async () => {
  const { s, link } = session(["[BLANK_AUDIO]", "Thank you.", "um"]);
  await s.connect();
  speak(s);
  speak(s);
  speak(s);
  await until(() => s.history.filter(u => u.status === "dropped").length === 3);
  expect(link.calls).toEqual([]);
});

test("a crash spares text Whisper already gave back", async () => {
  const link = new FakeLink();
  let release!: () => void,
    first = true;
  link.reply = () => {
    if (!first) return Promise.resolve({ pane: 1, viewer: 1 });
    first = false;
    return new Promise(resolve => (release = () => resolve({ pane: 1, viewer: 1 })));
  };
  const { s, whisper } = session(["held", "waiting"], { link });
  await s.connect();
  speak(s);
  await until(() => s.history[0]?.status === "delivering");
  // Transcribed, and queued behind the delivery that hangs.
  speak(s);
  await until(() => s.history[1]?.text === "waiting");
  whisper.crash(3);
  expect(s.history[1].status).toBe("transcribing");
  release();
  await until(() => s.history[1].status === "delivered");
  expect(link.calls.map(c => c.value)).toEqual(["held", "waiting"]);
});

test("speech during a filter switch fails as such, not as a crash", async () => {
  const { s, whisper } = session([]);
  await s.connect();
  whisper.transcribe = () => Promise.reject(Error("ServerRestarting"));
  speak(s);
  await until(() => s.history[0]?.status === "failed");
  expect(s.history[0].reason).toBe("filter switching");
  expect(s.available).toBe(true);
});

test("a fresh server after a crash makes voice listen again", async () => {
  const { s, link, whisper } = session(["back again"]);
  await s.connect();
  whisper.crash(3);
  expect(s.available).toBe(false);
  s.serverReady();
  expect([s.available, s.unavailable, s.server]).toEqual([true, null, "ready"]);
  await until(() => link.sets.length === 2);
  expect(link.sets).toEqual([{ available: false }, { available: true }]);
  speak(s);
  await until(() => s.history[0]?.status === "delivered");
  expect(link.calls.map(c => c.value)).toEqual(["back again"]);
});

test("a server crash fails the utterance and stops listening", async () => {
  const { s, link, whisper } = session([]);
  await s.connect();
  whisper.transcribe = () => new Promise<string>(() => {});
  speak(s);
  await until(() => s.history[0]?.status === "transcribing");
  whisper.crash(3);
  expect(statuses(s)).toEqual([["failed", "server crashed"]]);
  expect([s.available, s.unavailable, s.server]).toEqual([false, "server_down", "crashed"]);
  expect(link.sets).toEqual([{ available: false }]);
  speak(s);
  expect(s.history).toHaveLength(1);
  s.setMuted(false);
  expect(s.available).toBe(false);
});

test("a microphone that comes back does not revive a crashed server", async () => {
  const { s, link, whisper } = session([]);
  await s.connect();
  whisper.crash(3);
  s.setAvailable(false, "mic_missing");
  s.frame(new Int16Array(320));
  expect([s.available, s.unavailable]).toEqual([false, "server_down"]);
  expect(link.sets.at(-1)).toMatchObject({ available: false });
  s.setMuted(false);
  expect(s.available).toBe(false);
});

test("a microphone that comes back makes voice available again", async () => {
  const { s, link } = session([]);
  await s.connect();
  s.setAvailable(false, "mic_denied");
  expect(s.unavailable).toBe("mic_denied");
  s.frame(new Int16Array(320));
  expect([s.available, s.unavailable]).toEqual([true, null]);
  await until(() => link.sets.length === 2);
  expect(link.sets).toEqual([{ available: false }, { available: true }]);
});

test("a first connection that fails and is given up on never retries", async () => {
  let attempts = 0;
  const { s } = session([], {
    links: async () => {
      attempts++;
      throw Error("NoRuntime");
    },
  });
  await expect(s.connect()).rejects.toThrow("NoRuntime");
  s.close();
  await Bun.sleep(60);
  expect(attempts).toBe(1);
});

test("quitting while a connection is on its way aborts it and attaches nothing", async () => {
  const link = new FakeLink();
  let release!: () => void,
    aborted = false;
  const { s } = session([], {
    links: signal =>
      new Promise(resolve => {
        signal.addEventListener("abort", () => (aborted = true));
        release = () => resolve(link);
      }),
  });
  const connecting = s.connect();
  s.close();
  expect(aborted).toBe(true);
  release();
  await connecting;
  expect(link.closed).toBe(true);
  expect(link.watched).toEqual([]);
});

test("state the runtime did not take is sent again", async () => {
  const link = new FakeLink();
  let failures = 1;
  const set = link.set.bind(link);
  link.set = async state => {
    if (failures-- > 0) throw Error("Timeout");
    return set(state);
  };
  const { s } = session([], { link });
  await s.connect();
  s.setMuted(true);
  expect(link.sets).toEqual([]);
  await until(() => link.sets.length === 1, 2000);
  expect(link.sets[0]).toEqual({ muted: true });
});

test("an older answer never cancels the retry of a newer mute change", async () => {
  const link = new FakeLink();
  let answer!: () => void;
  link.set = async state => {
    link.sets.push(state);
    if (link.sets.length === 1) return new Promise(resolve => (answer = () => resolve({ muted: true })));
    if (link.sets.length === 2) throw Error("Timeout");
    return { muted: false };
  };
  const { s } = session([], { link });
  await s.connect();
  s.setMuted(true);
  s.setMuted(false);
  await until(() => answer !== undefined);
  answer();
  await until(() => link.sets.length === 3, 2000);
  expect(link.sets).toEqual([{ muted: true }, { muted: false }, { muted: false }]);
});

test("a change waiting to go out never undoes a mute from a viewer", async () => {
  const link = new FakeLink();
  let answer!: () => void;
  link.set = async state => {
    link.sets.push(state);
    if (link.sets.length === 1) await new Promise<void>(resolve => (answer = resolve));
    return { muted: true };
  };
  const { s } = session([], { link });
  await s.connect();
  s.setMuted(true);
  s.setMuted(false);
  await until(() => answer !== undefined);
  link.events.emitMuted(true);
  answer();
  await until(() => link.sets.length === 2);
  expect(s.muted).toBe(true);
  expect(link.sets).toEqual([{ muted: true }, { muted: true }]);
});

test("a mute pressed while the watch is on its way still reaches the runtime", async () => {
  const link = new FakeLink();
  let answer!: () => void;
  const watch = link.watch.bind(link);
  link.watch = req => new Promise(resolve => (answer = () => resolve(watch(req))));
  const { s } = session([], { link });
  const connecting = s.connect();
  await until(() => answer !== undefined);
  s.setMuted(true);
  answer();
  await connecting;
  expect(s.muted).toBe(true);
  expect(link.sets).toEqual([{ muted: true }]);
});

test("a runtime that refuses this voice is not retried", async () => {
  let attempts = 0;
  const { s } = session([], {
    links: async () => {
      attempts++;
      throw Error("VoiceAttached");
    },
  });
  await expect(s.connect()).rejects.toThrow("VoiceAttached");
  await Bun.sleep(60);
  expect([s.link_state, s.refused, attempts]).toEqual(["refused", "VoiceAttached", 1]);
});

test("without a viewer, voice holds off and drops what is in progress", async () => {
  const link = new FakeLink();
  link.viewer = false;
  const { s, whisper } = session(["lost"], { link });
  await s.connect();
  expect([s.viewer, s.focus]).toEqual([false, "dictation"]);
  speak(s);
  await Bun.sleep(30);
  expect(whisper.requests).toBe(0);
  expect(s.history).toEqual([]);
  // A viewer attaches: speech counts again.
  link.events.emitViewer({ viewer: true, focus: "build" });
  expect(s.focus).toBe("build");
  const pcm = shapes.speech();
  for (let at = 0; at < 16000; at += 320) s.frame(pcm.subarray(at, at + 320));
  expect(s.recording).toBe(true);
  // It goes away mid-sentence: the sentence is dropped, never typed later.
  link.events.emitViewer({ viewer: false, focus: null });
  expect(statuses(s)).toEqual([["discarded", "no viewer"]]);
  expect(link.calls).toEqual([]);
});

test("a link that keeps failing is logged once per distinct failure", async () => {
  const lines: string[] = [];
  let attempts = 0,
    failure = "NoRuntime";
  const link = new FakeLink(),
    s = new VoiceSession({
      link: async () => {
        attempts++;
        if (failure) throw Error(failure);
        return link;
      },
      transcriber: new FakeWhisper([]),
      segmenter: new Segmenter({ threshold: 44, now: () => 0 }),
      now: () => performance.now(),
      retryMs: 5,
      log: line => lines.push(line),
    });
  await s.connect().catch(() => {});
  await until(() => attempts >= 5);
  failure = "SshFailed";
  await until(() => attempts >= 10);
  failure = "";
  await until(() => s.link_state === "connected");
  s.close();
  expect(lines).toEqual(["link: NoRuntime", "link: SshFailed", "link: connected"]);
});

test("a transcription that times out says so, not that it may have been typed", async () => {
  const { s, whisper, link } = session([]);
  await s.connect();
  whisper.transcribe = () => Promise.reject(Error("Timeout"));
  speak(s);
  await until(() => s.history[0]?.status === "failed");
  expect(s.history[0].reason).toBe("timed out");
  expect(link.calls).toEqual([]);
});
