//! The per-account launch editor. Geometry is stable while environment rows change.
import type { Agent } from "./agent_manager";
import * as agentOptions from "./agent_options";
import * as palette from "./palette";
import { Dialog, View as DialogView, writeField, printable } from "./name_dialog";
import { Rect } from "./layout";
import { Writer, displayWidth, writeEllipsis, sat } from "./text";
import * as keys from "./keys";
import { milliTimestamp } from "./clock";
import { writeModel } from "./agent_models";
import type { Effort } from "./providers/effort";
import { Model } from "./providers/model";

export type Focus =
  { kind: "name" | "model" | "flags" | "add" | "cancel" | "save" } | { kind: "key" | "value" | "remove"; row: number };
type Variable = { key: Dialog; value: Dialog; added: number | null };
type Result = "save" | "cancel" | "model" | null;
const visible_rows = 4;
const save_label = " Save · Ctrl+S ",
  cancel_label = " Cancel · Esc ";
export const row_duration_ms = 240;
const editor = (text: string) => Dialog.init({ agent_command: 0 }, text);
const at = (x: number, y: number) => `\x1b[${y + 1};${x + 1}H`;

export class Form {
  agent: Agent | null = null;
  name = Dialog.init({ rename: 0 }, "");
  flags = editor("");
  variables: Variable[] = [];
  focus: Focus = { kind: "name" };
  suggestion = "";
  error = "";
  model = "";
  effort?: Effort;
  cloning = false;
  private first = 0;
  private room = visible_rows;

  open(agent: Agent, options: agentOptions.Options, suggestion: string): void {
    this.agent = agent;
    this.name = Dialog.init({ rename: 0 }, agent.name);
    this.flags = editor(options.flags);
    this.model = options.model || "";
    this.effort = options.effort;
    this.cloning = false;
    this.variables = options.env.map(([key, value]) => ({ key: editor(key), value: editor(value), added: null }));
    this.focus = { kind: "name" };
    this.suggestion = suggestion;
    this.error = "";
    this.first = 0;
  }
  height(): number {
    return 27;
  }
  input(): Dialog {
    const f = this.focus;
    switch (f.kind) {
      case "flags":
        return this.flags;
      case "key":
        return this.variables[f.row].key;
      case "value":
        return this.variables[f.row].value;
      default:
        return this.name;
    }
  }
  typing(): boolean {
    return ["name", "flags", "key", "value"].includes(this.focus.kind);
  }
  options(): agentOptions.Options {
    return {
      flags: this.flags.raw(),
      env: this.variables.map(v => [v.key.raw(), v.value.raw()]),
      ...(this.effort ? { effort: this.effort } : {}),
      ...(this.model ? { model: this.model } : {}),
    };
  }
  label(): string {
    if (this.cloning || this.agent?.profile) return this.name.name();
    return this.name.name() || (this.agent?.account ? this.suggestion : "");
  }
  validate(): boolean {
    this.error = agentOptions.problem(this.options()) ?? "";
    if ((this.cloning || this.agent?.profile) && !this.label()) this.error = "Give this agent a name.";
    if ([this.name, this.flags, ...this.variables.flatMap(v => [v.key, v.value])].some(d => d.overflow))
      this.error = "A field is too long; shorten it before saving.";
    return !this.error;
  }
  tick(now: number): boolean {
    let active = false;
    for (const variable of this.variables) {
      if (variable.added === null) continue;
      active = true;
      if (now - variable.added >= row_duration_ms) variable.added = null;
    }
    return active;
  }
  private stops(): Focus[] {
    return [
      { kind: "name" },
      { kind: "model" },
      { kind: "flags" },
      ...this.variables.flatMap((_, row): Focus[] => [
        { kind: "key", row },
        { kind: "value", row },
        { kind: "remove", row },
      ]),
      ...(this.variables.length < agentOptions.max_variables ? [{ kind: "add" } as Focus] : []),
      { kind: "save" },
      { kind: "cancel" },
    ];
  }
  private move(delta: number): void {
    const stops = this.stops(),
      index = stops.findIndex(
        f => f.kind === this.focus.kind && (!("row" in f) || ("row" in this.focus && f.row === this.focus.row)),
      );
    this.focus = stops[(Math.max(0, index) + delta + stops.length) % stops.length];
    this.ensureVisible();
  }
  private vertical(delta: number): void {
    const rows: Focus[][] = [
      [{ kind: "name" }],
      [{ kind: "model" }],
      [{ kind: "flags" }],
      ...this.variables.map((_, row): Focus[] => [
        { kind: "key", row },
        { kind: "value", row },
        { kind: "remove", row },
      ]),
      ...(this.variables.length < agentOptions.max_variables ? [[{ kind: "add" } as Focus]] : []),
      [{ kind: "save" }, { kind: "cancel" }],
    ];
    const f = this.focus,
      index = rows.findIndex(row =>
        row.some(stop => stop.kind === f.kind && (!("row" in stop) || ("row" in f && stop.row === f.row))),
      ),
      target = rows[(index + delta + rows.length) % rows.length],
      column = f.kind === "value" ? 1 : f.kind === "remove" ? 2 : 0;
    this.focus = target[0].kind === "save" ? { kind: "save" } : target[Math.min(column, target.length - 1)];
    this.ensureVisible();
  }
  private nextField(): void {
    const f = this.focus;
    switch (f.kind) {
      case "name":
        this.focus = { kind: "model" };
        break;
      case "model":
        this.focus = { kind: "flags" };
        break;
      case "key":
        this.focus = { kind: "value", row: f.row };
        break;
      case "flags":
      case "value": {
        const row = f.kind === "value" ? f.row + 1 : 0;
        this.focus =
          row < this.variables.length
            ? { kind: "key", row }
            : { kind: this.variables.length < agentOptions.max_variables ? "add" : "save" };
        break;
      }
    }
    this.ensureVisible();
  }
  private ensureVisible(): void {
    if ("row" in this.focus)
      this.first = Math.max(0, Math.min(this.focus.row, Math.max(this.first, this.focus.row - this.room + 1)));
    this.first = Math.min(this.first, Math.max(0, this.variables.length - this.room));
  }
  private add(now: number): void {
    if (this.variables.length >= agentOptions.max_variables) return;
    this.variables.push({ key: editor(""), value: editor(""), added: now });
    this.focus = { kind: "key", row: this.variables.length - 1 };
    this.ensureVisible();
  }
  private remove(row: number): void {
    this.variables.splice(row, 1);
    this.focus = this.variables.length
      ? { kind: "key", row: Math.min(row, this.variables.length - 1) }
      : { kind: "add" };
    this.ensureVisible();
  }
  key(byte: number, now = milliTimestamp()): Result {
    this.error = "";
    if (byte === 109 && !this.typing()) return "model";
    switch (byte) {
      case 19:
        return this.validate() ? "save" : null;
      case 27:
        return "cancel";
      case 9:
        this.move(1);
        return null;
      case 13:
        switch (this.focus.kind) {
          case "model":
            return "model";
          case "add":
            this.add(now);
            return null;
          case "remove":
            this.remove(this.focus.row);
            return null;
          case "cancel":
            return "cancel";
          case "save":
            return this.validate() ? "save" : null;
          default:
            this.nextField();
            return null;
        }
      default:
        if (this.typing()) this.input().key(byte);
        return null;
    }
  }
  sequence(seq: string): void {
    const key = keys.parse(seq);
    if (key === "shift_tab") this.move(-1);
    else if (key === "up" || key === "down") this.vertical(key === "up" ? -1 : 1);
    else if (key === "left" && this.focus.kind === "cancel") this.focus = { kind: "save" };
    else if (key === "right" && this.focus.kind === "save") this.focus = { kind: "cancel" };
    else if (key === "left" && this.focus.kind === "remove") this.focus = { kind: "value", row: this.focus.row };
    else if (this.typing()) this.input().sequence(seq);
  }
  private geometry(b: Rect) {
    const x = b.x + 3,
      width = Math.min(80, sat(b.w, 6)),
      key_width = Math.min(26, Math.floor((width - 6) * 0.4));
    const compact = b.h < this.height();
    this.room = compact ? 3 : visible_rows;
    this.ensureVisible();
    return {
      x,
      width,
      key_width,
      value_x: x + key_width + 2,
      value_width: width - key_width - 6,
      remove_x: x + width - 3,
      cancel_x: x + displayWidth(save_label) + 3,
      save_x: x,
      name: compact ? 4 : 5,
      model: compact ? 6 : 8,
      flags: compact ? 8 : 11,
      hint: compact ? 9 : 12,
      environment: compact ? 10 : 14,
      headings: compact ? 11 : 15,
      rows: compact ? 12 : 16,
      count: compact ? 15 : 20,
      add: compact ? 16 : 21,
      actions: compact ? 18 : 23,
      error: compact ? 19 : 24,
      compact,
    };
  }
  private field(
    w: Writer,
    d: Dialog,
    placeholder: string,
    x: number,
    y: number,
    width: number,
    focused: boolean,
  ): void {
    const plain = new palette.Style({ fg: "text", bg: "selected" }).sgr(),
      border = palette.fg(focused ? "accent" : "line"),
      columns = sat(width, 4);
    w.write(at(x, y) + plain + border + "[" + plain);
    w.splat(" ", sat(width, 2));
    w.write(border + "]" + at(x + 2, y));
    if (!d.len) {
      w.write(palette.fg("muted"));
      writeEllipsis(w, placeholder, columns);
    } else writeField(w, d, DialogView.scroll(d, columns), columns, plain, { selecting: focused });
    w.write(new palette.Style({ fg: "text", bg: "surface" }).sgr());
  }
  draw(w: Writer, b: Rect, now: number): void {
    const g = this.geometry(b),
      f = this.focus,
      text = new palette.Style({ fg: "text", bg: "surface" }).sgr(),
      dim = palette.fg("faint"),
      strong = palette.fg("strong"),
      label = (y: number, value: string, focused = false) => {
        w.write(
          at(g.x, b.y + y) +
            new palette.Style({ fg: focused ? "strong" : "muted", bg: "surface", bold: focused }).sgr(),
        );
        writeEllipsis(w, value, g.width);
      },
      button = (x: number, y: number, value: string, focused: boolean) =>
        w.write(
          at(x, b.y + y) +
            new palette.Style({ fg: focused ? "strong" : "text", bg: focused ? "selected" : "surface" }).sgr() +
            value +
            text,
        );
    w.write(at(g.x, b.y + 2) + text + strong);
    writeEllipsis(w, printable(this.agent?.label ?? ""), g.width);
    if (!g.compact) label(3, printable(this.agent?.who ?? ""));
    label(g.name - 1, "Name", f.kind === "name");
    this.field(
      w,
      this.name,
      this.agent?.account ? this.suggestion : "Agent default",
      g.x,
      b.y + g.name,
      g.width,
      f.kind === "name",
    );
    label(g.flags - 1, "Extra flags", f.kind === "flags");
    label(g.model - 1, "Model", f.kind === "model");
    const model_style = new palette.Style({
      fg: f.kind === "model" ? "strong" : "text",
      bg: f.kind === "model" ? "selected" : "surface",
    }).sgr();
    w.write(at(g.x, b.y + g.model) + model_style);
    writeModel(
      w,
      this.model ? Model.resolve(this.model).label() : "Auto (last chosen)",
      this.effort,
      g.width - 2,
      model_style,
    );
    w.write(" ▾" + text);
    this.field(w, this.flags, "e.g. --verbose", g.x, b.y + g.flags, g.width, f.kind === "flags");
    label(g.hint, "Appended to Corgi's launch command. Quotes supported.");
    label(g.environment, "Environment");
    label(g.headings, "Variable", f.kind === "key");
    w.write(at(g.value_x, b.y + g.headings) + palette.fg(f.kind === "value" ? "strong" : "muted") + "Value");
    if (!this.variables.length) label(g.rows, "No overrides; inherits your environment.");
    for (let i = this.first; i < Math.min(this.variables.length, this.first + this.room); i++) {
      const variable = this.variables[i],
        y = b.y + g.rows + i - this.first;
      this.field(w, variable.key, "VARIABLE", g.x, y, g.key_width, f.kind === "key" && f.row === i);
      this.field(w, variable.value, "(empty)", g.value_x, y, g.value_width, f.kind === "value" && f.row === i);
      button(g.remove_x, y - b.y, "[×]", f.kind === "remove" && f.row === i);
      if (variable.added !== null) {
        const t = Math.min(1, Math.max(0, (now - variable.added) / row_duration_ms)),
          color = palette.mix(palette.colors.accent, palette.colors.line, Math.round(100 * (1 - (1 - t) ** 3)));
        w.write(at(g.x - 1, y) + palette.fgRgb(color) + "▎" + text);
      }
    }
    if (this.variables.length > this.room)
      label(
        g.count,
        `${this.first + 1}–${Math.min(this.first + this.room, this.variables.length)} of ${this.variables.length} · tab to scroll`,
      );
    if (this.variables.length < agentOptions.max_variables) button(g.x, g.add, "[ + Add variable ]", f.kind === "add");
    w.write(at(g.x, b.y + g.actions - 1) + palette.fg("line") + "─".repeat(g.width));
    for (const [kind, x, label] of [
      ["save", g.save_x, save_label],
      ["cancel", g.cancel_x, cancel_label],
    ] as const) {
      const focused = f.kind === kind;
      w.write(at(x - 1, b.y + g.actions) + palette.fg("accent") + (focused ? "›" : " "));
      w.write(
        at(x, b.y + g.actions) +
          new palette.Style({
            fg: kind === "save" ? (focused ? "bg" : "accent") : focused ? "strong" : "text",
            bg: kind === "save" && focused ? "accent" : "selected",
            bold: kind === "save" || focused,
          }).sgr() +
          label +
          text,
      );
    }
    const marker =
      f.kind === "name" || f.kind === "model" || f.kind === "flags" || f.kind === "add"
        ? { x: g.x, y: g[f.kind] }
        : f.kind === "key" || f.kind === "value" || f.kind === "remove"
          ? { x: f.kind === "key" ? g.x : f.kind === "value" ? g.value_x : g.remove_x, y: g.rows + f.row - this.first }
          : null;
    if (marker) w.write(at(marker.x - 1, b.y + marker.y) + palette.fg("accent") + "›" + text);
    if (this.error) {
      w.write(at(g.x, b.y + g.error) + palette.fg("hot"));
      writeEllipsis(w, this.error, g.width);
    }
  }
  caret(b: Rect): { x: number; y: number } {
    const g = this.geometry(b),
      f = this.focus,
      variable = f.kind === "key" || f.kind === "value",
      x = (f.kind === "value" ? g.value_x : g.x) + 2,
      width = sat(f.kind === "key" ? g.key_width : f.kind === "value" ? g.value_width : g.width, 4),
      d = this.input(),
      offset = DialogView.scroll(d, width),
      y = b.y + (variable && "row" in f ? g.rows + f.row - this.first : f.kind === "flags" ? g.flags : g.name);
    return { x: x + Math.min(sat(width, 1), displayWidth(d.bytes(offset, d.cursor))), y };
  }
  click(b: Rect, x: number, y: number, now = milliTimestamp()): Result {
    const g = this.geometry(b),
      row = y - b.y;
    if (x < g.x || x >= g.x + g.width) return null;
    if (row === g.model) {
      this.focus = { kind: "model" };
      return "model";
    }
    if (row === g.actions && x >= g.save_x && x < g.save_x + displayWidth(save_label))
      return this.validate() ? "save" : null;
    if (row === g.actions && x >= g.cancel_x && x < g.cancel_x + displayWidth(cancel_label)) return "cancel";
    if (row === g.add && x < g.x + 18) {
      this.add(now);
      return null;
    }
    this.error = "";
    if (row === g.name) this.focus = { kind: "name" };
    else if (row === g.flags) this.focus = { kind: "flags" };
    else if (row >= g.rows && row < g.rows + this.room && this.variables[row - g.rows + this.first]) {
      const index = row - g.rows + this.first;
      if (x >= g.remove_x && x < g.remove_x + 3) {
        this.remove(index);
        return null;
      }
      if (x < g.x + g.key_width) this.focus = { kind: "key", row: index };
      else if (x >= g.value_x && x < g.value_x + g.value_width) this.focus = { kind: "value", row: index };
      else return null;
    } else return null;
    const width = sat(
        this.focus.kind === "key" ? g.key_width : this.focus.kind === "value" ? g.value_width : g.width,
        4,
      ),
      start = (this.focus.kind === "value" ? g.value_x : g.x) + 2,
      d = this.input();
    d.position(d.byteAtColumn(DialogView.scroll(d, width), Math.max(0, Math.min(width, x - start))));
    return null;
  }
  modelAnchor(b: Rect): { x: number; y: number } {
    const g = this.geometry(b);
    return { x: g.x, y: b.y + g.model };
  }
}
