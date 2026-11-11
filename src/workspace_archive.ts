import * as i18n from "./i18n";
import type { Action } from "./action";
import type { Target } from "./agent_order";
import type { State, Attention } from "./agents";
import type { Provider } from "./providers";
import * as sidebar from "./sidebar";
import * as processName from "./process_name";
import * as tabIcons from "./tab_icons";
import { Rect } from "./layout";
import { Style, keycap } from "./palette";
import { Writer, displayWidth, wrap, writeEllipsis } from "./text";

export type Agent = {
  target: Target;
  name: string;
  provider: Provider;
  activity: string;
  running: boolean;
  state: State;
  attention: Attention;
  paused: boolean;
  unread: boolean;
};
export type Preview = {
  workspace: number;
  name: string;
  agents: Agent[];
  processes: ({ pid: number } & processName.Program)[];
  processes_available: boolean;
  processes_partial: boolean;
  links: string[];
  links_available: boolean;
};
type Line = { text: string; heading?: boolean; agent?: Agent; brand?: processName.Brand | null; row?: boolean };
type Marks = (brand: processName.Brand, col: number, row: number) => string;
const printable = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export class Dialog {
  preview: Preview | null = null;
  failed = false;
  pending = false;
  offset = 0;
  selected: "cancel" | "confirm" | number = "cancel";
  constructor(
    public workspace: number,
    public name: string,
  ) {}
  lines(): Line[] {
    if (this.failed) return [{ text: i18n.t`Could not load workspace activity. Close and try again.` }];
    if (!this.preview) return [{ text: i18n.t`Reading workspace activity…` }];
    const p = this.preview,
      lines: Line[] = [];
    if (p.agents.length) {
      const count = p.agents.length;
      lines.push({ text: i18n.t`Agents (${count})`, heading: true });
      for (const agent of p.agents)
        lines.push({ text: printable(agent.name), agent, brand: processName.brandOf(agent.provider), row: true });
    }
    if (p.processes.length || !p.processes_available || p.processes_partial) {
      if (lines.length) lines.push({ text: "" });
      lines.push({ text: i18n.t`Processes`, heading: true });
      for (const process of p.processes) lines.push({ text: printable(process.name), brand: process.brand, row: true });
      if (!p.processes_available) lines.push({ text: i18n.t`Process information unavailable` });
      else if (p.processes_partial) lines.push({ text: i18n.t`Process list may be incomplete` });
    }
    if (p.links.length) {
      if (lines.length) lines.push({ text: "" });
      lines.push({ text: i18n.t`Served links`, heading: true });
      for (const link of p.links) lines.push({ text: printable(link) });
    }
    if (!lines.length) lines.push({ text: i18n.t`No active agents or processes.` });
    return lines;
  }
  selectedAgent(): Agent | null {
    return typeof this.selected === "number" ? (this.preview?.agents[this.selected] ?? null) : null;
  }
  move(next: boolean): void {
    const count = this.preview?.agents.length ?? 0;
    if (!count || this.pending) return;
    this.selected =
      typeof this.selected === "number" ? (this.selected + (next ? 1 : -1) + count) % count : next ? 0 : count - 1;
  }
  key(key: string): Action | null {
    switch (key) {
      case "\x1b":
      case "\x03":
        return { name: "archive-cancel" };
      case "a":
        return { name: "archive-confirm" };
      case "\r":
        return typeof this.selected === "number"
          ? { name: "archive-jump", value: this.selected }
          : { name: this.selected === "cancel" ? "archive-cancel" : "archive-confirm" };
      case "\t":
      case "shift_tab":
      case "left":
      case "right":
        return { name: "archive-toggle" };
      case "j":
      case "down":
        return { name: "archive-next" };
      case "page_down":
        return { name: "archive-scroll", value: "right" };
      case "k":
      case "up":
        return { name: "archive-prev" };
      case "page_up":
        return { name: "archive-scroll", value: "left" };
      default:
        return null;
    }
  }
  view(width: number, height: number, pane_area?: Rect): View {
    return new View(this, width, height, pane_area);
  }
}

export class View {
  box: Rect;
  lines: Line[];
  body_y: number;
  body_height: number;
  buttons_y: number;
  warning: string[];
  constructor(
    public dialog: Dialog,
    width: number,
    height: number,
    pane_area?: Rect,
  ) {
    const preview_area =
      height >= 24 && (!dialog.preview || dialog.preview.agents.some(agent => "pane" in agent.target))
        ? pane_area
        : undefined;
    const w = Math.min(76, Math.max(0, width - 2));
    const room = Math.max(1, w - 6);
    this.lines = dialog
      .lines()
      .flatMap(line =>
        line.row ? [line] : (line.text ? wrap(line.text, room) : [""]).map(text => ({ ...line, text })),
      );
    this.warning = wrap(
      i18n.t`Agents and processes will stop and release memory. Layout and history stay; unsaved state is lost.` +
        (dialog.preview?.links.length ? " " + i18n.t`Served links will go offline.` : ""),
      room,
    );
    const limit = preview_area ? preview_area.y + Math.floor(preview_area.h / 2) - 1 : Math.max(0, height - 2);
    const h = Math.min(limit, this.lines.length + this.warning.length + 7);
    this.warning = this.warning.slice(0, Math.max(1, h - 8));
    this.box = new Rect(Math.floor((width - w) / 2), preview_area ? limit - h : Math.floor((height - h) / 2), w, h);
    this.body_y = this.box.y + 3;
    this.body_height = Math.max(0, h - this.warning.length - 7);
    this.buttons_y = this.box.y + h - 2;
    dialog.offset = Math.min(Math.max(0, dialog.offset), Math.max(0, this.lines.length - this.body_height));
  }
  revealSelection(): void {
    const agent = this.dialog.selectedAgent();
    const row = this.lines.findIndex(line => line.agent === agent);
    if (row < 0 || this.body_height === 0) return;
    if (row < this.dialog.offset) this.dialog.offset = row;
    else if (row >= this.dialog.offset + this.body_height) this.dialog.offset = row - this.body_height + 1;
  }
  agentAt(x: number, y: number): number | null {
    if (x <= this.box.x || x >= this.box.x + this.box.w - 1 || y < this.body_y || y >= this.body_y + this.body_height)
      return null;
    const agent = this.lines[this.dialog.offset + y - this.body_y]?.agent;
    const index = agent ? this.dialog.preview!.agents.indexOf(agent) : -1;
    return index >= 0 ? index : null;
  }
  previewAgent(pointer: { x: number; y: number } | null): Agent | null {
    const hovered = pointer ? this.agentAt(pointer.x, pointer.y) : null;
    return hovered === null ? this.dialog.selectedAgent() : this.dialog.preview!.agents[hovered];
  }
  buttons() {
    const labels = [i18n.t`Cancel`, this.dialog.pending ? i18n.t`Archiving…` : i18n.t`Archive workspace`];
    let x = this.box.x + 3;
    return labels.map((label, i) => {
      const key = i === 1 && !this.dialog.pending ? "a" : "";
      const width = displayWidth(label) + 2 + (key ? 3 : 0),
        button = { x, width, label, key, name: i === 0 ? "archive-cancel" : "archive-confirm" } as const;
      x += width + 2;
      return button;
    });
  }
  hit(x: number, y: number): Action | null {
    const agent = this.agentAt(x, y);
    if (agent !== null) return { name: "archive-jump", value: agent };
    if (y !== this.buttons_y) return null;
    const button = this.buttons().find(b => x >= b.x && x < b.x + b.width && x < this.box.x + this.box.w - 1);
    return button ? { name: button.name } : null;
  }
  draw(w: Writer, marks: Marks | null = null, pointer: { x: number; y: number } | null = null): void {
    const b = this.box;
    if (b.w < 8 || b.h < 8) return;
    const panel = new Style({ fg: "text", bg: "surface" }).sgr();
    const border = new Style({ fg: "line", bg: "surface" }).sgr();
    const strong = new Style({ fg: "strong", bg: "surface", bold: true }).sgr();
    const muted = new Style({ fg: "muted", bg: "surface" }).sgr();
    for (let row = 0; row < b.h; row++) {
      w.write(`\x1b[${b.y + row + 1};${b.x + 1}H${border}`);
      w.write(
        row === 0
          ? "╭" + "─".repeat(b.w - 2) + "╮"
          : row === b.h - 1
            ? "╰" + "─".repeat(b.w - 2) + "╯"
            : "│" + panel + " ".repeat(b.w - 2) + border + "│",
      );
    }
    const line = (y: number, text: string, style = panel) => {
      w.write(`\x1b[${y + 1};${b.x + 4}H${style}`);
      writeEllipsis(w, text, b.w - 6);
    };
    const name = printable(this.dialog.name);
    line(b.y + 1, i18n.t`Archive ${name}?`, strong);
    this.lines.slice(this.dialog.offset, this.dialog.offset + this.body_height).forEach((l, i) => {
      const y = this.body_y + i;
      if (!l.row) return line(y, l.text, l.heading ? strong : panel);
      const selected = l.agent !== undefined && l.agent === this.dialog.selectedAgent();
      const hovered = pointer !== null && pointer.y === y && this.agentAt(pointer.x, y) !== null;
      const ink = new Style({
        bg: selected || hovered ? "selected" : "surface",
        fg: selected || hovered || l.agent?.unread ? "strong" : "text",
        bold: selected,
      }).sgr();
      w.write(`\x1b[${y + 1};${b.x + 2}H` + ink + " ".repeat(b.w - 2));
      const x = b.x + 3,
        status = l.agent ? sidebar.indicator(l.agent, true) : null;
      if (status) w.write(`\x1b[${y + 1};${x + 1}H` + ink + status.color + status.icon);
      const left = x + 2 + (marks ? tabIcons.cols + 1 : 0);
      w.write(`\x1b[${y + 1};${left + 1}H` + ink);
      writeEllipsis(w, l.text, Math.max(0, b.x + b.w - 3 - left));
      if (marks && l.brand && left < b.x + b.w - 3) w.write(marks(l.brand, x + 2, y));
    });
    const warning_y = this.buttons_y - this.warning.length - 1;
    this.warning.forEach((text, i) => line(warning_y + i, text, muted));
    if (this.dialog.preview?.agents.length) {
      const hidden = this.lines.slice(this.dialog.offset + this.body_height).filter(line => line.agent).length;
      const more = hidden > 0 ? i18n.t`... ${hidden} more agents` : "";
      const hint = this.dialog.selectedAgent()
        ? i18n.t`↑↓ Select · Enter Open · Tab Actions`
        : i18n.t`↑↓ Preview agents · PgUp/PgDn Scroll`;
      line(warning_y - 1, more ? more + " · " + hint : hint, muted);
    } else if (this.lines.length > this.body_height) line(warning_y - 1, i18n.t`↑ ↓ Scroll to see all activity`, muted);
    for (const [i, button] of this.buttons().entries()) {
      const selected = this.dialog.selected === (i === 0 ? "cancel" : "confirm");
      const style = new Style({
        fg: selected ? "strong" : "muted",
        bg: selected ? "selected" : "surface",
        bold: selected,
      }).sgr();
      let room = Math.max(0, Math.min(button.width, b.x + b.w - 2 - button.x));
      w.write(`\x1b[${this.buttons_y + 1};${button.x + 1}H` + style);
      if (button.key && room >= 3) {
        w.write(keycap + ` ${button.key} ` + style);
        room -= 3;
      }
      writeEllipsis(w, ` ${button.label} `, room);
    }
    w.write("\x1b[0m\x1b[?25l");
  }
}
