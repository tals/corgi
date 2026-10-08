import { test, expect } from "bun:test";
import { Terminal } from "../pane/terminal";
import { format } from "./probe";
test("checkpoint probe restores retained primary history cursor and input modes", () => {
  const old = Terminal.create(40, 6),
    fresh = Terminal.create(40, 6);
  try {
    old.feed("FIRST_HISTORY_LINE\r\n");
    for (let n = 0; n < 400; n++) old.feed("a line of retained terminal history\r\n");
    old.feed("\x1b[3;5H\x1b[31mRED\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[>1u");
    const saved = format(old);
    expect(saved.length).toBeGreaterThan(8192);
    fresh.feed(saved);
    const before = old.surface(0),
      after = fresh.surface(0);
    expect(after.surface.cursor).toEqual(before.surface.cursor);
    expect(fresh.bracketed_paste).toBe(true);
    expect(after.modes.mouse_event).toBe(before.modes.mouse_event);
    expect(after.modes.kitty).toBe(before.modes.kitty);
    expect(fresh.search("FIRST_HISTORY_LINE", 0).offset).not.toBeNull();
  } finally {
    fresh.destroy();
    old.destroy();
  }
});
test("checkpoint probe only preserves current keyboard flags not their push stack", () => {
  const old = Terminal.create(30, 5),
    fresh = Terminal.create(30, 5);
  try {
    old.feed("\x1b[>1u\x1b[>3u");
    fresh.feed(format(old));
    expect(fresh.native({ op: "info" }).modes.kitty).toBe(old.native({ op: "info" }).modes.kitty);
    old.feed("\x1b[<u");
    fresh.feed("\x1b[<u");
    expect(fresh.native({ op: "info" }).modes.kitty).not.toBe(old.native({ op: "info" }).modes.kitty);
  } finally {
    fresh.destroy();
    old.destroy();
  }
});
test("checkpoint probe formats the active alternate screen but omits inactive primary", () => {
  const old = Terminal.create(30, 5),
    fresh = Terminal.create(30, 5);
  try {
    old.feed("PRIMARY_ONLY\x1b[?1049hALTERNATE_CONTENT\x1b[2;3H");
    fresh.feed(format(old));
    expect(fresh.search("ALTERNATE_CONTENT", 0).offset).not.toBeNull();
    fresh.feed("\x1b[?1049l");
    expect(fresh.search("PRIMARY_ONLY", 0).offset).toBeNull();
  } finally {
    fresh.destroy();
    old.destroy();
  }
});
test("checkpoint probe does not preserve a partially parsed escape", () => {
  const old = Terminal.create(30, 5),
    fresh = Terminal.create(30, 5);
  try {
    old.feed("before\x1b[31;");
    fresh.feed(format(old));
    old.feed("1mAFTER");
    fresh.feed("1mAFTER");
    expect(old.text()).toContain("beforeAFTER");
    expect(fresh.text()).toContain("before1mAFTER");
  } finally {
    fresh.destroy();
    old.destroy();
  }
});
