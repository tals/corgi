/** Draws the live view on a terminal: frames redrawn in place below the
 * command line, or (`verbose`) pinned at the top with the log scrolling
 * below them. All output goes through `write`, so the screen can be tested
 * and can run in a worker. Every frame is one synchronized write. */
import * as term from "./term";

/** Rows a pinned frame always leaves for the log below it. */
const logRows = 5;

const at = (row: number) => `\x1b[${row};1H`;
const clearLine = "\x1b[2K";
const clearBelow = "\x1b[0J";

/** Escape sequences and control characters other than tab and newline. */
const controls =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[^[\]]?|[\x00-\x08\x0a-\x1a\x1c-\x1f\x7f-\x9f]/g;
/** The sequences a log line keeps: colors and complete OSC 8 links. */
const kept = (s: string) => /^\x1b\[[0-9;:]*m$/.test(s) || /^\x1b\]8;.*(?:\x07|\x1b\\)$/.test(s);

/** A log line as it may go on screen: only the text after its last carriage
 * return (what a progress bar leaves), no cursor movement or other control,
 * tabs as spaces, and colors reset at the end. Its rows can then be counted. */
function tidy(line: string): string {
  const text = line.replace(/\r+$/, ""),
    last = text.slice(text.lastIndexOf("\r") + 1).replace(controls, s => (kept(s) ? s : ""));
  let out = "";
  last.split("\t").forEach((part, i) => {
    if (i) out += " ".repeat(8 - (term.width(out) % 8));
    out += part;
  });
  return out.includes("\x1b[") && !/\x1b\[0?m$/.test(out) ? `${out}\x1b[0m` : out;
}

export class Screen {
  /** Inline: the width of each line of the frame above the cursor, to move
   * back over on the next draw. */
  private shown: number[] = [];
  private hidden = false;
  private paused = false;
  private done = false;
  /** Verbose: the old screen was pushed into the scrollback and a frame pinned. */
  private pinned = false;
  /** Verbose: the rows the pinned frame takes, and the terminal size it was
   * drawn at. */
  private top = 0;
  private painted = "";
  /** Verbose: the scroll region last set, and the terminal size it was set
   * at (a resize resets it). */
  private region = "";
  private regionSize = "";
  /** Verbose: the row the next log line goes to. */
  private next = 1;
  /** Verbose: every log line, written to the scrollback at the end. */
  private logged: string[] = [];
  /** Verbose: log lines not on screen yet (before the first frame, or while suspended). */
  private waiting: string[] = [];

  constructor(
    private readonly o: { write: (s: string) => void; rows: () => number; cols: () => number; verbose: boolean },
  ) {}

  /** Replaces the frame on screen with `lines`, cut to what fits. */
  draw(lines: string[]): void {
    if (this.paused || this.done) return;
    this.o.write(term.sync(true) + (this.o.verbose ? this.pin(lines) : this.inline(lines)) + term.sync(false));
  }

  /** The lines a frame has room for: inline all rows but the cursor's, pinned
   * all but the rows left for the log. A longer frame is cut from the bottom. */
  room(): number {
    return Math.max(1, this.o.rows() - (this.o.verbose ? logRows : 1));
  }

  /** Verbose: adds `lines` to the log under the frame. Ignored otherwise. */
  log(lines: string[]): void {
    if (!this.o.verbose || this.done) return;
    const tidied = lines.flatMap(l => l.split("\n")).map(tidy);
    this.logged.push(...tidied);
    this.waiting.push(...tidied);
    if (this.pinned && !this.paused) this.o.write(term.sync(true) + this.flush() + term.sync(false));
  }

  /** Verbose: adds `lines` to the log the finish writes to the scrollback,
   * without writing them now: what went to the terminal some other way, like
   * a question and its answer. Ignored otherwise. */
  keep(lines: string[]): void {
    if (!this.o.verbose || this.done) return;
    this.logged.push(...lines.flatMap(l => l.split("\n")).map(tidy));
  }

  /** Stops drawing and shows the cursor so a question can be asked: inline,
   * the frame is cleared first (the question names what it is about), so no
   * stale frame stays in the scrollback; pinned, it stays at the top. */
  suspend(): void {
    if (this.paused || this.done) return;
    this.paused = true;
    this.hidden = false;
    const clear = this.o.verbose ? "" : this.erase();
    this.shown = [];
    this.o.write(clear + (this.pinned ? at(this.next) : "") + term.cursor(true));
  }

  /** Draws again after `suspend`, hiding the cursor. */
  resume(): void {
    if (!this.paused || this.done) return;
    this.paused = false;
    // The question and its answer took rows in the log we can't count:
    // go on from the last row, where the region scrolls.
    if (this.pinned) this.next = this.o.rows();
    this.o.write(term.sync(true) + this.hide() + (this.pinned ? this.flush() : "") + term.sync(false));
  }

  /** Replaces the frame with `card`, which stays in the scrollback, and puts
   * the terminal back. Verbose writes the whole log above the card first,
   * since the lines that scrolled in the region never reached the scrollback. */
  finish(card: string[]): void {
    if (this.done) return;
    this.done = true;
    let out = term.sync(true);
    if (!this.o.verbose) out += this.erase();
    else {
      // The whole screen scrolls again and the replay starts from the top,
      // so the region reset may home the cursor here.
      if (this.pinned) out += term.scrollRegion(1, null) + "\x1b[H" + clearBelow;
      out += this.logged.map(l => `${l}\n`).join("");
    }
    this.o.write(out + card.map(l => `${l}\n`).join("") + term.restore());
  }

  /** What puts the terminal back from where this screen left it (a pinned
   * frame also moves the cursor below the log). Not written: the caller writes
   * it, from whichever thread is still running. */
  restore(): string {
    return term.restore() + (this.pinned && !this.done ? `${at(this.o.rows())}\n` : "");
  }

  private hide(): string {
    if (this.hidden) return "";
    this.hidden = true;
    return term.cursor(false);
  }

  /** Moves up over the frame drawn last and clears from there. A narrower
   * terminal rewraps (reflows) the old frame's lines: each takes as many rows
   * as its width needs at the new width, and a wider one keeps one row each. */
  private erase(): string {
    const cols = Math.max(1, this.o.cols()),
      n = this.shown.reduce((rows, w) => rows + Math.max(1, Math.ceil(w / cols)), 0);
    this.shown = [];
    return n ? `\x1b[${n}A${clearBelow}` : "";
  }

  private inline(lines: string[]): string {
    const frame = lines.slice(0, this.room()),
      out = this.erase() + this.hide() + frame.map(l => `${l}\n`).join("");
    this.shown = frame.map(l => term.width(l));
    return out;
  }

  private pin(lines: string[]): string {
    const rows = this.o.rows(),
      frame = lines.slice(0, this.room());
    const size = `${rows}x${this.o.cols()}`;
    let out = "",
      clear = this.top;
    if (!this.pinned) {
      // Push what was on screen into the scrollback, leaving it blank.
      out += "\n".repeat(rows);
      this.pinned = true;
    } else if (size !== this.painted) {
      // A resize rewrapped the frame and the log into rows that can't be known:
      // clear them all, then draw the frame and the end of the log again.
      clear = rows;
      this.waiting = this.logged.slice(-Math.max(1, rows - frame.length));
      this.next = frame.length + 1;
    }
    this.painted = size;
    out += this.hide() + frame.map((l, i) => at(i + 1) + clearLine + l).join("");
    for (let row = frame.length + 1; row <= clear; row++) out += at(row) + clearLine;
    this.top = frame.length;
    return out + this.margins() + this.flush();
  }

  /** The scroll region below the frame, when it isn't set as it should be:
   * the frame's height or the terminal's size changed (a resize resets the
   * region). Keeps the next log row inside it. */
  private margins(): string {
    const rows = this.o.rows(),
      size = `${rows}x${this.o.cols()}`,
      region = term.scrollRegion(this.top + 1, rows);
    this.next = Math.min(rows, Math.max(this.next, this.top + 1));
    if (region === this.region && size === this.regionSize) return "";
    this.region = region;
    this.regionSize = size;
    return region;
  }

  /** Writes the waiting log lines from the next log row. A line at the last
   * row scrolls the region, so the frame above stays put. */
  private flush(): string {
    if (!this.waiting.length) return "";
    const rows = this.o.rows(),
      cols = Math.max(1, this.o.cols());
    // Setting the region moves the cursor home, so it comes first.
    let out = this.margins() + at(this.next);
    for (const line of this.waiting) {
      out += `${clearLine}${line}\n`;
      this.next = Math.min(rows, this.next + Math.max(1, Math.ceil(term.width(line) / cols)));
    }
    this.waiting = [];
    return out;
  }
}
