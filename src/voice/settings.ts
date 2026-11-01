//! voice.json: voice mode's settings on the machine with the microphone.
//! Each field is checked on its own; a bad one falls back to its default
//! with a notice, and never costs the rest of the file.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as models from "./models";
import * as level from "./level";
import { default_timing } from "./segmenter";

export type VoiceSettings = {
  threshold: number;
  silence: number;
  pre_roll: number;
  min_speech: number;
  burst: number;
  model: models.ModelName;
  /** null picks a free port each run. */
  port: number | null;
  speech_filter: boolean;
  device: string | null;
};
export type VoiceFlags = Partial<VoiceSettings>;

export const defaults = (): VoiceSettings => ({
  threshold: level.default_threshold,
  ...default_timing,
  model: models.default_model,
  port: null,
  speech_filter: true,
  device: null,
});
export function path(): string {
  if (process.env.XDG_STATE_HOME) return join(process.env.XDG_STATE_HOME, "corgi", "voice.json");
  if (!process.env.HOME) throw Error("NoHome");
  return join(process.env.HOME, ".local", "state", "corgi", "voice.json");
}
export function read(file: string): { settings: VoiceSettings; notices: string[] } {
  const settings = defaults(),
    notices: string[] = [];
  let data: unknown;
  try {
    if (statSync(file).size > 64 * 1024) return { settings, notices: ["voice.json is over 64 KiB; using defaults"] };
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { settings, notices };
    return { settings, notices: ["voice.json is not valid JSON; using defaults"] };
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    return { settings, notices: ["voice.json is not an object; using defaults"] };
  const d = data as Record<string, unknown>;
  const field = <K extends keyof VoiceSettings>(
    key: K,
    rule: string,
    parse: (v: unknown) => VoiceSettings[K] | null,
  ) => {
    if (!Object.hasOwn(d, key)) return;
    const value = parse(d[key]);
    if (value === null) notices.push(`voice.json: "${key}" must be ${rule}; using ${JSON.stringify(settings[key])}`);
    else settings[key] = value;
  };
  field("threshold", "0..100", v =>
    Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100 ? (v as number) : null,
  );
  const seconds = (min: number, max: number) => (v: unknown) =>
    typeof v === "number" && v >= min && v <= max ? v : null;
  field("silence", "0.5..10", seconds(0.5, 10));
  field("pre_roll", "0..2", seconds(0, 2));
  field("min_speech", "0.02..2", seconds(0.02, 2));
  field("burst", "0.02..1", seconds(0.02, 1));
  field("model", models.names.join("|"), v => (typeof v === "string" ? models.parseName(v) : null));
  // null, the default, may also be written out.
  if (d.port !== null)
    field("port", "1024..65535 or null", v =>
      Number.isInteger(v) && (v as number) >= 1024 && (v as number) <= 65535 ? (v as number) : null,
    );
  field("speech_filter", "true or false", v => (typeof v === "boolean" ? v : null));
  if (Object.hasOwn(d, "device")) {
    if (d.device === null || (typeof d.device === "string" && d.device.trim()))
      settings.device = d.device as string | null;
    else notices.push(`voice.json: "device" must be a device name or null; using null`);
  }
  return { settings, notices };
}
/** The settings for this run: flags override the file. */
export function merge(settings: VoiceSettings, flags: VoiceFlags): VoiceSettings {
  const out = { ...settings };
  for (const [key, value] of Object.entries(flags)) if (value !== undefined) (out as any)[key] = value;
  return out;
}
