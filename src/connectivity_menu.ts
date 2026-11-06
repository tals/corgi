import type { Endpoint } from "./machine_connection";
import * as palette from "./palette";
import * as text from "./text";
import * as lab from "./remote_lab";
import * as details from "./connectivity_details";
import type { Line } from "./connectivity_details";

/** Developer diagnostics remain local even when every daemon is unavailable. */
export class Menu {
  open = false;
  selected = 0;
  row = 0;
  private focus: "machines" | "details" = "machines";
  private faults: Record<string, lab.Faults> = {};
  private pending = false;
  private commands: lab.Command[] = [];
  private next = 0;
  private error = "";
  private outage = 5;
  private x = 0;
  private y = 0;
  private width = 0;
  private height = 0;
  private nav = 0;
  private scroll = 0;
  private navScroll = 0;
  private lines: Line[] = [];
  constructor(
    private readonly endpoints: Endpoint[],
    private readonly socket = process.env.CORGI_REMOTE_LAB,
  ) {}
  toggle(selected: number): void {
    this.open = !this.open;
    this.selected = Math.max(0, Math.min(this.endpoints.length - 1, selected));
    this.focus = "machines";
    this.scroll = 0;
  }
  tick(): void {
    if (this.open && this.socket && !this.pending && Date.now() >= this.next) this.command({});
  }
  private command(command: lab.Command): void {
    if (!this.socket) return;
    if (this.pending) {
      if (Object.keys(command).length) this.commands.push(command);
      return;
    }
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
        const queued = this.commands.shift();
        if (queued) this.command(queued);
      });
  }
  private change(value: number): void {
    const machine = this.endpoints[this.selected]?.name;
    if (!machine || !this.faults[machine]) return;
    switch (this.row) {
      case 0:
        this.command({ machine, latency_ms: Math.round(value * 2000) });
        break;
      case 1:
        this.command({ machine, bandwidth_kib: Math.round(value * 4096) });
        break;
      case 2:
        this.command({ machine, hang_seconds: Math.round(value * 60) });
        break;
      case 3:
        this.command({ machine, hang_every_seconds: Math.round(value * 120) });
        break;
      case 4:
        this.outage = Math.round(value * 60);
        break;
      case 5:
        this.command({ machine, outage_seconds: this.outage });
        break;
      case 6:
        this.command({ machine, drop: true });
        break;
      case 7:
        this.command({ machine, latency_ms: 0, bandwidth_kib: 0, outage_seconds: 0, hang_every_seconds: 0 });
        break;
    }
  }
  private select(delta: number): void {
    this.selected = (this.selected + delta + this.endpoints.length) % this.endpoints.length;
    this.scroll = 0;
  }
  private reveal(): void {
    const at = this.lines.findIndex(line => line.control === this.row);
    if (at < 0) return;
    if (at < this.scroll) this.scroll = at;
    if (at >= this.scroll + this.height - 4) this.scroll = Math.max(0, at - this.height + 5);
  }
  key(value: string, cp: number | null): void {
    if (cp === 27 || value === "q" || value === "~") {
      this.open = false;
      return;
    }
    if (cp === 9 || value === "\x1b[Z") {
      this.focus = this.focus === "machines" ? "details" : "machines";
      if (this.focus === "details") this.reveal();
      return;
    }
    const up = value === "\x1b[A" || cp === 57352;
    const down = value === "\x1b[B" || cp === 57353;
    const right = value === "\x1b[C" || cp === 57351;
    const left = value === "\x1b[D" || cp === 57350;
    if (this.focus === "machines") {
      if (up || down) this.select(up ? -1 : 1);
      if (right || cp === 13) {
        this.focus = "details";
        this.reveal();
      }
      return;
    }
    if (value === "\x1b[5~" || value === "\x1b[6~") {
      this.scroll += value === "\x1b[5~" ? -5 : 5;
      return;
    }
    if (up || down) {
      this.row = (this.row + (up ? 7 : 1)) % 8;
      this.reveal();
    }
    const fault = this.faults[this.endpoints[this.selected]?.name];
    if (!fault) return;
    if ((cp === 13 || value === " ") && this.row >= 5) this.change(0);
    if ((right || left) && this.row < 5) {
      const max = [2000, 4096, 60, 120, 60][this.row];
      const current = [
        fault.latency_ms,
        fault.bandwidth_kib,
        fault.hang_seconds,
        fault.hang_every_seconds,
        this.outage,
      ][this.row];
      const step = [50, 128, 1, 5, 1][this.row];
      this.change(Math.max(0, Math.min(1, (current + (right ? step : -step)) / max)));
    }
  }
  mouse(x: number, y: number, button: number, pressed: boolean): void {
    if (!pressed) return;
    if (x < this.x || x >= this.x + this.width || y < this.y || y >= this.y + this.height) {
      if (button === 0) this.open = false;
      return;
    }
    if (y === this.y && x >= this.x + this.width - 5 && button === 0) {
      this.open = false;
      return;
    }
    if (x < this.x + this.nav) {
      if (button === 64 || button === 65) this.select(button === 64 ? -1 : 1);
      const index = y - this.y - 3 + this.navScroll;
      if (button === 0 && y >= this.y + 3 && y < this.y + this.height - 1 && index < this.endpoints.length) {
        this.selected = index;
        this.focus = "machines";
        this.scroll = 0;
      }
      return;
    }
    if (button === 64 || button === 65) {
      this.scroll += button === 64 ? -3 : 3;
      return;
    }
    if (y < this.y + 2 || y >= this.y + this.height - 2) return;
    const line = this.lines[y - this.y - 2 + this.scroll];
    if (line?.control === undefined || (button !== 0 && button !== 32)) return;
    this.focus = "details";
    this.row = line.control;
    const start = this.x + this.nav + 2 + this.sliderLabel();
    if (this.row < 5 && x >= start)
      this.change(Math.max(0, Math.min(1, (x - start) / Math.max(1, this.detailWidth() - this.sliderLabel() - 1))));
    else if (this.row >= 5 && button === 0) this.change(0);
  }
  private detailWidth(): number {
    return Math.max(1, this.width - this.nav - 4);
  }
  private sliderLabel(): number {
    return Math.min(28, Math.max(10, this.detailWidth() - 12));
  }
  draw(cols: number, rows: number): string {
    const endpoint = this.endpoints[this.selected];
    if (!endpoint || cols < 1 || rows < 1) return "";
    this.width = Math.min(112, cols);
    this.height = Math.min(38, rows);
    this.x = Math.max(0, Math.floor((cols - this.width) / 2));
    this.y = Math.max(0, Math.floor((rows - this.height) / 2));
    this.nav = Math.min(Math.floor(this.width / 2), 22, Math.max(14, Math.floor(this.width / 4)));
    const width = this.detailWidth(),
      now = performance.now();
    const seconds = (n: number) => `${Math.max(0, Math.ceil((n - Date.now()) / 1000))} s`;
    const lines = details.lines(endpoint, width, now);
    const add = (value: string, color: palette.Token = "text", heading = false) =>
      lines.push({ text: value, color, heading });
    const fault = this.faults[endpoint.name];
    const slider = (control: number, label: string, value: number) => {
      const labelWidth = this.sliderLabel(),
        length = Math.max(1, width - labelWidth);
      const at = Math.max(0, Math.min(length - 1, Math.round(value * (length - 1))));
      lines.push({
        control,
        text:
          text.ellipsis(label, labelWidth - 1).padEnd(labelWidth) + "─".repeat(at) + "●" + "─".repeat(length - at - 1),
      });
    };
    if (fault) {
      add("");
      add("Network policy", "strong", true);
      slider(0, `One-way lag    ${fault.latency_ms} ms`, fault.latency_ms / 2000);
      slider(1, `KiB/s / way    ${fault.bandwidth_kib || "unlimited"}`, fault.bandwidth_kib / 4096);
      slider(2, `Hang duration  ${fault.hang_seconds} s`, fault.hang_seconds / 60);
      slider(
        3,
        `Repeat every   ${fault.hang_every_seconds ? fault.hang_every_seconds + " s" : "off"}`,
        fault.hang_every_seconds / 120,
      );
      add(
        fault.outage_until
          ? `Traffic held · ${seconds(fault.outage_until)} remaining`
          : fault.next_hang_at
            ? `Next hang in ${seconds(fault.next_hang_at)}`
            : "Traffic flowing · repeating hangs off",
        fault.outage_until ? "warm" : "muted",
      );
      add("");
      add("Inject a fault", "strong", true);
      slider(4, `Outage length  ${this.outage} s`, this.outage / 60);
      lines.push(
        { control: 5, text: "[ Start outage ]" },
        { control: 6, text: "[ Drop connections now ]" },
        { control: 7, text: "[ Reset network · disable repeats ]" },
      );
    }
    if (this.error) add(`Control error: ${this.error}`, "hot");
    this.lines = lines;
    const visible = Math.max(0, this.height - 4);
    this.scroll = Math.max(0, Math.min(this.scroll, lines.length - visible));
    this.navScroll = Math.max(0, Math.min(this.navScroll, this.selected));
    if (this.selected >= this.navScroll + this.height - 4)
      this.navScroll = Math.max(0, this.selected - this.height + 5);
    let out = "\x1b[?25l";
    const write = (
      x: number,
      y: number,
      length: number,
      value: string,
      fg: palette.Token = "text",
      bg: palette.Token = "surface",
      bold = false,
    ) => {
      length = Math.max(0, Math.min(length, this.width - x));
      if (x < 0 || y < 0 || y >= this.height || !length) return;
      const clipped = text.ellipsis(value, length);
      out += `\x1b[${this.y + y + 1};${this.x + x + 1}H\x1b[0m${palette.bg(bg)}${palette.fg(fg)}${bold ? "\x1b[1m" : ""}${clipped}${" ".repeat(Math.max(0, length - text.displayWidth(clipped)))}`;
    };
    for (let y = 0; y < this.height; y++) write(0, y, this.width, "");
    write(1, 0, this.width - 6, "Developer", "strong", "surface", true);
    write(this.width - 5, 0, 5, "[ × ]", "muted");
    write(1, 2, this.nav - 2, "Remote", "strong", "surface", true);
    for (let i = this.navScroll; i < this.endpoints.length && i - this.navScroll < this.height - 4; i++) {
      const selected = i === this.selected;
      write(
        1,
        3 + i - this.navScroll,
        this.nav - 2,
        `  ${this.endpoints[i].name}`,
        selected && this.focus === "machines" ? "accent" : "text",
        selected ? "selected" : "surface",
      );
    }
    for (let y = 2; y < this.height - 2; y++) write(this.nav, y, 1, "│", "line");
    lines.slice(this.scroll, this.scroll + visible).forEach((line, i) => {
      const active = line.control !== undefined && this.row === line.control && this.focus === "details";
      write(
        this.nav + 2,
        i + 2,
        width,
        line.text,
        active ? "accent" : (line.color ?? "text"),
        active ? "selected" : "surface",
        line.heading,
      );
      out += details.heat(line, this.x + this.nav + 2, this.y + i + 2, width);
    });
    write(
      1,
      this.height - 1,
      this.width - 2,
      "Esc close · Tab panel · ↑↓ select · ←→ adjust · Enter apply · scroll for more",
      "muted",
    );
    if (lines.length > visible)
      write(this.width - 2, this.height - 2, 1, this.scroll + visible < lines.length ? "↓" : "↑", "accent");
    return out + "\x1b[0m";
  }
}
