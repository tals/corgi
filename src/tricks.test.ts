import { expect, test } from "bun:test";
import * as tricks from "./tricks";
import * as trickHost from "./trick_host";
import * as trickUi from "./trick_ui";
import * as sidebar from "./sidebar";
import * as palette from "./palette";
import * as cli from "./cli";
import { Rect } from "./layout";
import { Writer } from "./text";
import { Terminal } from "./pane/terminal";

test("a sketch manifest only names its entry point", () => {
  const m = trickHost.manifest('version = 1\nid = "account-colors"\nentry = "main.mjs"');
  expect(m.entry).toBe("main.mjs");
  expect(m.command).toBeNull();
  expect(m.subscribe.events).toEqual([]);
  expect(() => trickHost.manifest('version = 99\nid = "test"\nentry = "main.mjs"')).toThrow("UnsupportedTrickVersion");
  expect(() => trickHost.manifest('version = 1\nid = "../test"\nentry = "main.mjs"')).toThrow("InvalidKey");
  expect(() => trickHost.manifest('version = 1\nid = "test"\nentry = "main.mjs"\ncommand = ["node"]')).toThrow(
    "InvalidEntry",
  );
  expect(() =>
    trickHost.manifest('version = 1\nid = "test"\nentry = "main.mjs"\n[subscribe]\nevents = ["snapshot"]'),
  ).toThrow("SubscribeInRegister");
});

test("selectors distinguish default accounts and validate subscription names", () => {
  const all = tricks.subscription({ events: ["metadata:*"], where: { provider: "claude", account: "" } });
  expect(all.events).toEqual([...tricks.metadata_events]);
  expect(tricks.subscription({ events: "transcript" }).events).toEqual(["transcript"]);
  expect(tricks.subscription({ events: ["metadata:*", "transcript"] }).events).toEqual([...tricks.events]);
  expect(() => tricks.subscription({ events: "*" })).toThrow("InvalidEvents");
  expect(() => tricks.subscription({ events: ["*"] })).toThrow("InvalidEvents");
  expect(tricks.matches(all.where, { provider: "claude", account: "" })).toBe(true);
  expect(tricks.matches(all.where, { provider: "claude", account: "/company" })).toBe(false);
  expect(tricks.matches(all.where, { provider: "codex", account: "" })).toBe(false);
  expect(() => tricks.subscription({ events: ["agent.change"] })).toThrow("InvalidEvents");
  expect(() => tricks.selector({ acount: "" })).toThrow("UnknownField");
  expect(() => tricks.selector({ provider: "missing" })).toThrow("InvalidProvider");
});

test("UI rejects terminal controls, oversized text and unknown colors", () => {
  for (const text of ["\x1b[2J", "\nhello", "\u009b2J", "x".repeat(513)])
    expect(() => tricks.view({ kind: "overlay", lines: [[{ text }]] })).toThrow();
  expect(() => tricks.view({ kind: "decorate", marker: "blue" })).toThrow("InvalidColor");
  expect(() => tricks.view({ kind: "decorate", account: "company" })).toThrow("UnknownField");
  expect(() => tricks.view({ kind: "overlay", lines: Array(13).fill([]) })).toThrow("InvalidLines");
  expect(tricks.views(undefined)).toEqual([]);
  expect(tricks.views([{ kind: "unknown" }, { kind: "decorate", marker: "#83b6ef" }])).toHaveLength(1);
});

test("account rules remain applicable to future agents and compose with provider flourishes", () => {
  const views = tricks.views([
    { kind: "decorate", where: { provider: "claude" }, suffix: [{ text: " ✦", color: "warm" }] },
    { kind: "decorate", where: { provider: "claude", account: "/company" }, marker: "accent", color: "hot" },
    { kind: "decorate", where: { id: "pane:2" }, color: "strong" },
  ]);
  expect(trickUi.decoration(views, { id: "pane:2", provider: "claude", account: "/company" })).toEqual({
    marker: "accent",
    color: "strong",
    suffix: [{ text: " ✦", color: "warm" }],
  });
  expect(trickUi.decoration(views, { id: "pane:99", provider: "claude", account: "/company" }).marker).toBe("accent");
  expect(trickUi.decoration(views, { provider: "claude", account: "" }).marker).toBeUndefined();
});

test("flat and grouped agent rows retain dim identity markers and brighter focus", () => {
  for (const grouped of [false, true])
    for (const focused of [false, true]) {
      const decoration = trickUi.decoration(
        tricks.views([{ kind: "decorate", marker: "warm", color: "hot", suffix: [{ text: "✦" }] }]),
        {},
      );
      const e = sidebar.entry({ target: { pane: 1 }, name: "Company", provider: "claude", focused, decoration });
      const v = sidebar.View.init(100, 30, true, 0, 1),
        w = new Writer();
      v.corgi_intensity = 0;
      v.drawAgent(w, e, 0, 3, grouped, true, false, false, false, 0, null);
      const terminal = new Terminal(100, 30);
      try {
        terminal.feed(w.s);
        expect(terminal.text()).toContain("Company ✦");
        expect(w.s).toContain(palette.fg("hot"));
        expect(w.s).toContain(
          palette.fgRgb(
            palette.mix(palette.colors.warm, focused ? palette.colors.selected : palette.colors.bg, focused ? 0 : 45),
          ),
        );
        expect(terminal.text()).toContain(grouped ? (focused ? "┣" : "╰") : focused ? "┃" : "│");
      } finally {
        terminal.destroy();
      }
    }
});

test("overlays clip wide text inside the pane area and stack", () => {
  const views = tricks.views(
    Array.from({ length: 4 }, () => ({ kind: "overlay", lines: [[{ text: "猫".repeat(100) }]] })),
  );
  const w = new Writer(),
    area = new Rect(28, 1, 30, 8);
  const boxes = trickUi.overlays(w, views, area);
  expect(boxes).toHaveLength(3);
  for (const box of boxes) {
    expect(box.x).toBeGreaterThanOrEqual(area.x);
    expect(box.x + box.w).toBeLessThanOrEqual(area.x + area.w);
    expect(box.y + box.h).toBeLessThanOrEqual(area.y + area.h);
  }
  expect(trickUi.overlays(new Writer(), views, new Rect(0, 0, 2, 2))).toEqual([]);
});

test("tricks CLI lists and reloads without a pane target", async () => {
  expect(await cli.parse(["tricks", "list", "--json"])).toMatchObject({ action: "tricks.list", json: true });
  expect(await cli.parse(["tricks", "reload"])).toMatchObject({ action: "tricks.reload" });
  await expect(cli.parse(["tricks", "remove"])).rejects.toThrow("Usage");
});
