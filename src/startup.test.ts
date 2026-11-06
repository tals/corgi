import { test, expect } from "bun:test";
import * as startup from "./startup";
import * as card from "./startup_card";
import * as i18n from "./i18n";
import { Writer } from "./text";
import { Terminal } from "./pane/terminal";

const wait = (id: string): startup.Wait => ({
  id,
  pane: Number(id),
  provider: "opencode2",
  phase: "service",
  detail: "Downloading package",
  started_at: 1000,
  cancelled: false,
});

test("only explicit installer output establishes installation", () => {
  expect(startup.installing("mise opencode@2.1.2 downloading")).toBe(true);
  expect(startup.installing("\x1b[32mmise\x1b[0m opencode@2 extracting archive")).toBe(true);
  for (const line of [
    "Downloading models",
    "mise WARN unable to resolve version",
    "OpenCode is not installed",
    "mise opencode@2 installed",
  ])
    expect(startup.installing(line)).toBe(false);
  expect(startup.decode(undefined)).toEqual([]);
  expect(
    startup.decode([{ ...wait("1"), phase: "other" }, null, { ...wait("2"), detail: "bad\x1b[2J\routput" }]),
  ).toEqual([{ ...wait("2"), detail: "bad output" }]);
});

test("the shared banner counts waits and shows elapsed time after its initial grace period", () => {
  expect(card.banner([wait("1")], 100, 30, 1499)).toBeNull();
  const banner = card.banner([wait("1"), wait("2")], 100, 30, 13000)!;
  expect(banner.text).toContain("2 waiting");
  expect(banner.text).toContain("12s");
  expect(banner.rect.x + banner.rect.w).toBe(100);
  expect(card.elapsed(wait("1"), 126000)).toBe("2m 5s");
});

test.each([11, 12])("%i-line terminals ignore clicks below visible startup rows", height => {
  const state = new card.State(),
    waits = [wait("1"), wait("2"), wait("3")],
    rect = card.geometry(80, height, waits.length)!;
  for (const selected of ["1", "2"]) {
    state.selected = selected;
    for (let row = 2; row < 5; row++)
      expect(state.hit(rect, waits, rect.x + 2, rect.y + row)).toEqual({
        name: "startup-select",
        value: selected,
      });
    for (let row = 5; row < rect.h - 2; row++) expect(state.hit(rect, waits, rect.x + 2, rect.y + row)).toBeNull();
  }
});

test("the waits panel keeps selection by identity, scrolls, and kills the displayed wait in every language", () => {
  const language = i18n.language();
  try {
    for (const locale of i18n.locales) {
      i18n.setLanguage(locale);
      for (const width of [40, 80, 120]) {
        const state = new card.State(),
          waits = Array.from({ length: 12 }, (_, i) => wait(String(i + 1))),
          rect = card.geometry(width, 20, waits.length)!,
          terminal = new Terminal(width, 20);
        try {
          state.selected = "8";
          state.sync(waits.slice(1));
          expect(state.selected).toBe("8");
          const w = new Writer();
          state.draw(w, rect, waits, 13000);
          terminal.feed(w.buffered());
          expect(state.key("x")).toEqual({ name: "startup-kill", value: "8" });
          expect(state.hit(rect, waits, rect.x + rect.w - 4, rect.y + rect.h - 2)).toEqual({
            name: "startup-kill",
            value: "8",
          });
          expect(terminal.surface(0).surface.lines.length).toBe(20);
          expect(card.geometry(width, 9, waits.length)).toBeNull();
        } finally {
          terminal.destroy();
        }
      }
    }
  } finally {
    i18n.setLanguage(language);
  }
});
