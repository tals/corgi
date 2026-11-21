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
    const now = performance.now();
    if (this.started === null) {
      this.stage = null;
      this.started = now;
    } else if (now - this.tick < 500 && sent !== total) return;
    this.tick = now;
    const percent = total ? Math.floor((100 * sent) / total) : 100;
    const rate = (sent * 1000) / Math.max(1, now - this.started);
    this.output("Uploading", {
      metrics: `${percent}% ${size(rate)}/s`,
      compact: "↑",
      detail: `${kind === "delta" ? "Compressed delta" : "Full executable"} · ${size(total)}`,
    });
  }
}
export function size(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const mib = bytes >= 1024 * 1024;
  const value = bytes / (mib ? 1024 * 1024 : 1024);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${mib ? "MiB" : "KiB"}`;
}
