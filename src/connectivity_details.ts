import * as palette from "./palette";
import * as text from "./text";
import { latencyBands, type Stats } from "./connection_stats";

export interface Connection {
  name: string;
  stats: Stats;
  description(): string;
}
export interface Line {
  text: string;
  color?: palette.Token;
  control?: number;
  heading?: boolean;
  heat?: { counts: number[]; cellWidth: number; color: palette.Token };
}
const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`);

/** The same recent measurements in the machine card and developer console. */
export function lines(connection: Connection, width: number, now = performance.now()): Line[] {
  const history = connection.stats.recent(now);
  const count = history.reduce((n, s) => n + s.count, 0);
  const mean = history.reduce((n, s) => n + s.sum, 0) / (count || 1);
  const sd = Math.sqrt(Math.max(0, history.reduce((n, s) => n + s.squares, 0) / (count || 1) - mean * mean));
  const peak = Math.max(0, ...history.map(s => s.max));
  const failures = history.reduce((n, s) => n + s.failed, 0);
  const recent = history.filter(s => s.at >= Math.floor(now / 1000) - 4);
  const rate = (key: "received" | "sent") => (recent.reduce((n, s) => n + s[key], 0) / 5 / 1024).toFixed(1) + " KiB/s";
  const out: Line[] = [
    { text: `${connection.name} · ${connection.description()}`, color: "strong", heading: true },
    { text: "" },
    { text: count ? `Response  ${ms(mean)} ± ${ms(sd)} (peak ${ms(peak)})` : "Response  —" },
    { text: `Receive   ${rate("received")}    Send ${rate("sent")}` },
    { text: `Replies   ${count}    Failed ${failures}    Pending ${connection.stats.pending}` },
    { text: "" },
    { text: "Response history · 2 min", color: "strong", heading: true },
  ];
  const labelWidth = 11;
  const available = Math.max(1, width - labelWidth);
  const columns = [24, 12, 6, 3, 1].find(n => n <= available)!;
  const cellWidth = Math.max(1, Math.min(3, Math.floor(available / columns)));
  const interval = 120 / columns;
  const last = Math.floor(now / 1000 / interval) * interval;
  const bins = Array.from({ length: columns }, (_, i) => {
    const from = last - (columns - 1 - i) * interval;
    const group = history.filter(s => s.at >= from && s.at < from + interval);
    return {
      latency: latencyBands.map((_, band) => group.reduce((sum, s) => sum + s.latency[band], 0)),
      failed: group.reduce((sum, s) => sum + s.failed, 0),
    };
  });
  for (let band = latencyBands.length - 1; band >= 0; band--)
    out.push({
      text: latencyBands[band].label.padStart(labelWidth - 1) + " ",
      color: "muted",
      heat: { counts: bins.map(b => b.latency[band]), cellWidth, color: "accent" },
    });
  out.push({
    text: "Failed".padStart(labelWidth - 1) + " ",
    color: "muted",
    heat: { counts: bins.map(b => b.failed), cellWidth, color: "warm" },
  });
  out.push({
    text: " ".repeat(labelWidth) + "2m ago" + "now".padStart(Math.max(4, columns * cellWidth - 6)),
    color: "muted",
  });
  return out;
}

export function heat(line: Line, x: number, y: number, width: number): string {
  if (!line.heat) return "";
  const { counts, cellWidth, color } = line.heat;
  const offset = text.displayWidth(line.text);
  let out = "";
  counts.forEach((count, column) => {
    const length = Math.min(cellWidth, width - offset - column * cellWidth);
    if (length <= 0) return;
    const strength = count ? Math.min(85, 30 + Math.floor(Math.log2(count)) * 18) : 0;
    const bg = palette.mix(palette.colors.selected, palette.colors[color], strength);
    out += `\x1b[${y + 1};${x + offset + column * cellWidth + 1}H${palette.bgRgb(bg)}${" ".repeat(length)}`;
  });
  return out;
}
