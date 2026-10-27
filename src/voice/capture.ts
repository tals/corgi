//! The microphone, through an ffmpeg process that writes 16 kHz mono s16le
//! to stdout: avfoundation on macOS, PulseAudio (or pipewire-pulse) on Linux.
import * as subprocess from "../subprocess";

export type MicProblem = "mic_missing" | "mic_denied" | "mic_busy";
export type Device = { id: string; label: string; default: boolean };

const frame_bytes = 640,
  retry_ms = 5000;

/** ffmpeg's arguments for `device`, or the system default. */
export function args(device: string | null, platform = process.platform): string[] {
  const input =
    platform === "darwin"
      ? ["-f", "avfoundation", "-i", `:${device ?? "default"}`]
      : ["-f", "pulse", "-i", device ?? "default"];
  return ["ffmpeg", "-hide_banner", "-loglevel", "error", ...input, "-f", "s16le", "-ac", "1", "-ar", "16000", "-"];
}
/** Why ffmpeg could not capture, from what it printed. */
export function classify(stderr: string): MicProblem {
  if (/not authori[sz]ed|permission denied|access denied|operation not permitted/i.test(stderr)) return "mic_denied";
  if (/busy/i.test(stderr)) return "mic_busy";
  return "mic_missing";
}
export class Capture {
  private child: ReturnType<typeof Bun.spawn> | null = null;
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private constructor(
    private device: string | null,
    private onFrame: (f: Int16Array) => void,
    private onProblem: (p: MicProblem) => void,
  ) {}
  /** Starts capturing; throws `FileNotFound` when there is no ffmpeg. A
   * microphone that fails later is reported and retried every 5 s. */
  static start(device: string | null, onFrame: (f: Int16Array) => void, onProblem: (p: MicProblem) => void): Capture {
    const capture = new Capture(device, onFrame, onProblem);
    capture.spawn();
    return capture;
  }
  private spawn(): void {
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn(args(this.device), { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (error) {
      throw subprocess.spawnError(error);
    }
    this.child = child;
    const stderr = new Response(child.stderr as ReadableStream).text();
    void this.read(child.stdout as ReadableStream<Uint8Array>);
    void child.exited.then(async () => {
      if (this.stopped || this.child !== child) return;
      this.child = null;
      this.onProblem(classify(await stderr.catch(() => "")));
      this.retry = setTimeout(() => {
        if (this.stopped || this.child) return;
        try {
          this.spawn();
        } catch {
          this.onProblem("mic_missing");
        }
      }, retry_ms);
    });
  }
  private async read(stream: ReadableStream<Uint8Array>): Promise<void> {
    let pending = new Uint8Array(0);
    try {
      for await (const chunk of stream) {
        const bytes = new Uint8Array(pending.length + chunk.length);
        bytes.set(pending);
        bytes.set(chunk, pending.length);
        let at = 0;
        for (; at + frame_bytes <= bytes.length; at += frame_bytes)
          this.onFrame(new Int16Array(bytes.slice(at, at + frame_bytes).buffer));
        pending = bytes.slice(at);
      }
    } catch {}
  }
  /** Captures from `device` instead; only the ffmpeg process restarts. */
  switch(device: string): void {
    this.device = device;
    clearTimeout(this.retry);
    const old = this.child;
    this.child = null;
    old?.kill();
    this.spawn();
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.child?.kill();
    this.child = null;
  }
}

/** The microphones to pick from, with the system default marked. */
export async function listDevices(platform = process.platform): Promise<{ devices: Device[]; notice?: string }> {
  try {
    const devices = platform === "darwin" ? await macDevices() : await pulseDevices();
    if (devices.length) return { devices };
  } catch {}
  return {
    devices: [{ id: "default", label: "System default", default: true }],
    notice: "Could not list microphones; using the system default",
  };
}
async function output(argv: string[], stderr = false): Promise<string> {
  const out = await subprocess.run(argv, { timeout_ms: 5000, stderr, env: process.env });
  return (stderr ? out.stderr : out.stdout).toString();
}
export function parseAvfoundation(stderr: string): { id: string; label: string }[] {
  const devices: { id: string; label: string }[] = [];
  let audio = false;
  for (const line of stderr.split("\n")) {
    if (/AVFoundation audio devices:/.test(line)) audio = true;
    else if (/AVFoundation video devices:/.test(line)) audio = false;
    else if (audio) {
      const match = /\[(\d+)\] (.+)$/.exec(line);
      if (match) devices.push({ id: match[1], label: match[2].trim() });
    }
  }
  return devices;
}
/** The default input's name from `system_profiler SPAudioDataType -json`. */
export function parseProfilerDefault(json: string): string | null {
  try {
    for (const group of JSON.parse(json).SPAudioDataType ?? [])
      for (const item of group._items ?? [])
        if (item.coreaudio_default_audio_input_device === "spaudio_yes") return item._name ?? null;
  } catch {}
  return null;
}
async function macDevices(): Promise<Device[]> {
  const [listing, profiler] = await Promise.all([
    output(["ffmpeg", "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], true),
    output(["system_profiler", "SPAudioDataType", "-json"]).catch(() => ""),
  ]);
  const fallback = parseProfilerDefault(profiler);
  return parseAvfoundation(listing).map(d => ({ ...d, default: d.label === fallback }));
}
export function parsePulse(sources: string, fallback: string): Device[] {
  return sources
    .split("\n")
    .map(line => line.split("\t")[1]?.trim() ?? "")
    .filter(name => name && !name.endsWith(".monitor"))
    .map(name => ({ id: name, label: name, default: name === fallback }));
}
async function pulseDevices(): Promise<Device[]> {
  const [sources, fallback] = await Promise.all([
    output(["pactl", "list", "short", "sources"]),
    output(["pactl", "get-default-source"]).catch(() => ""),
  ]);
  return parsePulse(sources, fallback.trim());
}
