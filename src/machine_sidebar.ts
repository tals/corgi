import type { Endpoint, Status } from "./machine_connection";
import type { Controller } from "./controller";
import * as sidebar from "./sidebar";
import * as dropdown from "./dropdown";
import * as text from "./text";
import * as palette from "./palette";
import * as i18n from "./i18n";
import { Rect } from "./layout";
import * as machineAdd from "./machine_add";
import * as signalBars from "./signal_bars";

/** The machine dropdown: which machines' workspaces the sidebar lists, and
 * how each one's connection stands; under a divider, the SSH config's other
 * hosts, which ↵ adds. Typing searches them, and offers a host none names.
 * The rows themselves are the view's. */
export class Workspaces {
  open = false;
  offset = 0;
  /** The machine a first ^X marked; a second removes it. */
  removing: Endpoint | null = null;
  /** Where its note's ^X fell when last drawn, for its keycap. */
  private cap: { x: number; y: number } | null = null;
  readonly list: machineAdd.Listing<Endpoint>;
  constructor(
    readonly endpoints: Endpoint[],
    private readonly view: Controller,
    adds: machineAdd.Adds | null = null,
  ) {
    this.list = new machineAdd.Listing(() => this.endpoints, adds, true);
  }
  /** The highlighted row: "all", the machines, then the divider and the hosts to add. */
  get cursor(): number {
    return this.list.cursor;
  }
  set cursor(row: number) {
    if (row !== this.list.cursor) this.removing = null;
    this.list.cursor = row;
  }
  /** The machine on the highlighted row. */
  endpoint(): Endpoint | null {
    const row = this.list.row();
    return row?.kind === "machine" ? row.machine : null;
  }
  /** The machine the sidebar lists alone, or null for all of them. */
  get filter(): Endpoint | null {
    return this.endpoints.find(endpoint => endpoint.machine === this.view.machine_filter) ?? null;
  }
  get visible(): boolean {
    return this.endpoints.some(endpoint => endpoint.remote);
  }
  /** Each machine samples the workspace whose readings the card shows, if it's one of its own. */
  watchResources(): void {
    for (const endpoint of this.endpoints)
      endpoint.watchResources(this.open ? null : this.view.resourceWorkspace(endpoint.machine));
  }
  /** Opens with a machine to list, or one to add. */
  show(): void {
    if (!this.visible && !this.list.adds) return;
    this.view.worktree_card.pending_enter = null;
    this.open = true;
    this.offset = 0;
    this.removing = null;
    this.list.open(this.filter ? this.endpoints.indexOf(this.filter) + 1 : 0);
  }
  hide(): void {
    this.open = false;
    this.removing = null;
    this.list.close();
  }
  move(delta: number): void {
    this.removing = null;
    this.list.move(delta);
  }
  /** Lists the machine's workspaces alone, or all of them, and closes; a
   * host starts being added, and the list stays. False while it's open. */
  selectFilter(): boolean {
    const row = this.list.row();
    switch (row?.kind) {
      case "host":
        this.list.adds?.start(row.name, row.target);
        return false;
      case "all":
      case "machine":
        this.view.machine_filter = row.kind === "machine" ? row.machine.machine : null;
        this.view.workspace_offset = 0;
        this.hide();
        return true;
      default:
        return false;
    }
  }
  collapse(): void {
    const endpoint = this.endpoint();
    if (endpoint) this.view.toggleMachine(endpoint.machine);
  }
  retry(): void {
    this.endpoint()?.retry();
  }
  /** The highlighted machine, to remove, on the second ^X in a row; the
   * first marks it. Never this computer. */
  remove(): Endpoint | null {
    const endpoint = this.endpoint();
    if (!endpoint?.remote) return null;
    if (this.removing === endpoint) {
      this.removing = null;
      return endpoint;
    }
    this.removing = endpoint;
    return null;
  }
  /** Keeps the highlight on a row once a machine has gone: the one that took
   * its place, else the machine above. */
  settle(): void {
    const rows = this.list.rows();
    let at = Math.min(this.list.cursor, rows.length - 1);
    while (at > 0 && rows[at].kind === "divider") at--;
    this.list.cursor = Math.max(0, at);
  }
  private choices(width: number): dropdown.Choice[] {
    // Drawing the rows finds it again.
    this.cap = null;
    const cursor = this.cursor;
    return this.list.rows().map((row, i): dropdown.Choice => {
      const hovered = cursor === i;
      switch (row.kind) {
        case "all":
          return { text: "all", note: "All workspaces", current: this.filter === null, hovered };
        case "machine":
          return this.machineChoice(row.machine, width, hovered);
        case "divider":
          return machineAdd.divider;
        case "host":
          return machineAdd.hostChoice(this.list.adds!, row, hovered);
      }
    });
  }
  private machineChoice(endpoint: Endpoint, width: number, hovered: boolean): dropdown.Choice {
    const name = text.ellipsis(endpoint.name, Math.max(1, Math.floor(width / 3)));
    // As the dropdown lays out a row a cell in from either border.
    const room = Math.max(0, width - 10);
    const note_room = Math.max(0, room - Math.min(text.displayWidth(name), Math.ceil(room / 2)) - 2);
    // As the sidebar shows it: a connect's first second still looks as before.
    const status = endpoint.display().status,
      online = status === "online";
    const quality = endpoint.remote && online ? endpoint.stats.quality : null;
    const color = statusColor(status, endpoint.error, quality);
    const description =
      online && !endpoint.updateMessage && !endpoint.updateError ? endpoint.error || "online" : endpoint.description();
    // The reception's bars, or online's dot, at the right edge, as the sidebar's headers keep them.
    const runs: dropdown.Run[] = [];
    if (this.removing === endpoint && note_room >= 5)
      runs.push(
        [" ^X ", "hot", (x, y) => (this.cap = { x, y })],
        [text.ellipsis(" " + i18n.t`again to remove`, note_room - 4), "hot"],
      );
    else if (quality !== null && note_room >= 6) {
      const bars = signalBars.runs(quality, this.view.framePictures());
      runs.push([text.ellipsis(description, note_room - barsWidth(bars) - 1) + " ", color], ...bars);
    } else {
      const state = online ? text.ellipsis(description, Math.max(0, note_room - 2)) + " ●" : description;
      runs.push([text.ellipsis(state, note_room), color]);
    }
    return {
      text: name,
      note: runs.map(([part]) => part).join(""),
      runs,
      current: this.filter === endpoint,
      hovered,
      dim: !online,
    };
  }
  /** The box, with the field on its first row and room for every row a
   * search can list, scrolled to keep the highlight in view. */
  private layout(side: sidebar.View): { box: Rect; choices: dropdown.Choice[] } {
    const anchor = side.workspaceScope();
    const y = Math.min(2, Math.max(0, side.rows - 5));
    const capacity = Math.max(1, Math.min(this.list.reserve(), side.rows - y - 4));
    this.offset = Math.min(this.offset, this.cursor);
    if (this.cursor >= this.offset + capacity) this.offset = this.cursor - capacity + 1;
    const width = Math.min(
      side.cols,
      66,
      Math.max(this.endpoints.some(e => e.updateMessage || e.updateError) ? 66 : 60, side.width),
    );
    const choices = this.choices(width).slice(this.offset, this.offset + capacity);
    const x = Math.max(0, Math.min(anchor?.x ?? 1, side.cols - width));
    return { box: new Rect(x, y, width, capacity + 3), choices };
  }
  /** The row under (x, y); "inside" for the field, the divider and the room
   * the box keeps, which a press leaves alone; null outside. */
  hit(side: sidebar.View, x: number, y: number): number | "inside" | null {
    const { box, choices } = this.layout(side);
    if (!box.contains(x, y)) return null;
    const index = dropdown.hit(box, choices.length + 1, x, y);
    if (index === null || index === 0) return "inside";
    const row = this.offset + index - 1;
    return this.list.row(row)?.kind === "divider" ? "inside" : row;
  }
  draw(side: sidebar.View): string {
    const { box, choices } = this.layout(side);
    const writer = new text.Writer();
    // Drawn over the frame, which cuts its pictures around the box and the hint.
    this.view.framePictures()?.cover(new Rect(box.x, box.y, box.w, box.h + 1));
    const cursor = machineAdd.drawList(writer, box, choices, this.list.query);
    if (this.cap) writer.write(`\x1b[${this.cap.y + 1};${this.cap.x + 1}H${palette.keycap} ^X `);
    const footer = box.y + box.h + 1,
      label = new palette.Style({ fg: "faint", bg: "surface" }).sgr();
    writer.write(`\x1b[${footer};${box.x + 1}H${label}`);
    writer.splat(" ", box.w);
    writer.write(`\x1b[${footer};${box.x + 2}H`);
    drawKeys(writer, box.w - 1, label);
    writer.write(cursor || "\x1b[0m\x1b[?25l");
    return writer.buffered();
  }
}

const barsWidth = (runs: dropdown.Run[]) => text.displayWidth(runs.map(([part]) => part).join(""));
/** The keys the dropdown takes, under it. */
const keys = (): [string, string][] => [
  ["↵", i18n.t`choose`],
  ["^F", i18n.t`fold`],
  ["^R", i18n.t`retry`],
  ["^X", i18n.t`remove`],
  ["!", i18n.t`details`],
];
/** Keycaps and their labels, as the launcher's footer shows them: two cells
 * apart, one when that's too wide, and the last left out when even that is. */
function drawKeys(w: text.Writer, room: number, label: string): void {
  const all = keys(),
    span = (count: number, gap: number) =>
      all.slice(0, count).reduce((n, [key, name]) => n + text.displayWidth(key) + 3 + text.displayWidth(name), 0) +
      gap * Math.max(0, count - 1);
  const gap = span(all.length, 2) <= room ? 2 : 1;
  let shown = all.length;
  while (shown > 0 && span(shown, gap) > room) shown--;
  all
    .slice(0, shown)
    .forEach(([key, name], i) =>
      w.write((i ? " ".repeat(gap) : "") + palette.keycap + ` ${key} ` + label + ` ${name}`),
    );
}

function statusColor(status: Status, error: string, quality: number | null): palette.Token {
  switch (status) {
    case "online":
      return error || (quality !== null && quality < 3) ? "warm" : "accent";
    case "connecting":
    case "stalled":
      return "warm";
    case "offline":
    case "incompatible":
    case "attention":
      return "hot";
  }
}
