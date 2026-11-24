/** The compact status is also printed by the CLI. Extra detail belongs in the machine card. */
export interface Status {
  message: string;
  metrics?: string;
  compact?: string;
  detail?: string;
}
export type Report = (message: string, extra?: Omit<Status, "message">) => void;
export const print: Report = (message, extra) =>
  process.stderr.write([message, extra?.metrics].filter(Boolean).join(" ") + "\n");

export function elapsed(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}
export class Progress {
  private stage: string | null = null;
  private started: number | null = null;
  private tick = 0;
  constructor(private output: Report = print) {}
  show(stage: string, detail?: string): void {
    if (stage === this.stage) return;
    this.stage = stage;
    this.started = null;
    this.output(stage + "…", { detail });
  }
  uploaded(sent: number, total: number, kind: "delta" | "full"): void {
    this.moved("Uploading", "↑", sent, total, kind === "delta" ? "Compressed delta" : "Full executable");
  }
  /** A release the machine downloads itself, or, `here`, one this computer downloads for it. */
  downloaded(received: number, total: number, host: string, here = false): void {
    this.moved(
      "Downloading",
      "↓",
      received,
      total,
      here ? `Downloading the release here, as ${host} couldn't` : `Downloading the release on ${host}`,
    );
  }
  private moved(stage: string, compact: string, bytes: number, total: number, detail: string): void {
    const now = performance.now();
    if (this.started === null) {
      this.stage = null;
      this.started = now;
    } else if (now - this.tick < 500 && bytes !== total) return;
    this.tick = now;
    const percent = total ? Math.floor((100 * bytes) / total) : 100;
    const rate = (bytes * 1000) / Math.max(1, now - this.started);
    this.output(stage, { metrics: `${percent}% ${size(rate)}/s`, compact, detail: `${detail} · ${size(total)}` });
  }
}
export function size(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const mib = bytes >= 1024 * 1024;
  const value = bytes / (mib ? 1024 * 1024 : 1024);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${mib ? "MiB" : "KiB"}`;
}
