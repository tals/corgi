import type { Endpoint } from "./machine_connection";
import * as palette from "./palette";
import * as text from "./text";
import * as lab from "./remote_lab";

/** Developer diagnostics remain local even when every daemon is unavailable. */
export class Menu {
  open = false;
  selected = 0;
  row = 0;
  private faults: Record<string, lab.Faults> = {};
  private pending = false;
  private next = 0;
  private error = "";
  private outage = 5;
  private x = 0;
  private y = 0;
  private width = 0;
  constructor(
    private readonly endpoints: Endpoint[],
    private readonly socket = process.env.CORGI_REMOTE_LAB,
  ) {}
  toggle(selected: number): void {
    this.open = !this.open;
    this.selected = selected;
  }
  tick(): void {
    if (this.open && this.socket && !this.pending && Date.now() >= this.next) this.command({});
  }
  private command(command: lab.Command): void {
    if (!this.socket || this.pending) return;
    this.pending = true;
    void lab
      .request(this.socket, command)
      .then(
        value => {
          this.faults = value;
          this.error = "";
        },
        error => {
          this.error = error.message;
        },
      )
      .finally(() => {
        this.pending = false;
        this.next = Date.now() + 500;
      });
  }
  private change(value: number): void {
    const machine = this.endpoints[this.selected].name;
    if (!this.faults[machine]) return;
    switch (this.row) {
      case 0:
        this.command({ machine, latency_ms: Math.round(value * 2000) });
        break;
      case 1:
        this.command({ machine, bandwidth_kib: Math.round(value * 4096) });
        break;
      case 2:
        this.outage = Math.round(value * 60);
        break;
      case 3:
        this.command({ machine, outage_seconds: this.outage });
        break;
      case 4:
        this.command({ machine, drop: true });
        break;
      case 5:
        this.command({ machine, latency_ms: 0, bandwidth_kib: 0, outage_seconds: 0 });
        break;
    }
  }
  key(value: string, cp: number | null): void {
    if (cp === 27 || value === "q" || value === "~") {
      this.open = false;
      return;
    }
    if (cp === 9) {
      this.selected = (this.selected + 1) % this.endpoints.length;
      return;
    }
    if (value === "\x1b[A" || cp === 57352) this.row = (this.row + 5) % 6;
    if (value === "\x1b[B" || cp === 57353) this.row = (this.row + 1) % 6;
    const fault = this.faults[this.endpoints[this.selected].name];
    if ((cp === 13 || value === " ") && this.row >= 3) this.change(0);
    if (fault && (value === "\x1b[C" || value === "\x1b[D" || cp === 57350 || cp === 57351)) {
      const right = value === "\x1b[C" || cp === 57351;
      const current =
        this.row === 0 ? fault.latency_ms / 2000 : this.row === 1 ? fault.bandwidth_kib / 4096 : this.outage / 60;
      this.change(Math.max(0, Math.min(1, current + (right ? 0.025 : -0.025))));
    }
  }
  mouse(x: number, y: number, button: number, pressed: boolean): void {
    if (!pressed) return;
    if (x < this.x || x >= this.x + this.width || y < this.y || y >= this.y + 23) {
      if (button === 0) this.open = false;
      return;
    }
    if (y === this.y + 1 && button === 0) {
      this.selected = (this.selected + 1) % this.endpoints.length;
      return;
    }
    const row = y - this.y - 15;
    if (row < 0 || row > 5 || (button !== 0 && button !== 32)) return;
    this.row = row;
    if (row < 3 || button === 0)
      this.change(Math.max(0, Math.min(1, (x - this.x - 24) / Math.max(1, this.width - 28))));
  }
  draw(cols: number, rows: number): string {
    const endpoint = this.endpoints[this.selected];
    const now = performance.now(),
      history = endpoint.stats.recent(now);
    const samples = history.filter(s => s.count > 0);
    const count = samples.reduce((n, s) => n + s.count, 0);
    const mean = samples.reduce((n, s) => n + s.sum, 0) / (count || 1);
    const sd = Math.sqrt(Math.max(0, samples.reduce((n, s) => n + s.squares, 0) / (count || 1) - mean * mean));
    const recent = history.filter(s => s.at >= Math.floor(now / 1000) - 4);
    const rate = (key: "received" | "sent") => (recent.reduce((n, s) => n + s[key], 0) / 5 / 1024).toFixed(1);
    this.width = Math.min(78, cols);
    this.x = Math.max(0, Math.floor((cols - this.width) / 2));
    this.y = Math.max(0, Math.floor((rows - 23) / 2));
    const width = Math.max(1, this.width - 4),
      last = Math.floor(now / 1000);
    const chart = new Map(history.map(s => [s.at, s]));
    const graph = Array.from({ length: width }, (_, i) => {
      const s = chart.get(last - width + i + 1);
      return !s
        ? " "
        : s.failed
          ? "×"
          : s.count
            ? "▁▂▃▄▅▆▇█"[Math.min(7, Math.floor(Math.log10(1 + s.sum / s.count) * 2))]
            : "·";
    }).join("");
    const fault = this.faults[endpoint.name];
    const slider = (name: string, value: number, label: string) => {
      const n = Math.max(2, this.width - 28),
        at = Math.round(value * (n - 1));
      return `${text.ellipsis(name + " " + label, 22).padEnd(22)}${"─".repeat(at)}●${"─".repeat(n - at - 1)}`;
    };
    const lines = [
      "Developer · connectivity",
      `${endpoint.name}  [Tab / click to change machine]`,
      endpoint.description(),
      `RPC latency: ${count ? `${mean.toFixed(1)} ± ${sd.toFixed(1)} ms` : "no replies yet"} (includes daemon work)`,
      `Peak ${Math.max(0, ...samples.map(s => s.max)).toFixed(0)} ms · ${count} replies · ${history.reduce((n, s) => n + s.failed, 0)} failed requests`,
      `Pending ${endpoint.stats.pending} · Connections opened ${endpoint.stats.connections}`,
      `Received ${rate("received")} KiB/s · Sent ${rate("sent")} KiB/s (5 s average)`,
      `Last received: ${endpoint.stats.lastReceived === null ? "never" : `${((now - endpoint.stats.lastReceived) / 1000).toFixed(1)} s ago`}`,
      "",
      graph,
      `← ${width} s · RPC latency, logarithmic · × failed request · now →`,
      `Stall budget ${(endpoint.stallMs / 1000).toFixed(1)} s · fresh-path probe ${(endpoint.raceMs / 1000).toFixed(1)} s`,
      "",
      this.error,
      fault
        ? "Sandbox faults · one-way delay; 0 bandwidth = unlimited"
        : "Fault injection is available only for sandbox machines.",
      ...(fault
        ? [
            slider("Latency", fault.latency_ms / 2000, `${fault.latency_ms} ms`),
            slider("Bandwidth / direction", fault.bandwidth_kib / 4096, `${fault.bandwidth_kib} KiB/s`),
            slider("Outage duration", this.outage / 60, `${this.outage} s`),
            `[ Start outage ]  ${Math.max(0, Math.ceil((fault.outage_until - Date.now()) / 1000))} s remaining`,
            "[ Drop connections now ]",
            "[ Reset network ]",
          ]
        : ["", "", "", "", "", ""]),
      "Esc close · Tab machine · ↑↓ control · ←→ adjust · Enter apply",
      "",
    ];
    return (
      "\x1b[?25l" +
      lines
        .slice(0, Math.max(0, rows - this.y))
        .map((line, i) => {
          const style = palette.bg("surface") + palette.fg(i === 15 + this.row && fault ? "accent" : "text");
          const clipped = text.ellipsis(line, Math.max(0, this.width - 2));
          return `\x1b[${this.y + i + 1};${this.x + 1}H${style} ${clipped}${" ".repeat(Math.max(0, this.width - 1 - text.displayWidth(clipped)))}`;
        })
        .join("") +
      "\x1b[0m"
    );
  }
}
