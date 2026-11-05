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
    return this.endpoints.some(endpoint => endpoint.profile !== null && endpoint.updated > 0);
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
    this.open = false;
  }
  retry(): void {
    this.endpoints[this.cursor - 1]?.retry();
  }
  pause(): void {
    this.endpoints[this.cursor - 1]?.pause();
  }
  private choices(): dropdown.Choice[] {
    return [
      { text: "all", note: "All workspaces", current: this.filter === null, hovered: this.cursor === 0 },
      ...this.endpoints.map((endpoint, i) => ({
        text: endpoint.name,
        note: endpoint.status === "online" ? "● online" : endpoint.description(),
        current: this.filter === endpoint,
        hovered: this.cursor === i + 1,
        dim: endpoint.status !== "online",
      })),
    ];
  }
  private layout(side: sidebar.View): { box: Rect; choices: dropdown.Choice[] } {
    const anchor = side.workspaceScope();
    const y = Math.min(2, Math.max(0, side.rows - 5));
    const capacity = Math.max(1, side.rows - y - 4);
    this.offset = Math.min(this.offset, this.cursor);
    if (this.cursor >= this.offset + capacity) this.offset = this.cursor - capacity + 1;
    const width = Math.min(side.cols, 64, Math.max(36, side.width));
    const choices = this.choices()
      .slice(this.offset, this.offset + capacity)
      .map(choice => ({
        ...choice,
        text: text.ellipsis(choice.text, Math.max(1, Math.floor(width / 3))),
        note: text.ellipsis(choice.note, Math.max(1, width - Math.floor(width / 3) - 9)),
      }));
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
    const hint = text.ellipsis(" ↑↓ Enter · ^R retry · ^X pause", box.w);
    writer.write(hint + " ".repeat(Math.max(0, box.w - text.displayWidth(hint))) + "\x1b[0m\x1b[?25l");
    return writer.buffered();
  }
}
