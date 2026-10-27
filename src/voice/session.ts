//! Voice mode's pipeline: microphone frames become utterances, Whisper's text
//! is cleaned and classified, and one delivery at a time goes to the runtime,
//! each given 2 s. Nothing waits for a lost link; it is retried every 5 s.
import * as wav from "./wav";
import * as text from "./text";
import * as level from "./level";
import * as errors from "../errors";
import { bounded, type Seen, type VoiceLink } from "./link";
import type { Segmenter, Segment } from "./segmenter";
import type { Server } from "./whisper";
import type { MicProblem } from "./capture";

export type UtteranceStatus =
  "recording" | "transcribing" | "delivering" | "delivered" | "failed" | "discarded" | "dropped";
export type Utterance = {
  id: number;
  captured_at: number;
  duration: number;
  status: UtteranceStatus;
  text: string | null;
  reason: string | null;
  timings: { transcribe_ms?: number; deliver_ms?: number };
};
export type LinkState = "connecting" | "connected" | "lost" | "refused" | "closed";
export type Unavailable = MicProblem | "server_down";

/** Why a delivery failed, as the history says it. */
export function reason(error: unknown): string {
  switch (errors.name(error)) {
    case "NoViewer":
      return "no viewer attached";
    case "NoFocusedPane":
      return "no focused pane";
    case "VoicePane":
      return "focused pane is the voice pane";
    case "Timeout":
      return "timed out";
    case "NotConnected":
    case "ConnectionClosed":
    case "NoRuntime":
    case "VoiceGone":
      return "not connected";
    case "ServerDown":
      return "server crashed";
    default:
      return errors.name(error) ?? String(error);
  }
}
/** Refusals that retrying cannot fix. */
const refusals = new Set(["VoiceAttached", "DaemonLacksVoice", "RemoteTooOld", "RemoteMissing"]);

export class VoiceSession {
  history: Utterance[] = [];
  muted = false;
  link_state: LinkState = "connecting";
  /** Why the runtime refused this voice, once `link_state` is "refused". */
  refused: string | null = null;
  /** A crashed server stays crashed: it is never restarted. */
  server: "ready" | "crashed" = "ready";
  private mic: MicProblem | null = null;
  /** The last frame's level on the threshold scale. */
  level = 0;
  /** How far into the silence window the utterance in progress is, 0 to 1. */
  pause = 0;
  /** Whether the runtime has a viewer to type into (without one, voice holds
   * off), and the title of the pane text would go to. */
  viewer = true;
  focus: string | null = null;
  private link: VoiceLink | null = null;
  private next_id = 1;
  private current: Utterance | null = null;
  private transcriptions: Promise<void> = Promise.resolve();
  private deliveries: Promise<void> = Promise.resolve();
  private retry?: ReturnType<typeof setTimeout>;
  private resend?: ReturnType<typeof setTimeout>;
  private quit = new AbortController();
  private listeners: (() => void)[] = [];
  constructor(
    private deps: {
      /** Connects; `signal` aborts an attempt still in progress when voice mode quits. */
      link: (signal: AbortSignal) => Promise<VoiceLink>;
      transcriber: Pick<Server, "transcribe" | "on">;
      segmenter: Segmenter;
      now: () => number;
      deliverTimeoutMs?: number;
      retryMs?: number;
      /** The voice process's own pane, when it runs inside the target runtime. */
      pane?: number;
      log?: (line: string) => void;
    },
  ) {
    deps.transcriber.on("crashed", () => this.crashed());
  }
  get available(): boolean {
    return !this.mic && this.server === "ready";
  }
  /** Why voice cannot listen; the server going down outranks the microphone. */
  get unavailable(): Unavailable | null {
    return this.server === "crashed" ? "server_down" : this.mic;
  }
  on(_event: "change", fn: () => void): void {
    this.listeners.push(fn);
  }
  private changed(): void {
    for (const fn of this.listeners) fn();
  }
  /** Attaches to the runtime, or throws what went wrong. A failure that a
   * retry can fix schedules one, so a caller that gives up must close(). */
  async connect(): Promise<void> {
    if (this.link_state === "closed") return;
    this.link_state = "connecting";
    this.changed();
    let link: VoiceLink | null = null;
    try {
      link = await this.deps.link(this.quit.signal);
      if (this.isClosed()) return link.close();
      const attached = link,
        sent = { muted: this.muted, available: this.available };
      attached.on("muted", muted => this.applyMuted(muted));
      attached.on("viewer", state => this.applyViewer(state));
      attached.on("closed", why => this.lost(attached, why));
      const reply = await attached.watch({ pane: this.deps.pane, ...sent });
      if (this.isClosed()) return attached.close();
      this.applyViewer(reply);
      this.link = attached;
      this.link_state = "connected";
      this.deps.log?.("link: connected");
      // A change made while the watch was on its way still has to go out.
      if (sent.muted !== this.muted || sent.available !== this.available) this.push();
      this.changed();
    } catch (error) {
      link?.close();
      if (this.isClosed()) return;
      if (refusals.has(errors.name(error) ?? "")) {
        this.link_state = "refused";
        this.refused = errors.name(error);
      } else {
        this.link_state = "lost";
        this.schedule();
      }
      this.deps.log?.(`link: ${errors.name(error) ?? error}`);
      this.changed();
      throw error;
    }
  }
  /** Checked again after each wait: quitting can happen meanwhile. */
  private isClosed(): boolean {
    return this.link_state === "closed";
  }
  private lost(link: VoiceLink, why: string): void {
    if (this.link !== link || this.link_state === "closed") return;
    this.link = null;
    this.link_state = "lost";
    this.deps.log?.(`link: lost (${why})`);
    this.changed();
    this.schedule();
  }
  private schedule(): void {
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.connect().catch(() => {}), this.deps.retryMs ?? 5000);
  }
  frame(f: Int16Array): void {
    this.level = level.rmsToPercent(level.rms(f));
    // Frames again after a microphone failure: it is back.
    if (this.mic) this.setAvailable(true, null);
    if (this.muted || !this.available || !this.viewer) {
      this.pause = 0;
      return;
    }
    const done = this.deps.segmenter.push(f);
    this.pause = this.deps.segmenter.pause;
    for (const segment of done) this.segmented(segment);
    if (this.deps.segmenter.recording && !this.current) {
      this.current = this.utterance("recording");
      this.changed();
    } else if (!this.deps.segmenter.recording && this.current) {
      // Too little speech to count.
      this.current.status = "dropped";
      this.current.reason = "too short";
      this.current = null;
      this.changed();
    }
  }
  private utterance(status: UtteranceStatus): Utterance {
    const u: Utterance = {
      id: this.next_id++,
      captured_at: this.deps.now(),
      duration: 0,
      status,
      text: null,
      reason: null,
      timings: {},
    };
    this.history.push(u);
    if (this.history.length > 500) this.history.splice(0, this.history.length - 500);
    return u;
  }
  private segmented(segment: Segment): void {
    const u = this.current ?? this.utterance("recording");
    this.current = null;
    u.captured_at = segment.started_at;
    u.duration = segment.duration;
    u.status = "transcribing";
    this.changed();
    this.transcriptions = this.transcriptions.then(() => this.transcribe(u, segment));
  }
  private async transcribe(u: Utterance, segment: Segment): Promise<void> {
    if (u.status !== "transcribing") return;
    const started = this.deps.now();
    let heard: string;
    try {
      heard = await this.deps.transcriber.transcribe(wav.encode(segment.pcm));
    } catch (error) {
      if (u.status === "transcribing")
        this.finish(u, "failed", this.server === "crashed" ? "server crashed" : reason(error));
      return;
    }
    u.timings.transcribe_ms = this.deps.now() - started;
    if (u.status !== "transcribing") return;
    const cleaned = text.clean(heard);
    if (cleaned === null) return this.finish(u, "dropped", heard.trim() ? "not speech" : "empty");
    u.text = cleaned;
    this.changed();
    this.deliveries = this.deliveries.then(() => this.deliver(u));
  }
  private async deliver(u: Utterance): Promise<void> {
    if (u.status !== "transcribing") return;
    const link = this.link;
    if (!link || this.link_state !== "connected") return this.finish(u, "failed", "not connected");
    u.status = "delivering";
    this.changed();
    const started = this.deps.now();
    try {
      await bounded(link.type(u.text!), this.deps.deliverTimeoutMs ?? 2000);
      u.timings.deliver_ms = this.deps.now() - started;
      this.finish(u, "delivered", null);
    } catch (error) {
      u.timings.deliver_ms = this.deps.now() - started;
      this.finish(u, "failed", reason(error));
    }
  }
  private finish(u: Utterance, status: UtteranceStatus, why: string | null): void {
    u.status = status;
    u.reason = why;
    const t = u.timings;
    this.deps.log?.(
      `utterance ${u.id}: ${status}${why ? ` (${why})` : ""} duration=${u.duration}s` +
        (t.transcribe_ms !== undefined ? ` transcribe_ms=${t.transcribe_ms}` : "") +
        (t.deliver_ms !== undefined ? ` deliver_ms=${t.deliver_ms}` : ""),
    );
    this.changed();
  }
  /** Mute or unmute from this side; the runtime hears of it. */
  setMuted(muted: boolean): void {
    if (!muted && !this.available) return;
    this.applyMuted(muted);
    this.push();
  }
  /** Tells the runtime this side's state, again a second later until it took it. */
  private push(): void {
    clearTimeout(this.resend);
    const link = this.link;
    if (!link) return;
    void link.set({ muted: this.muted, available: this.available }).catch(() => {
      if (this.link === link) this.resend = setTimeout(() => this.push(), 1000);
    });
  }
  /** Mute from either side drops what was not yet delivered. */
  private applyMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    if (muted) this.discard("muted");
    this.changed();
  }
  /** A viewer attached or went away; what is said meanwhile has nowhere to go. */
  private applyViewer(state: Seen): void {
    if (this.viewer === state.viewer && this.focus === state.focus) return;
    if (this.viewer && !state.viewer) this.discard("no viewer");
    this.viewer = state.viewer;
    this.focus = state.focus;
    this.changed();
  }
  /** Speech is being recorded, or waits for Whisper. */
  get recording(): boolean {
    return this.history.some(u => u.status === "recording");
  }
  get transcribing(): boolean {
    return this.history.some(u => u.status === "transcribing");
  }
  private discard(why: string): void {
    this.deps.segmenter.abort();
    this.current = null;
    for (const u of this.history)
      if (u.status === "recording" || u.status === "transcribing") {
        u.status = "discarded";
        u.reason = why;
      }
  }
  /** The microphone stopped (`available` false, and why) or came back. */
  setAvailable(available: boolean, why: MicProblem | null): void {
    const next = available ? null : (why ?? "mic_missing");
    if (this.mic === next) return;
    const was = this.available;
    this.mic = next;
    this.availability(was);
  }
  private availability(was: boolean): void {
    if (!this.available) {
      this.deps.segmenter.abort();
      if (this.current) this.current.status = "dropped";
      this.current = null;
    }
    this.deps.log?.(this.available ? "listening again" : `cannot listen: ${this.unavailable}`);
    if (was !== this.available) this.push();
    this.changed();
  }
  private crashed(): void {
    const was = this.available;
    this.server = "crashed";
    // Text already transcribed can still be delivered.
    for (const u of this.history)
      if ((u.status === "transcribing" && u.text === null) || u.status === "recording") {
        u.status = "failed";
        u.reason = "server crashed";
      }
    this.availability(was);
  }
  close(): void {
    this.link_state = "closed";
    this.quit.abort();
    clearTimeout(this.retry);
    clearTimeout(this.resend);
    this.link?.close();
    this.link = null;
  }
}
