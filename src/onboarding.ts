//! Viewer-owned cell-based onboarding wizard.
import { BoundedText } from "./bounded_text";
import { Writer, sat, writeSanitized } from "./text";
import { milliTimestamp } from "./clock";
import type { Action } from "./action";
import * as km from "./keymap";
import * as keys from "./keys";
import * as bindings from "./bindings";
import * as palette from "./palette";
import * as catalog from "./import/catalog";
import * as herdr from "./import/herdr";
import { Picker } from "./import/picker";
import { Rect } from "./layout";
import type { Connection } from "./rpc";
import * as shortcut_help from "./shortcut_help";
import * as ghostty_integration from "./ghostty_integration";
export type Step = "presets" | "keymap" | "connect" | "import";
export type Mode = "welcome" | "keyboard";
const Message = BoundedText(256);
export class State {
  preset: km.Preset = "corgi";
  prefix: km.Prefix = "ctrl_b";
  step: Step = "presets";
  source_initialized = false;
  help = new shortcut_help.State();
  picker = new Picker();
  focus = 0;
  message = new Message();
  mode: Mode = "welcome";
  dismissable = false;
  cancelled = false;
  static start(mode: Mode, preset: km.Preset, prefix: km.Prefix) {
    const state = new State();
    state.mode = mode;
    state.preset = preset;
    state.prefix = prefix;
    state.dismissable = true;
    return state;
  }
  cancel() {
    this.cancelled = true;
    return true;
  }
  close() {
    this.picker.close();
  }
  fail(error: Error | string) {
    this.setMessage(typeof error === "string" ? error : error.message);
  }
  setMessage(msg: string) {
    this.message = new Message(msg);
  }
  enterKeymap() {
    this.step = "keymap";
    this.help = new shortcut_help.State();
  }
  enterImport() {
    this.step = "import";
    this.focus = 0;
    if (!this.source_initialized) {
      this.source_initialized = true;
      this.picker.source = herdr.detected()
        ? "herdr"
        : km.supportedPreset(this.preset) === "herdr"
          ? "herdr"
          : km.supportedPreset(this.preset) === "cmux"
            ? "cmux"
            : "tmux";
    }
    this.picker.scan();
  }
  async begin(conn: Pick<Connection, "call">): Promise<boolean> {
    if (!this.picker.selectionCount()) return true;
    await this.picker.begin(conn);
    this.message = new Message();
    return false;
  }
  async poll(conn: Pick<Connection, "call">): Promise<boolean> {
    return this.step === "import" && (await this.picker.poll(conn));
  }
  async key(byte: number | string, conn: Pick<Connection, "call">): Promise<boolean> {
    const b = typeof byte === "string" ? byte.charCodeAt(0) : byte;
    const picker = this.picker;
    if (this.step === "import") picker.selectDefaults();
    this.preset = km.supportedPreset(this.preset);
    this.message = new Message();
    picker.message = "";
    if (this.step === "presets") {
      const presets = km.available_presets,
        index = presets.indexOf(this.preset);
      if (b === 106 || b === 14) this.preset = presets[(index + 1) % presets.length];
      else if (b === 107 || b === 16) this.preset = presets[(index + presets.length - 1) % presets.length];
      else if (b >= 49 && b <= 52 && b - 49 < presets.length) this.preset = presets[b - 49];
      else if ([112, 80, 32].includes(b)) this.prefix = this.prefix === "ctrl_b" ? "ctrl_a" : "ctrl_b";
      else if (b === 63) this.enterKeymap();
      else if (b === 9) this.focus = (this.focus + 1) % 3;
      else if (b === 27 && this.dismissable) return this.cancel();
      else if (b === 13) {
        if (this.focus === 1) this.prefix = this.prefix === "ctrl_b" ? "ctrl_a" : "ctrl_b";
        else if (this.focus === 2) this.enterKeymap();
        else if (this.preset === "cmux") this.step = "connect";
        else if (this.mode === "keyboard") return true;
        else this.enterImport();
      }
    } else if (this.step === "keymap") {
      if (this.help.key(b)) this.step = "presets";
    } else if (this.step === "connect") {
      if (b === 27) this.step = "presets";
      else if (b === 112) {
        this.preset = "herdr";
        if (this.mode === "keyboard") return true;
        this.enterImport();
      } else if (b === 13) {
        if (ghosttyHost()) {
          ghostty_integration.sync({ preset: "cmux", prefix: this.prefix });
          if (this.mode === "keyboard") return true;
          this.enterImport();
          this.setMessage("Reload Ghostty: Cmd+Shift+, to apply Command keys.");
        } else this.setMessage("Press P for portable Herdr prefix keys, or Esc to choose again.");
      }
    } else if (this.step === "import") {
      if (picker.stage === "complete") return b === 13;
      if (picker.stage === "copying") {
        if (picker.failed() && (b === 27 || b === 13)) picker.retry();
      } else if (b === 115 || b === 83) return true;
      else if (b === 27) this.step = "presets";
      else if (b >= 49 && b <= 51) picker.changeSource((["tmux", "herdr", "cmux"] as catalog.Source[])[b - 49]);
      else if (b === 106 || b === 14) picker.move(true, false);
      else if (b === 107 || b === 16) picker.move(false, false);
      else if (b === 9) this.focus = (this.focus + 1) % 2;
      else if (b === 13) return this.begin(conn);
      else picker.key(b);
    }
    return false;
  }
  async sequence(seq: string, conn: Pick<Connection, "call">): Promise<boolean> {
    if (this.step === "keymap") {
      this.help.sequence(seq);
      return false;
    }
    const key = keys.parse(seq);
    if (key === "up") return this.key(16, conn);
    if (key === "down") return this.key(14, conn);
    const picker = this.picker;
    if (key === "page_up") picker.scroll = Math.max(0, picker.scroll - 5);
    if (key === "page_down") picker.scroll += 5;
    if (this.step === "import" && picker.stage === "choose" && (seq === "\x1b[C" || seq === "\x1b[D")) {
      const sources = catalog.available_sources,
        delta = seq[2] === "C" ? 1 : sources.length - 1;
      picker.changeSource(sources[(sources.indexOf(picker.source) + delta) % sources.length]);
    }
    return false;
  }
  async click(cols: number, rows: number, x: number, y: number, conn: Pick<Connection, "call">): Promise<boolean> {
    if (this.step === "keymap") {
      if (shortcut_help.State.closeAt(cols, rows, x, y)) this.step = "presets";
      if (shortcut_help.State.corgiAt(cols, rows, x, y)) this.help.play(milliTimestamp());
      return false;
    }
    const b = bounds(cols, rows);
    if (!b.contains(x, y) || b.w < 76 || b.h < 26) return false;
    const rx = x - b.x,
      ry = y - b.y;
    if (ry === b.h - 3) {
      if (this.step === "presets") this.focus = 0;
      if (rx < 15 && (this.step !== "presets" || this.dismissable)) return this.key(27, conn);
      return this.key(13, conn);
    }
    if (this.step === "presets") {
      const layout = presetLayout(b);
      for (const [i, card] of layout.cards.entries())
        if (card.contains(x, y)) {
          this.preset = km.available_presets[i];
          this.focus = 0;
          return false;
        }
      if (this.preset !== "cmux" && layout.prefix.contains(x, y)) return this.key("p", conn);
      if (ry === layout.help_y && rx >= layout.detail_x) {
        if (rx < layout.detail_x + 20) return this.key("?", conn);
        if (this.preset === "cmux") return this.key("p", conn);
      }
    } else if (this.step === "import" && this.picker.stage === "choose") {
      if (ry === 6 && rx >= b.w - 23) return this.key("s", conn);
      if (ry === 6 && rx >= 3 && rx < 3 + 14 * catalog.available_sources.length)
        return this.key(49 + Math.floor((rx - 3) / 14), conn);
      const hit = this.picker.hit(pickerArea(b), x, y);
      if (hit) {
        this.message = new Message();
        this.picker.message = "";
        this.picker.click(hit);
      }
    }
    return false;
  }
  frame(cols: number, rows: number): string {
    const picker = this.picker;
    this.preset = km.supportedPreset(this.preset);
    if (this.step === "keymap")
      return this.help.frame(cols, rows, this.preset, this.prefix, milliTimestamp(), "default");
    const w = new Writer();
    w.write(new palette.Style({ bg: "bg" }).sgr() + "\x1b[2J\x1b[?25l");
    const b = bounds(cols, rows);
    if (b.w < 76 || b.h < 26) {
      w.write("\x1b[H" + palette.fg("text") + "Welcome to Corgi. Enlarge the terminal to 76 × 26 to continue.");
      return w.buffered();
    }
    box(w, b, false);
    put(w, b, 2, 0, { welcome: " Welcome to Corgi ", keyboard: " Keyboard shortcuts " }[this.mode], bright);
    put(
      w,
      b,
      3,
      2,
      {
        presets: "Which shortcuts feel like home?",
        keymap: "Your shortcuts",
        connect: "Connect your Command keys",
        import: { choose: "Bring your work along", copying: picker.heading(), complete: "You're ready to go" }[
          picker.stage
        ],
      }[this.step],
      bright,
    );
    put(
      w,
      b,
      3,
      3,
      {
        presets: "Choose familiar keys.",
        keymap: "",
        connect: "Your host terminal needs to forward these shortcuts.",
        import: picker.summary(),
      }[this.step],
      dim,
    );
    switch (this.step as Step) {
      case "presets":
        drawPresets(w, b, this);
        break;
      case "keymap":
        break;
      case "connect":
        put(w, b, 5, 7, ghosttyHost() ? "Ghostty / macOS" : "Command forwarding is not confirmed", bright);
        put(w, b, 5, 10, ghosttyHost() ? "[ Connect and continue ]" : "[ P Use Herdr prefix keys ]", bright);
        put(w, b, 5, 13, "Ghostty setup changes shortcuts in every Ghostty window.", text);
        put(w, b, 5, 15, "Cmd+T/D/W, workspace numbers and related bindings replace host actions.", dim);
        put(w, b, 5, 17, "Reload Ghostty with Cmd+Shift+, after connecting.", dim);
        put(w, b, 5, 20, "P  Continue with portable Herdr keys", bright);
        break;
      case "import":
        this.drawImport(w, b);
    }
    const message = this.message.len > 0 ? this.message.text() : this.step === "import" ? picker.message : "";
    if (message.length > 0)
      put(
        w,
        b,
        3,
        b.h - ((this.step as Step) === "presets" || (this.step as Step) === "keymap" ? 4 : 5),
        message,
        warm,
      );
    put(w, b, 3, b.h - 3, footerHint(this), dim);
    let cta: string;
    switch (this.step as Step) {
      case "presets":
        cta = this.mode === "keyboard" && this.preset !== "cmux" ? "[ Enter Save ]" : "[ Enter Continue → ]";
        break;
      case "keymap":
        cta = "[ Enter Back ]";
        break;
      case "connect":
        cta = "[ Enter Connect → ]";
        break;
      case "import":
        cta =
          picker.stage === "complete"
            ? "[ Enter Open Corgi → ]"
            : picker.stage === "copying"
              ? picker.failed()
                ? "[ Enter Back ]"
                : "[ Importing… ]"
              : picker.selectionCount() === 0
                ? "[ Enter Skip import → ]"
                : picker.activeHandoff()
                  ? "[ Enter Handoff → ]"
                  : "[ Enter Import → ]";
        break;
    }
    put(w, b, sat(b.w, 27), b.h - 3, cta, this.step === "presets" && this.focus === 0 ? palette.keycap : bright);
    put(
      w,
      b,
      3,
      b.h - 2,
      this.step === "import" && picker.stage === "choose"
        ? "←→ sources · ↑↓ choose · PgUp/PgDn scroll · R refresh · S skip"
        : "",
      dim,
    );
    w.write("\x1b[0m");
    return w.buffered();
  }
  private drawImport(w: Writer, b: Rect) {
    const picker = this.picker;
    if (picker.stage === "choose") {
      catalog.available_sources.forEach((source, i) => {
        put(w, b, 3 + i * 14, 6, `[ ${i + 1} ${source} ]`, source === picker.source ? bright : dim);
      });
      put(w, b, sat(b.w, 23), 6, "[ S Skip import ]", dim);
    } else put(w, b, 3, 6, `${picker.progress.phase}  ${picker.progress.completed}/${picker.progress.total}`, text);
    picker.draw(w, pickerArea(b), true);
  }
}
/** Where the import picker draws: from the notes down to the message row. */
function pickerArea(b: Rect): Rect {
  return new Rect(b.x + 3, b.y + 8, b.w - 5, b.h - 13);
}
export function bounds(cols: number, rows: number): Rect {
  const w = Math.min(cols, 112),
    h = Math.min(rows, 36);
  return new Rect(Math.floor((cols - w) / 2), Math.floor((rows - h) / 2), w, h);
}
let border: string, text: string, bright: string, dim: string, warm: string, selected_style: string;
palette.derived(() => {
  border = new palette.Style({ fg: "line", bg: "surface" }).sgr();
  text = new palette.Style({ fg: "text", bg: "surface" }).sgr();
  bright = new palette.Style({ fg: "strong", bg: "surface", bold: true }).sgr();
  dim = new palette.Style({ fg: "faint", bg: "surface" }).sgr();
  warm = new palette.Style({ fg: "warm", bg: "surface" }).sgr();
  selected_style = new palette.Style({ fg: "text", bg: "selected" }).sgr();
});
function put(w: Writer, b: Rect, x: number, y: number, str: string, style: string) {
  if (x >= b.w - 1 || (y >= b.h - 1 && y !== 0)) return;
  w.write(`\x1b[${b.y + y + 1};${b.x + x + 1}H${style}`);
  writeSanitized(w, str, b.w - x - 2);
}
function box(w: Writer, b: Rect, on: boolean) {
  for (let row = 0; row < b.h; row++) {
    w.write(`\x1b[${b.y + row + 1};${b.x + 1}H${on ? selected_style : border}`);
    w.write(row === 0 ? "╭" : row === b.h - 1 ? "╰" : "│");
    if (row === 0 || row === b.h - 1) w.write("─".repeat(b.w - 2));
    else w.splat(" ", b.w - 2);
    w.write(row === 0 ? "╮" : row === b.h - 1 ? "╯" : "│");
  }
}
function footerHint(s: State): string {
  switch (s.step) {
    case "presets":
      return s.dismissable ? "Esc close · ↑↓ choose · P prefix · ? keymap" : "↑↓ choose · P prefix · ? keymap";
    case "keymap":
      return "";
    case "connect":
      return "Esc Back";
    case "import":
      if (s.picker.stage === "complete") return "";
      if (s.picker.stage === "copying") return "Esc Back";
      return s.picker.source === "herdr"
        ? "Esc · Space select · E expand · H handoff"
        : "Esc Back · Space select · E expand";
  }
}
// Rendering and mouse hit regions share one layout at every supported size.
export function presetLayout(b: Rect) {
  const card_w = b.w >= 100 ? 32 : 24;
  const x = card_w + 7;
  const detail = detailLayout(b.x + x, b.y + 6, b.w - x - 4, b.h < 32);
  return {
    cards: km.available_presets.map((_, i) => new Rect(b.x + 3, b.y + 6 + i * 4, card_w, 4)),
    hero: detail.hero,
    prefix: detail.prefix,
    split: detail.split,
    focus: detail.focus,
    detail_x: x,
    summary_y: 6 + detail.summary_y,
    help_y: 6 + detail.help_y,
  };
}
/** The keys a preset teaches, from the detail's top-left corner. Onboarding
 * draws it beside the preset cards; Corgi setup beside its preset options.
 * The summary and help rows count from `y`. */
export function detailLayout(x: number, y: number, width: number, compact: boolean) {
  const hero_h = compact ? 3 : 6;
  const prefix_h = width < 64 ? 4 : 3;
  const panes_y = hero_h + prefix_h;
  const panes_h = compact ? 6 : 7;
  const split_w = Math.floor((width - 2) / 2);
  const summary_y = panes_y + panes_h + (compact ? 0 : 1);
  return {
    hero: new Rect(x, y + prefix_h, width, hero_h),
    prefix: new Rect(x, y, width, prefix_h),
    split: new Rect(x, y + panes_y, split_w, panes_h),
    focus: new Rect(x + split_w + 2, y + panes_y, width - split_w - 2, panes_h),
    summary_y,
    help_y: summary_y + (compact ? 2 : 3),
  };
}
/** Rows the preset detail takes. */
export function detailHeight(width: number, compact: boolean): number {
  return detailLayout(0, 0, width, compact).help_y + 1;
}
/** What the preset detail shows: the preset, its prefix, and which of
 * onboarding's controls has keyboard focus (1 prefix, 2 full keymap). */
export type Keys = { preset: km.Preset; prefix: km.Prefix; focus: number };
/** An action's key on a card. Under cmux, whose cards teach held keys, a
 * prefixed key names the prefix too. */
export function cardKey(s: Pick<Keys, "preset" | "prefix">, act: Action): string {
  const b = bindings.find(s.preset, act);
  if (!b) return "";
  return (s.preset === "cmux" && b.prefixed ? km.prefixName(s.prefix) + " " : "") + bindings.compact(b);
}
const action = (name: string, value?: string) => (value === undefined ? { name } : { name, value }) as Action;
function drawPresets(w: Writer, b: Rect, s: State) {
  const layout = presetLayout(b);
  km.available_presets.forEach((preset, i) => {
    const card = layout.cards[i];
    const picked = s.preset === preset;
    box(w, card, picked);
    const dot = picked ? "●" : "○";
    const paw = preset === "corgi" ? "🐕 " : "";
    put(w, card, 2, 1, `${dot} ${paw}${km.name(preset)}`, picked ? selected_style : bright);
    const description = card.w >= 32 ? km.description(preset) : km.shortDescription(preset);
    put(w, card, 4, 2, description, picked ? selected_style : dim);
  });
  drawPresetDetail(w, layout.prefix.x, layout.prefix.y, layout.prefix.w, b.h < 32, s);
}
export function drawPresetDetail(w: Writer, x: number, y: number, width: number, compact: boolean, s: Keys) {
  const layout = detailLayout(x, y, width, compact);
  const direct = s.preset === "cmux";
  const prefix_name = km.prefixName(s.prefix);
  const hero = layout.hero;
  const narrow = hero.w < 64;
  box(w, hero, false);
  put(w, hero, 2, 0, narrow || hero.h === 3 ? " New tab → agent picker " : " New tab ", bright);
  const key_y = hero.h === 3 ? 1 : 2;
  put(w, hero, 3, key_y, `[ ${direct ? "Cmd" : prefix_name} ]`, palette.keycap);
  put(w, hero, direct ? 11 : 15, key_y, direct ? "+" : "then", text);
  put(w, hero, direct ? 15 : 22, key_y, `[ ${cardKey(s, action("new"))} ]`, bright);
  if (hero.h > 3) {
    if (narrow) {
      put(w, hero, 3, key_y + 2, "Choose an agent or terminal", text);
    } else {
      put(w, hero, 36, key_y, "Open the agent picker", text);
      put(w, hero, 36, key_y + 1, "Agent or new terminal", dim);
    }
  }

  const band = layout.prefix;
  box(w, band, false);
  put(w, band, 2, 1, direct ? "MODIFIER" : "PREFIX", bright);
  put(w, band, 12, 1, `[ ${direct ? "Cmd" : prefix_name} ]`, palette.keycap);
  const explanation = direct ? "Hold with the action key." : "Release, then press a key.";
  if (narrow) put(w, band, 2, 2, explanation, text);
  else put(w, band, 24, 1, explanation, text);
  if (!direct) put(w, band, band.w - 14, 1, "[ P change ]", s.focus === 1 ? palette.keycap : bright);

  const split = layout.split;
  box(w, split, false);
  put(w, split, 2, 0, " Split ", bright);
  const diagram_y = split.h === 6 ? 1 : 2;
  const diagram_w = split.w < 28 ? 5 : 9;
  const left_x = 2;
  const right_x = Math.floor(split.w / 2) + 1;
  drawSplitDiagram(w, new Rect(split.x + left_x, split.y + diagram_y, diagram_w, 3), false);
  drawSplitDiagram(w, new Rect(split.x + right_x, split.y + diagram_y, diagram_w, 3), true);
  put(w, split, left_x, diagram_y + 3, `${cardKey(s, action("split", "right"))} Right`, bright);
  put(w, split, right_x, diagram_y + 3, `${cardKey(s, action("split", "down"))} Down`, bright);

  const focus = layout.focus;
  box(w, focus, false);
  put(w, focus, 2, 0, " Focus pane ", bright);
  const nav_y = focus.h === 6 ? 1 : 2;
  put(
    w,
    focus,
    2,
    nav_y,
    direct ? "[ Cmd+Option ]" : s.preset === "tmux" ? "Arrow keys" : "Home row",
    direct ? palette.keycap : dim,
  );
  const nav_x = Math.floor((focus.w - 17) / 2);
  put(w, focus, nav_x + 6, nav_y + 1, `[ ${cardKey(s, action("focus", "up"))} ]`, bright);
  put(
    w,
    focus,
    nav_x,
    nav_y + 2,
    `[ ${cardKey(s, action("focus", "left"))} ] [ ${cardKey(s, action("focus", "down"))} ] [ ${cardKey(s, action("focus", "right"))} ]`,
    bright,
  );

  // The Command band applies to all direct keys; detach uses the portable prefix.
  const detail = new Rect(x, y, width, layout.help_y + 2);
  const col = Math.floor(detail.w / 3);
  put(w, detail, 0, layout.summary_y, "TABS", dim);
  put(w, detail, col, layout.summary_y, narrow ? "COPY" : "SCROLL / COPY", dim);
  put(w, detail, col * 2, layout.summary_y, "DETACH", dim);
  put(w, detail, 0, layout.summary_y + 1, `${cardKey(s, action("next"))} / ${cardKey(s, action("prev"))}`, bright);
  put(w, detail, col, layout.summary_y + 1, cardKey(s, action("copy-mode")), bright);
  put(w, detail, col * 2, layout.summary_y + 1, cardKey(s, action("detach")), bright);
  put(w, detail, 0, layout.help_y, "[ ? Full keymap ]", s.focus === 2 ? palette.keycap : bright);
  if (direct) {
    const prefix_hint = narrow ? `[ P ${prefix_name} ]` : `Prefix [ ${prefix_name} ]  P change`;
    put(w, detail, 22, layout.help_y, prefix_hint, s.focus === 1 ? palette.keycap : bright);
  } else if (!narrow) put(w, detail, 23, layout.help_y, `${prefix_name} twice sends it through.`, dim);
}
function drawSplitDiagram(w: Writer, b: Rect, down: boolean) {
  box(w, b, false);
  if (down) {
    w.write(`\x1b[${b.y + 2};${b.x + 1}H${border}├`);
    w.write("─".repeat(b.w - 2));
    w.write("┤");
  } else {
    for (let row = 0; row < 3; row++)
      w.write(
        `\x1b[${b.y + row + 1};${b.x + Math.floor(b.w / 2) + 1}H${border}${row === 0 ? "┬" : row === 2 ? "┴" : "│"}`,
      );
  }
}
function ghosttyHost(): boolean {
  return (
    ghostty_integration.available() &&
    process.env.GHOSTTY_RESOURCES_DIR !== undefined &&
    process.env.CMUX_WORKSPACE_ID === undefined
  );
}
