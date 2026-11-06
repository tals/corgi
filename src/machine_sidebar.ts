import type { Endpoint } from "./machine_connection";
import type { Controller } from "./controller";
import * as sidebar from "./sidebar";
import * as dropdown from "./dropdown";
import * as text from "./text";
import * as palette from "./palette";
import { Rect } from "./layout";

/** The machine dropdown: which machines' workspaces the sidebar lists, and
 * how each one's connection stands. The rows themselves are the view's. */
export class Workspaces {
  open = false;
  cursor = 0;
  offset = 0;
  constructor(
    readonly endpoints: Endpoint[],
    private readonly view: Controller,
  ) {}
  /** The machine the sidebar lists alone, or null for all of them. */
  get filter(): Endpoint | null {
    return this.endpoints.find(endpoint => endpoint.machine === this.view.machine_filter) ?? null;
  }
  get visible(): boolean {
    return this.endpoints.some(endpoint => endpoint.profile !== null);
  }
  /** Each machine samples the workspace whose readings the card shows, if it's one of its own. */
  watchResources(): void {
    for (const endpoint of this.endpoints)
      endpoint.watchResources(this.open ? null : this.view.resourceWorkspace(endpoint.machine));
  }
  show(): void {
    if (!this.visible) return;
    this.open = true;
    this.cursor = this.filter ? this.endpoints.indexOf(this.filter) + 1 : 0;
  }
  move(delta: number): void {
    this.cursor = Math.max(0, Math.min(this.endpoints.length, this.cursor + delta));
  }
  selectFilter(): void {
    this.view.machine_filter = this.cursor ? this.endpoints[this.cursor - 1].machine : null;
    this.view.workspace_offset = 0;
    this.open = false;
  }
  collapse(): void {
    const endpoint = this.endpoints[this.cursor - 1];
    if (endpoint) this.view.toggleMachine(endpoint.machine);
  }
  retry(): void {
    this.endpoints[this.cursor - 1]?.retry();
  }
  pause(): void {
    this.endpoints[this.cursor - 1]?.pause();
  }
  private choices(width: number): dropdown.Choice[] {
    return [
      { text: "all", note: "All workspaces", current: this.filter === null, hovered: this.cursor === 0 },
      ...this.endpoints.map((endpoint, i) => {
        const name = text.ellipsis(endpoint.name, Math.max(1, Math.floor(width / 3)));
        const room = Math.max(0, width - 8);
        const note_room = Math.max(0, room - Math.min(text.displayWidth(name), Math.ceil(room / 2)) - 2);
        const quality = endpoint.profile && endpoint.status === "online" ? endpoint.stats.quality : null;
        const color = statusColor(endpoint, quality);
        const runs: dropdown.Run[] = [];
        if (quality !== null && note_room >= 6) {
          for (const [bar, glyph] of [..."▂▄▆█"].entries()) runs.push([glyph, bar < quality ? color : "line"]);
          runs.push([" " + text.ellipsis(endpoint.description(), note_room - 5), color]);
        } else {
          const state = endpoint.status === "online" ? "● " + endpoint.description() : endpoint.description();
          runs.push([text.ellipsis(state, note_room), color]);
        }
        return {
          text: name,
          note: runs.map(([part]) => part).join(""),
          runs,
          current: this.filter === endpoint,
          hovered: this.cursor === i + 1,
          dim: endpoint.status !== "online",
        };
      }),
    ];
  }
  private layout(side: sidebar.View): { box: Rect; choices: dropdown.Choice[] } {
    const anchor = side.workspaceScope();
    const y = Math.min(2, Math.max(0, side.rows - 5));
    const capacity = Math.max(1, side.rows - y - 4);
    this.offset = Math.min(this.offset, this.cursor);
    if (this.cursor >= this.offset + capacity) this.offset = this.cursor - capacity + 1;
    const width = Math.min(side.cols, 64, Math.max(36, side.width));
    const choices = this.choices(width).slice(this.offset, this.offset + capacity);
    const x = Math.max(0, Math.min(anchor?.x ?? 1, side.cols - width));
    return { box: new Rect(x, y, width, choices.length + 2), choices };
  }
  hit(side: sidebar.View, x: number, y: number): number | null {
    const { box, choices } = this.layout(side);
    const index = dropdown.hit(box, choices.length, x, y);
    return index === null ? null : this.offset + index;
  }
  draw(side: sidebar.View): string {
    const { box, choices } = this.layout(side);
    const writer = new text.Writer();
    dropdown.draw(writer, box, choices);
    writer.write(`\x1b[${box.y + box.h + 1};${box.x + 1}H${palette.bg("surface")}${palette.fg("muted")}`);
    const hint = text.ellipsis(" ↑↓ Enter · ^F fold · ^R retry · ^X pause · ! details", box.w);
    writer.write(hint + " ".repeat(Math.max(0, box.w - text.displayWidth(hint))) + "\x1b[0m\x1b[?25l");
    return writer.buffered();
  }
}

function statusColor(endpoint: Endpoint, quality: number | null): palette.Token {
  switch (endpoint.status) {
    case "online":
      return endpoint.error || (quality !== null && quality < 3) ? "warm" : "accent";
    case "connecting":
    case "stalled":
      return "warm";
    case "offline":
    case "incompatible":
    case "attention":
      return "hot";
    case "paused":
      return "muted";
  }
}
