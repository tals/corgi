import * as keys from "../src/keys";
import * as keyboard from "../src/keyboard";

type Input = { kind: "key"; data: string } | { kind: "paste"; data: string };

/** A fake agent still needs a streaming terminal parser: reads are not keys. */
export class Parser {
  private buffer = "";
  private pasted: string | null = null;
  private decoder = new TextDecoder();

  read(bytes: Uint8Array): Input[] {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    const events: Input[] = [];
    while (this.buffer) {
      if (this.pasted !== null) {
        const end = this.buffer.indexOf(keys.paste_end);
        if (end < 0) {
          const keep = Math.min(this.buffer.length, keys.paste_end.length - 1);
          this.pasted += this.buffer.slice(0, this.buffer.length - keep);
          this.buffer = this.buffer.slice(this.buffer.length - keep);
          break;
        }
        events.push({ kind: "paste", data: this.pasted + this.buffer.slice(0, end) });
        this.buffer = this.buffer.slice(end + keys.paste_end.length);
        this.pasted = null;
        continue;
      }
      let data = String.fromCodePoint(this.buffer.codePointAt(0)!);
      if (data === "\x1b") {
        if (this.buffer.length === 1) break;
        if (this.buffer[1] === "[" || this.buffer[1] === "O") {
          const match = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|O.)/.exec(this.buffer);
          if (!match) break;
          data = match[0];
        } else data = this.buffer.slice(0, 2);
      }
      this.buffer = this.buffer.slice(data.length);
      if (data === keys.paste_start) this.pasted = "";
      else events.push({ kind: "key", data });
    }
    return events;
  }
}

/** Independent little editor for the sandbox; no prediction code is used. */
export class Editor {
  text = "";
  caret = 0;

  clear(): void {
    this.text = "";
    this.caret = 0;
  }
  insert(value: string): void {
    this.text = this.text.slice(0, this.caret) + value + this.text.slice(this.caret);
    this.caret += value.length;
  }
  key(data: string): "submit" | "exit" | "edit" | "ignore" {
    const named = keys.parse(data);
    const before = this.text.slice(0, this.caret),
      after = this.text.slice(this.caret);
    const previous = before.length - (Array.from(before).at(-1)?.length ?? 0);
    const next = this.caret + (Array.from(after)[0]?.length ?? 0);
    switch (named ?? data) {
      case "\r":
      case "\n":
        return "submit";
      case "\x03":
        return "exit";
      case "left":
        this.caret = previous;
        break;
      case "right":
        this.caret = next;
        break;
      case "home":
      case "\x01":
        this.caret = before.lastIndexOf("\n") + 1;
        break;
      case "end":
      case "\x05":
        this.caret += after.indexOf("\n") < 0 ? after.length : after.indexOf("\n");
        break;
      case "up":
      case "down": {
        const rows = this.text.split("\n"),
          row = before.split("\n").length - 1;
        const destination = row + (named === "up" ? -1 : 1);
        if (destination < 0 || destination >= rows.length) break;
        const column = this.caret - (before.lastIndexOf("\n") + 1);
        this.caret =
          rows.slice(0, destination).reduce((n, line) => n + line.length + 1, 0) +
          Math.min(column, rows[destination].length);
        break;
      }
      case "alt_left":
      case "ctrl_left":
      case "alt_b":
        this.caret -= /\W*\w*$/.exec(before)![0].length;
        break;
      case "alt_right":
      case "ctrl_right":
      case "alt_f":
        this.caret += /^\W*\w*/.exec(after)![0].length;
        break;
      case "\x7f":
      case "\b":
        this.text = this.text.slice(0, previous) + after;
        this.caret = previous;
        break;
      case "delete":
        this.text = before + this.text.slice(next);
        break;
      case "alt_backspace":
      case "\x17": {
        const count = /\W*\w*$/.exec(before)![0].length;
        this.text = before.slice(0, before.length - count) + after;
        this.caret -= count;
        break;
      }
      case "alt_delete":
      case "ctrl_delete":
      case "alt_d":
        this.text = before + after.replace(/^\W*\w*/, "");
        break;
      case "\x15":
        this.text = before.slice(0, before.lastIndexOf("\n") + 1) + after;
        this.caret = before.lastIndexOf("\n") + 1;
        break;
      case "\x0b":
        this.text = before + after.slice(after.indexOf("\n") < 0 ? after.length : after.indexOf("\n"));
        break;
      case "alt_enter":
        this.insert("\n");
        break;
      default: {
        const key = keyboard.decode(data);
        if (key && !key.mods.alt && !key.mods.ctrl && !key.mods.super) {
          if (key.codepoint === 13) return "submit";
          if (key.codepoint === 127) return this.key("\x7f");
          if (key.codepoint >= 32 && key.codepoint < 57344) {
            this.insert(String.fromCodePoint(key.codepoint));
            break;
          }
        }
        if (data.startsWith("\x1b") || /[\x00-\x1f\x7f]/.test(data)) return "ignore";
        this.insert(data);
      }
    }
    return "edit";
  }
  layout(width: number, provider: "claude" | "codex" = "claude"): { lines: string[]; x: number; y: number } {
    const lines: string[] = [];
    let offset = 0,
      x = 0,
      y = 0;
    for (const paragraph of this.text.split("\n")) {
      let start = 0;
      do {
        let end = start;
        for (const character of paragraph.slice(start)) {
          if (Bun.stringWidth(paragraph.slice(start, end) + character) > width) break;
          end += character.length;
        }
        if (end === start && end < paragraph.length) end += String.fromCodePoint(paragraph.codePointAt(end)!).length;
        let next = end;
        if (end < paragraph.length) {
          const space = paragraph.lastIndexOf(" ", end);
          const wordEnd = paragraph.indexOf(" ", space + 1);
          if (
            space > start &&
            (provider === "codex" ||
              Bun.stringWidth(paragraph.slice(space + 1, wordEnd < 0 ? undefined : wordEnd)) <= width)
          ) {
            end = space;
            next = space + 1;
          }
        }
        if (this.caret >= offset + start) {
          x = Bun.stringWidth(paragraph.slice(start, Math.min(end, this.caret - offset)));
          y = lines.length;
        }
        lines.push(paragraph.slice(start, end));
        start = next;
      } while (start < paragraph.length);
      if (provider === "codex" && Bun.stringWidth(lines.at(-1)!) === width) {
        if (this.caret >= offset + paragraph.length) {
          x = 0;
          y = lines.length;
        }
        lines.push("");
      }
      offset += paragraph.length + 1;
    }
    return { lines, x, y };
  }
}
