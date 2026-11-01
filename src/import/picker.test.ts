import { expect, test } from "bun:test";
import { Picker } from "./picker";
import { Worker, workspace, pane } from "./catalog";
import { Rect } from "../layout";
import { Writer } from "../text";
import * as i18n from "../i18n";
import * as cmux from "./cmux";

function picker(names: string[]): Picker {
  const p = new Picker(),
    worker = new Worker("tmux");
  worker.done = true;
  worker.catalog.workspaces = names.map((name, i) =>
    workspace({ id: String(i), name, tabs: [{ id: name, name, nodes: [], panes: [pane({ id: name, name })] }] }),
  );
  p.workers.set("tmux", worker);
  return p;
}

test("tmux selects at most three recent groups once per discovery", () => {
  const p = picker(["first", "second", "third", "fourth"]);
  p.selectDefaults();
  expect(p.selected.slice(0, 4)).toEqual([true, true, true, false]);
  p.selected[0] = false;
  p.scan();
  p.selectDefaults();
  expect(p.selected[0]).toBe(false);
  p.close();
});

test("the cursor stops at either end unless it wraps", () => {
  const p = picker(["first", "second"]);
  p.move(false, false);
  expect(p.cursor).toBe(0);
  p.move(false, true);
  expect(p.cursor).toBe(1);
  p.move(true, false);
  expect(p.cursor).toBe(1);
  p.move(true, true);
  expect(p.cursor).toBe(0);
  p.close();
});

test("clicks land on the rows the tree draws", () => {
  const p = picker(["first", "second"]),
    area = new Rect(2, 5, 40, 12),
    w = new Writer();
  p.draw(w, area, true);
  // Notes take three rows; each workspace takes its row, its tab and a gap.
  expect(p.hit(area, 4, 8)).toEqual({ select: 0 });
  expect(p.hit(area, 4, 11)).toEqual({ select: 1 });
  expect(p.hit(area, 4, 9)).toBeNull();
  expect(p.hit(area, 50, 8)).toBeNull();
  p.click({ select: 1 });
  expect(p.cursor).toBe(1);
  expect(p.selected[1]).toBe(false);
  p.close();
});

test("Herdr's handoff switch is the first row the cursor stops on", () => {
  const p = picker(["first", "second"]);
  p.source = "herdr";
  p.workers.set("herdr", p.workers.get("tmux")!);
  p.move(false, false);
  expect(p.switch_focused).toBe(true);
  // Space flips the switch there, and the workspace cursor stays put.
  p.key(32);
  expect(p.handoff).toBe(false);
  expect(p.cursor).toBe(0);
  p.move(false, true);
  expect(p.switch_focused).toBe(false);
  expect(p.cursor).toBe(1);
  p.move(true, true);
  expect(p.switch_focused).toBe(true);
  p.move(true, false);
  expect(p.cursor).toBe(0);
  p.click({ handoff: true });
  expect(p.switch_focused).toBe(true);
  expect(p.handoff).toBe(true);
  p.close();
});

test("import progress follows the viewer language and keeps failure details", () => {
  const p = new Picker();
  p.stage = "copying";
  const phases = ["copying", "connecting", "receiving", "preparing", "committing"] as const;
  p.progress.message = "Daemon diagnostic, not display text";
  const english = phases.map(phase => {
    p.progress.phase = phase;
    return p.summary();
  });
  for (const language of i18n.locales.filter(language => language !== "en")) {
    i18n.setLanguage(language);
    for (const [i, phase] of phases.entries()) {
      p.progress.phase = phase;
      expect(p.summary()).not.toBe(english[i]);
      expect(p.summary()).not.toBe(p.progress.message);
      expect(p.summary().length).toBeGreaterThan(0);
    }
    p.progress.phase = "failed";
    expect(p.summary()).toBe(p.progress.message);
  }
});

test("cmux recovery labels change language without changing imported names", () => {
  const p = new Picker(),
    worker = new Worker("cmux");
  p.source = "cmux";
  p.workers.set("cmux", worker);
  worker.done = true;
  worker.catalog.workspaces = [cmux.convert({ id: "user workspace" })!];
  const area = new Rect(0, 0, 150, 30),
    w = new Writer();
  for (const language of i18n.locales) {
    i18n.setLanguage(language);
    w.clear();
    p.draw(w, area, true);
    expect(w.s).toContain("user workspace");
    expect(w.s).toContain(i18n.t`Couldn't read its panes or tabs`);
    expect(w.s).toContain(i18n.t`New shell`);
    if (language !== "en") {
      expect(w.s).not.toContain("Couldn't read its panes or tabs");
      expect(w.s).not.toContain("New shell");
    }
  }
  worker.catalog.workspaces = [];
  worker.catalog.confused = true;
  worker.catalog.note = "cmux";
  w.clear();
  p.draw(w, area, true);
  expect(w.s).toContain(i18n.t`Couldn't read the workspace list. R refreshes.`);
  p.close();
});
