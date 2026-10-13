import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspace, pane, recentFirst, copyWorkspaces, cmuxSession, cmuxDetected, available_sources } from "./catalog";
import { max_panes } from "../layout";
test("tmux groups sort by recent activity across sockets", () => {
  const groups = [
    workspace({ id: "$0", name: "old", socket: "a", activity: 10, tabs: [] }),
    workspace({ id: "$0", name: "new", socket: "b", activity: 30, tabs: [] }),
    workspace({
      id: "$1",
      name: "middle",
      socket: "a",
      activity: 20,
      tabs: [],
    }),
  ].sort(recentFirst);
  expect(groups.map(w => w.name)).toEqual(["new", "middle", "old"]);
});
test("copy text fits the RPC budget at full pane capacity without changing discovery", () => {
  const panes = Array.from({ length: max_panes }, () =>
      pane({
        id: "%0",
        name: "tig",
        screen: "\\".repeat(65536),
        history: "\\".repeat(65536),
        restart_command: "\\".repeat(2048),
      }),
    ),
    out = copyWorkspaces([
      workspace({
        id: "$0",
        name: "session",
        tabs: [{ id: "@0", name: "tab", panes, nodes: [] }],
      }),
    ]);
  expect(
    Buffer.byteLength(
      JSON.stringify({
        op: "onboarding.copy",
        source: "tmux",
        workspaces: out,
      }),
    ),
  ).toBeLessThan(1024 * 1024);
  expect(panes[0].screen.length).toBe(65536);
  expect(out[0].tabs[0].panes[0].screen.length).toBeLessThan(panes[0].screen.length);
});
test("cmux reads the newest saved session, never the one kept for manual restore", () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-cmux-")),
    save = (name: string, seconds: number) => {
      writeFileSync(join(dir, name), JSON.stringify({ name }));
      utimesSync(join(dir, name), seconds, seconds);
    };
  try {
    save("session-com.cmuxterm.app.json", 1000);
    save("session-com.cmuxterm.app.nightly.json", 2000);
    save("session-com.cmuxterm.app.nightly-previous.json", 3000);
    expect(cmuxSession(dir)).toEqual({ name: "session-com.cmuxterm.app.nightly.json" });
    expect(cmuxSession(join(dir, "missing"))).toBe(null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("cmux is offered on macOS once it has saved a session, never elsewhere", () => {
  const home = mkdtempSync(join(tmpdir(), "corgi-home-")),
    support = join(home, "Library/Application Support/cmux");
  try {
    mkdirSync(support, { recursive: true });
    writeFileSync(join(support, "session-com.cmuxterm.app.json"), "{}");
    expect(cmuxDetected(home)).toBe(process.platform === "darwin");
    expect(available_sources.includes("cmux")).toBe(cmuxDetected(process.env.HOME));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
