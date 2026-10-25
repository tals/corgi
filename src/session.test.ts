import * as protocol from "./protocol";
import { test, expect } from "bun:test";
import { Runtime, Pane } from "./runtime";
import { Workspace } from "./workspace";
import { Terminal } from "./pane/terminal";
import { execute, location, snapshot, viewerSnapshot } from "./session";
import { stringify } from "./json";
import * as worktrees from "./worktrees";
import { parseInventory } from "./trackers/worktrees";
import { Path } from "./bounded_text";
const ctx = { socket: "/tmp/corgi-test", executable: "/bin/corgi", theme: {} };
function setup() {
  const r = new Runtime(),
    home = new Workspace(1, "/tmp"),
    away = new Workspace(2, "/tmp");
  r.workspaces.items = [home, away];
  return { r, home, away };
}
function pane(r: Runtime, w: Workspace, split: number | null = null) {
  w.model.next_id = r.workspaces.next_pane_id;
  const id = split === null ? w.model.newTab("") : w.model.split(split, "horizontal");
  r.workspaces.next_pane_id = w.model.next_id;
  r.panes.push(new Pane(id, Terminal.create(20, 4), "/tmp"));
  return id;
}
const topology = (r: Runtime) => stringify(r.workspaces.items.map(w => w.model));
test("forking uses the conversation's listed worktree, preserving a folder within it", async () => {
  const { r, home } = setup();
  try {
    home.worktrees = {
      common_dir: "/tmp/.git",
      base: null,
      stale: false,
      agents: [],
      entries: parseInventory("worktree /tmp\0\0worktree /tmp/linked\0\0"),
    };
    const id = pane(r, home),
      source = r.pane(id)!,
      actor = r.conversations.get("codex", "11111111-1111-4111-8111-111111111111");
    source.attachment.select(actor);
    source.cwd = "/tmp/shell";
    const directories: string[] = [];
    r.forkAgent = async (opts, target) => {
      directories.push(opts.cwd);
      return target;
    };
    const fork = () => execute(r, ctx, { "agent.fork": { target: id, name: null, check: false } });
    worktrees.recordPlacement(actor.state, home.worktrees.common_dir, [
      { target: { pane: id }, path: "/tmp/linked", source: "write", stale: false },
    ]);
    actor.state.cwd = new Path("/tmp");
    await fork();
    actor.state.cwd = new Path("/tmp/linked/src");
    await fork();
    worktrees.recordPlacement(actor.state, home.worktrees.common_dir, []);
    actor.state.cwd = new Path("/tmp/agent");
    await fork();
    actor.state.cwd = new Path();
    await fork();
    expect(directories).toEqual(["/tmp/linked", "/tmp/linked/src", "/tmp/agent", "/tmp/shell"]);
  } finally {
    r.destroy();
  }
});
test("the first snapshot places a reopened conversation without waiting for discovery", async () => {
  const { r, home } = setup();
  try {
    home.worktrees = {
      common_dir: "/tmp/project/.git",
      base: null,
      stale: false,
      agents: [],
      entries: parseInventory(
        "worktree /tmp\0branch refs/heads/main\0\0worktree /tmp/linked\0branch refs/heads/feature\0\0",
      ),
    };
    const id = pane(r, home),
      actor = r.conversations.get("codex", "known");
    r.pane(id)!.attachment.select(actor);
    r.pane(id)!.dormant = true;
    worktrees.recordPlacement(actor.state, home.worktrees.common_dir, [
      { target: { pane: id }, path: "/tmp/linked", source: "write", stale: false },
    ]);
    await execute(r, ctx, { "pane.close": { target: id } });
    const reopened = await execute(r, ctx, {
      "agent.resume": {
        workspace: home.id,
        cwd: "/tmp",
        provider: "codex",
        session: "known",
        asleep: true,
        name: "",
        account: "",
      },
    });
    expect(reopened.pane).not.toBe(id);
    const associations = () => snapshot(r).workspaces[0].worktrees!.agents;
    expect(associations()).toEqual([
      { target: { pane: reopened.pane }, path: "/tmp/linked", source: "write", stale: false },
    ]);
    // The same binding path handles manually selected known and unseen sessions.
    const fresh = r.conversations.get("codex", "unseen");
    r.pane(reopened.pane!)!.attachment.select(fresh);
    expect(associations()).toEqual([]);
    r.pane(reopened.pane!)!.attachment.select(actor);
    expect(associations()[0].path).toBe("/tmp/linked");
    // Another provider with the same session text cannot inherit this placement.
    r.pane(reopened.pane!)!.attachment.select(r.conversations.get("claude", "known"));
    expect(associations()).toEqual([]);
    r.pane(reopened.pane!)!.attachment.select(actor);
    home.worktrees.entries = home.worktrees.entries.filter(e => e.primary);
    expect(associations()).toEqual([]);
  } finally {
    r.destroy();
  }
});
test("a workspace takes tabs past 24, from new tabs and moves alike", async () => {
  const { r, home, away } = setup();
  try {
    const one = pane(r, home),
      split = pane(r, home, one);
    for (let i = 1; i < 24; i++) pane(r, home);
    pane(r, away);
    const outside = location(r, pane(r, away)).tab;
    for (const cmd of [
      { "pane.move": { target: split, destination: { new_tab: "" } } },
      { "tab.move": { target: outside, destination: { workspace: home.id } } },
      { "tab.move": { target: outside, destination: { after: location(r, one).tab } } },
    ])
      await execute(r, ctx, cmd);
    expect(home.model.count).toBe(26);
    expect(home.model.tabs.findIndex(t => t.id === outside)).toBe(1);
    pane(r, home);
    expect(home.model.count).toBe(27);
  } finally {
    r.destroy();
  }
});
test("a tab cannot merge into itself, and missing destinations change nothing", async () => {
  const { r, home } = setup();
  try {
    const one = pane(r, home),
      split = pane(r, home, one),
      two = pane(r, home),
      tab = location(r, one).tab,
      before = topology(r);
    for (const [cmd, error] of [
      [{ "tab.merge": { target: tab, other: split, direction: "right" } }, "InvalidDestination"],
      [
        {
          "pane.move": {
            target: split,
            destination: { beside: { other: split, direction: "right" } },
          },
        },
        "InvalidDestination",
      ],
      [
        {
          "pane.move": {
            target: one,
            destination: { beside: { other: 99999 } },
          },
        },
        "NoPane",
      ],
      [{ "pane.move": { target: 99999, destination: { new_tab: "" } } }, "NoPane"],
      [{ "pane.swap": { target: one, other: 99999 } }, "NoPane"],
      [{ "tab.move": { target: tab, destination: { before: 99999 } } }, "NoTab"],
      [{ "tab.move": { target: tab, destination: { workspace: 99 } } }, "NoWorkspace"],
      [{ "pane.resize": { target: two, axis: "horizontal", ratio: 600 } }, "NoSplit"],
      [{ "pane.resize": { target: one, axis: "horizontal", ratio: 50 } }, "InvalidRatio"],
    ] as const)
      await expect(execute(r, ctx, protocol.decodeCommand(cmd))).rejects.toThrow(error);
    expect(topology(r)).toBe(before);
  } finally {
    r.destroy();
  }
});
test("merging a tab moves its whole tree beside a pane in any workspace", async () => {
  const { r, home, away } = setup();
  try {
    const left = pane(r, home),
      right = pane(r, home, left),
      target = pane(r, home),
      kept = location(r, target).tab;
    const merged = await execute(r, ctx, {
      "tab.merge": {
        target: location(r, left).tab,
        other: target,
        direction: "right",
      },
    });
    expect(merged).toMatchObject({ pane: left, tab: kept, workspace: home.id });
    expect(home.model.count).toBe(1);
    const root = home.model.nodes[home.model.tabs[0].root]!;
    expect("split" in root).toBe(true);
    if ("split" in root) expect(home.model.firstPane(root.split.first)).toBe(target);
    const lone = pane(r, away),
      rev = home.model.revision,
      otherRev = away.model.revision;
    const joined = await execute(r, ctx, {
      "tab.merge": {
        target: location(r, lone).tab,
        other: right,
        direction: "down",
      },
    });
    expect(joined).toMatchObject({ pane: lone, tab: kept, workspace: home.id });
    expect(away.model.count).toBe(0);
    expect(home.model.revision).toBe(rev + 1n);
    expect(away.model.revision).toBe(otherRev + 1n);
  } finally {
    r.destroy();
  }
});
test("swapping panes exchanges their places, across workspaces too", async () => {
  const { r, home, away } = setup();
  try {
    const left = pane(r, home),
      right = pane(r, home, left),
      other = pane(r, away),
      tab = location(r, left).tab;
    await execute(r, ctx, { "pane.swap": { target: left, other: right } });
    const root = home.model.nodes[home.model.tabs[0].root]!;
    if ("split" in root) expect(home.model.firstPane(root.split.first)).toBe(right);
    const rev = home.model.revision,
      otherRev = away.model.revision;
    const swapped = await execute(r, ctx, {
      "pane.swap": { target: left, other },
    });
    expect(swapped.workspace).toBe(away.id);
    expect(location(r, other)).toMatchObject({
      pane: other,
      tab,
      workspace: home.id,
    });
    expect(home.model.revision).toBe(rev + 1n);
    expect(away.model.revision).toBe(otherRev + 1n);
  } finally {
    r.destroy();
  }
});
test("an account's YOLO and Show are its own, apart from its provider's", async () => {
  const { r } = setup();
  try {
    const run = (cmd: protocol.CommandInput) => execute(r, ctx, protocol.decodeCommand(cmd));
    await run({ "agent.yolo": { provider: "claude", enabled: true, account: "/accounts/work" } });
    expect([r.yolo("claude", ""), r.yolo("claude", "/accounts/work"), r.yolo("codex", "")]).toEqual([
      false,
      true,
      false,
    ]);
    await run({ "agent.yolo": { provider: "claude", enabled: true } });
    await run({ "agent.yolo": { provider: "claude", enabled: false, account: "/accounts/work" } });
    expect([r.agent_yolo.claude, r.account_yolo]).toEqual([true, []]);
    await expect(run({ "agent.yolo": { provider: "claude", enabled: true, account: "work" } })).rejects.toThrow(
      "InvalidAccount",
    );
    await run({
      "agent.visibility": { hidden: { codex: true }, hidden_accounts: ["/accounts/work", "/accounts/work"] },
    });
    // A viewer that sends no accounts keeps the hidden ones.
    await run({ "agent.visibility": { hidden: { claude: true } } });
    expect([r.agent_hidden, r.account_hidden]).toEqual([
      { codex: false, claude: true, pi: false, opencode2: false, goose: false },
      ["/accounts/work"],
    ]);
    await expect(run({ "agent.visibility": { hidden: {}, hidden_accounts: ["work"] } })).rejects.toThrow(
      "InvalidAccount",
    );
    expect(snapshot(r)).toMatchObject({ account_yolo: [], account_hidden: ["/accounts/work"] });
    await run({ "agent.yolo": { provider: "pi", enabled: true } });
    await run({ "agent.yolo": { provider: "pi", enabled: true, account: "/accounts/pi" } });
    expect(r.yolo("pi", "")).toBe(false);
    expect(r.yolo("pi", "/accounts/pi")).toBe(false);
  } finally {
    r.destroy();
  }
});
test("a workspace hides launcher rows for itself, and a deleted command's slot comes back shown", async () => {
  const { r, home, away } = setup();
  try {
    const run = (cmd: protocol.CommandInput) => execute(r, ctx, protocol.decodeCommand(cmd));
    for (const row of ["claude", "claude:/accounts/work", "custom0", "custom0"])
      await run({ "agent.workspace_visibility": { workspace: home.id, row, shown: false } });
    await run({ "agent.workspace_visibility": { workspace: away.id, row: "custom0", shown: false } });
    await run({ "agent.workspace_visibility": { workspace: home.id, row: "claude", shown: true } });
    expect([home.launcher_hidden, away.launcher_hidden]).toEqual([["claude:/accounts/work", "custom0"], ["custom0"]]);
    for (const row of ["terminal", "claude:work", "custom9"])
      await expect(run({ "agent.workspace_visibility": { workspace: home.id, row, shown: false } })).rejects.toThrow(
        "InvalidRow",
      );
    expect(snapshot(r).workspaces[0].launcher_hidden).toEqual(["claude:/accounts/work", "custom0"]);
    await run({ "agent.command": { index: 0, command: "claude --model opus", resolve: false } });
    await run({ "agent.command": { index: 0, command: "", resolve: false } });
    expect([home.launcher_hidden, away.launcher_hidden]).toEqual([["claude:/accounts/work"], []]);
  } finally {
    r.destroy();
  }
});
test("a viewer's snapshot stays byte-stable while only output and stamps move", () => {
  const { r, home } = setup();
  try {
    const id = pane(r, home),
      actor = r.conversations.get("codex", "stable");
    r.pane(id)!.attachment.select(actor);
    actor.observed_at = 10000001;
    actor.children_observed_at = actor.observed_at;
    const before = stringify(viewerSnapshot(r));
    r.wrote();
    Object.assign(r.resources.current, { cores: 8 });
    actor.observed_at += 1000000;
    actor.children_observed_at = actor.observed_at;
    expect(stringify(viewerSnapshot(r))).toBe(before);
    expect(stringify(snapshot(r))).not.toBe(before);
    actor.observed_at += 5000000;
    expect(stringify(viewerSnapshot(r))).not.toBe(before);
  } finally {
    r.destroy();
  }
});
test("a viewer's snapshot leaves out conversations nothing is attached to", () => {
  const { r, home } = setup();
  try {
    const attached = r.conversations.get("claude", "attached"),
      child = r.conversations.get("claude", "child");
    child.parent = attached.id;
    r.conversations.get("claude", "detached");
    r.pane(pane(r, home))!.attachment.select(attached);
    const shown = viewerSnapshot(r).conversations;
    expect(shown.map(a => a.id)).toEqual([attached.id, child.id]);
    expect(shown[0].attachments).toBe(1);
    expect(snapshot(r).conversations.length).toBe(3);
  } finally {
    r.destroy();
  }
});
