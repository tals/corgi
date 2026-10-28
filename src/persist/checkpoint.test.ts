import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as cp from "./checkpoint";
import * as migrations from "./migrations";
import { checkpoint as schema, validateCheckpoint } from "./schema";
import * as json from "../json";
import { Runtime, Pane } from "../runtime";
import { Terminal } from "../pane/terminal";
import { claim } from "../detection";
import { adapter } from "../providers";
import { n, ptr, symbols, waitpid } from "../native_bridge";
import { Order } from "../agent_order";
import { Workspace } from "../workspace";
import { Text } from "../agents";
import { Attachment, type Actor } from "../conversations";
import { parseLabel } from "../activity/summary";
import * as links from "../trackers/link_labels";
import * as worktrees from "../worktrees";
import { parseInventory } from "../trackers/worktrees";
import { snapshot } from "../session";
import { Tokens } from "../usage/live";
const fixtures = resolve(import.meta.dir, "../fixtures");
const fresh = () => {
  const r = new Runtime(),
    ws = new Workspace(1, "/tmp");
  ws.rename("test");
  r.workspaces.items.push(ws);
  r.workspaces.next_id = 2;
  return r;
};
// A restore keeps only the conversations something refers to.
const show = (r: Runtime, actor: Actor) => {
  const ws = r.workspaces.items[0],
    pane = new Pane(ws.model.newTab(""), Terminal.create(20, 4), "/tmp");
  pane.terminal.exited = true;
  pane.attachment.select(actor);
  r.panes.push(pane);
  r.workspaces.next_pane_id = ws.model.next_id;
};
const roundtrip = (state: any) => json.parse(json.stringify(state));
const restore = (r: Runtime, state: any, live: boolean) =>
  cp.restore(r, roundtrip(state), live, "/tmp/unused-checkpoint.sock", "/tmp/corgi");
test("bridge claims survive live handoff but never become cold-recovered local agents", async () => {
  using original = fresh();
  const ws = original.workspaces.items[0];
  const pane = new Pane(ws.model.newTab(""), Terminal.create(20, 4), "/tmp");
  original.panes.push(pane);
  original.workspaces.next_pane_id = ws.model.next_id;
  pane.detection.claim = claim("claude", process.pid);
  pane.attachment.provisional.provider = "claude";
  pane.attachment.provisional.state = "working";
  pane.attachment.provisional.observation.finish("completed", "screen");
  pane.detection.screen_worked = true;
  for (const live of [true, false]) {
    using next = new Runtime();
    const saved = cp.capture(original, live);
    await restore(next, saved, live);
    const restored = next.panes[0];
    expect(restored.detection.claim).toEqual(live ? pane.detection.claim : null);
    expect(restored.agent().provider).toBe(live ? "claude" : null);
    expect(restored.detection.screen_worked).toBe(live);
    expect(restored.agent().observation.completed).toBe(1n);
    expect(restored.agent().observation.unread()).toBe(true);
    expect(restored.resumeLaunch()).toBeNull();
    expect(restored.resume_hint.provider).toBeNull();
    if (live) {
      const watcher = adapter("claude").watch("");
      for (let i = 0; i < 6; i++) {
        const seen = watcher.read({ id: pane.id, title: "✳ Ready", text: () => "" }, restored.detection, null, 0);
        if (seen.shown) restored.detection.show(restored.agent(), seen.shown, false);
      }
      expect(restored.agent().observation.completed).toBe(2n);
    }
  }
  const older = roundtrip(cp.capture(original, true));
  delete older.panes[0].detection.claim;
  delete older.panes[0].detection.screen_worked;
  delete older.panes[0].detection.structured;
  using compatible = new Runtime();
  await restore(compatible, older, true);
  expect(compatible.panes[0].detection.claim).toBeNull();
  expect(compatible.panes[0].detection.screen_worked).toBe(false);
  expect(compatible.panes[0].detection.structured).toBe(false);
  for (const invalid of [{ owner: 123 }, { provider: "bogus", owner: 123, parent: 1 }]) {
    const saved = roundtrip(cp.capture(original, true));
    saved.panes[0].detection.claim = invalid;
    using next = new Runtime();
    await expect(restore(next, saved, true)).rejects.toThrow();
  }
});

test("structured lifecycle ownership survives live reload, not a new cold process", async () => {
  using original = fresh();
  const actor = original.conversations.get("codex", "structured");
  show(original, actor);
  original.panes[0].detection.pid = 123;
  original.panes[0].detection.followStructured();
  actor.state.last_seq = 1n;
  actor.state.observation.source = "protocol";
  for (const live of [true, false]) {
    using next = new Runtime();
    await restore(next, cp.capture(original, live), live);
    expect(next.panes[0].detection.structured).toBe(live);
    expect(next.panes[0].detection.screen_worked).toBe(false);
  }
});

test("worktree evidence survives live and cold recovery independently of the launch directory", async () => {
  using original = fresh();
  const actor = original.conversations.get("codex", "worktree-session");
  actor.state.cwd = new Text("/tmp");
  show(original, actor);
  const location: worktrees.Location = {
    cwd: "/tmp/worktree",
    writes: ["/tmp/worktree/file"],
    ran: ["/tmp/worktree"],
    basis: "named",
  };
  worktrees.recordLocation(actor.state, location);
  const placement: { session: string; agents: worktrees.Association[] } = {
    session: actor.state.sessionId(),
    agents: [{ target: { pane: original.panes[0].id }, path: "/tmp/worktree", source: "write", stale: false }],
  };
  original.worktree_tracker.restore([placement]);
  worktrees.recordPlacement(actor.state, "/tmp/project/.git", placement.agents);
  for (const live of [true, false]) {
    using next = new Runtime();
    const state = cp.capture(original, live);
    worktrees.observed(actor.state)!.writes.push("/tmp/later");
    await restore(next, state, live);
    expect(worktrees.observed(next.conversations.byId(actor.id)!.state)).toEqual(location);
    expect(next.worktree_tracker.capture()).toEqual([placement]);
    expect(worktrees.placement(next.conversations.byId(actor.id)!.state)).toEqual(worktrees.placement(actor.state));
    worktrees.recordLocation(actor.state, location);
  }
  const old = cp.capture(original, true);
  Reflect.deleteProperty(old, "worktree_placements");
  Reflect.deleteProperty(old.conversations[0], "worktree_location");
  Reflect.deleteProperty(old.conversations[0], "worktree_placement");
  using next = new Runtime();
  await restore(next, old, true);
  expect(worktrees.observed(next.conversations.byId(actor.id)!.state)).toBeNull();
  expect(next.worktree_tracker.capture()).toEqual([]);
  expect(worktrees.placement(next.conversations.byId(actor.id)!.state)).toBeNull();
});
test("live handoff publishes worktree groups in its first snapshot before discovery", async () => {
  using original = fresh();
  const ws = original.workspaces.items[0],
    actor = original.conversations.get("codex", "worktree-session");
  show(original, actor);
  const entries = parseInventory(
    "worktree /tmp\0branch refs/heads/main\0\0worktree /tmp/linked\0branch refs/heads/feature\0\0",
  );
  for (const entry of entries) entry.available = true;
  entries[1].comparison = { ahead: 9007199254740993n, behind: 2n };
  ws.worktrees = { common_dir: "/tmp/.git", base: null, stale: false, entries, agents: [] };
  worktrees.recordPlacement(actor.state, ws.worktrees.common_dir, [
    { target: { pane: original.panes[0].id }, path: "/tmp/linked", source: "write", stale: false },
  ]);
  const expected = snapshot(original).workspaces[0].worktrees,
    saved = cp.capture(original, true);
  using next = new Runtime();
  await restore(next, saved, true);
  expect(next.worktree_tracker.busy()).toBe(false);
  expect(snapshot(next).workspaces[0].worktrees).toEqual(expected);
  expect(next.workspaces.items[0].worktrees).not.toBe(ws.worktrees);

  // Cold recovery and older senders still discover inventory in the background.
  using cold = new Runtime();
  await restore(cold, cp.capture(original, false), false);
  expect(snapshot(cold).workspaces[0].worktrees).toBeNull();
  Reflect.deleteProperty(saved.workspaces[0], "worktrees");
  using legacy = new Runtime();
  await restore(legacy, saved, true);
  expect(snapshot(legacy).workspaces[0].worktrees).toBeNull();
  expect(worktrees.placement(legacy.conversations.byId(actor.id)!.state)).not.toBeNull();
});
test("live terminal restoration keeps title ownership and cold restoration clears it", () => {
  const terminal = Terminal.create(20, 4);
  try {
    terminal.restore(Buffer.from("\x1b]2;codex | session\x07"), 42);
    const state = cp.Screen.capture(terminal, true);
    for (const live of [true, false]) {
      const next = cp.Screen.restore(state, live);
      try {
        expect(next.title).toBe(terminal.title);
        expect(next.title_pid).toBe(live ? 42 : 0);
      } finally {
        next.destroy();
      }
    }
    Reflect.deleteProperty(state, "title_pid");
    const old = cp.Screen.restore(state, true);
    try {
      expect(old.title_pid).toBe(0);
    } finally {
      old.destroy();
    }
  } finally {
    terminal.destroy();
  }
});
test("malformed saved worktree evidence is rejected", async () => {
  using original = fresh();
  const actor = original.conversations.get("codex", "bad-location");
  show(original, actor);
  const state = cp.capture(original, true);
  for (const value of [
    false,
    {},
    { cwd: "relative", writes: [], ran: [], basis: "named" },
    { cwd: "/tmp", writes: [], ran: [], basis: "other" },
  ]) {
    using next = new Runtime();
    state.conversations[0].worktree_location = value as any;
    await expect(restore(next, state, true)).rejects.toThrow();
  }
});
test("checkpoint integer fields restore as bigint for small and wide values", async () => {
  for (const sequence of [0n, 7n, 9007199254740993n]) {
    using original = fresh();
    using restored = new Runtime();
    const actor = original.conversations.get("codex", "integer-types"),
      binding = new Attachment();
    actor.state.last_seq = sequence;
    actor.state.observation.completed = sequence;
    binding.hook_seq = sequence;
    binding.provisional.last_seq = sequence;
    show(original, actor);
    await restore(restored, cp.capture(original, true), true);
    const next = restored.conversations.byId(actor.id)!;
    expect(next.state.last_seq).toBe(sequence);
    expect(next.state.observation.completed).toBe(sequence);
    expect(next.state.observation.read).toBe(0n);
    const bytes = json.stringify(cp.captureBinding(binding, true)),
      nextBinding = cp.restoreBinding(restored.conversations, json.parse(bytes), true);
    expect(nextBinding.hook_seq).toBe(sequence);
    expect(nextBinding.provisional.last_seq).toBe(sequence);
    expect(json.stringify(cp.captureBinding(nextBinding, true))).toBe(bytes);
  }
});
for (const version of [2, 3, 4, 5, 6])
  test(
    version === 6
      ? "V6 fixture is current and restores as saved"
      : `V${version} fixture migrates before typed decoding and restores unchanged terminal data`,
    async () => {
      const bytes = readFileSync(resolve(fixtures, `checkpoint-v${version}.json`), "utf8"),
        decoded = migrations.decode("checkpoint", bytes),
        r = new Runtime();
      try {
        expect(decoded.from).toBe(version);
        expect(decoded.migrated).toBe(version !== 6);
        expect(decoded.value.version).toBe(migrations.checkpoint_version);
        if (version === 2) {
          expect(decoded.value.panes[0].binding.provisional.provider).toBeNull();
          expect(decoded.value.panes[0].resume_hint.provider).toBeNull();
          await restore(r, decoded.value, true);
          expect(r.panes[0].terminal.text()).toContain("other");
          expect(r.workspaces.items[0].customName()).toBe("other");
          expect(migrations.decode("checkpoint", json.stringify(decoded.value)).migrated).toBe(false);
        } else {
          await restore(r, decoded.value, false);
          expect(r.conversations.items.length).toBe(1);
          expect(r.panes[0].agent().sessionId()).toBe("v3-shared");
          expect(r.panes[0].agent().observation.unread()).toBe(true);
          expect(r.panes[1].attachment.actor).toBeNull();
          expect(r.panes[0].terminal.text()).toContain("v3 history");
          if (version === 4) expect(r.panes[0].resume_hint.session.text()).toBe("v3-shared");
          if (version >= 5) expect(bytes).not.toContain("\\u0000");
        }
      } finally {
        r.destroy();
      }
    },
  );
test("saved checkpoint format matches its version", () => {
  expect(schema).toBe(readFileSync(resolve(fixtures, "checkpoint.schema"), "utf8"));
  using r = fresh();
  validateCheckpoint(roundtrip(cp.capture(r, true)));
  const value = roundtrip(cp.capture(r, false));
  expect(value.version).toBe(migrations.checkpoint_version);
  validateCheckpoint(value);
});
test("checkpoint validates goose provider values", () => {
  using r = fresh();
  r.last_agent = "goose";
  r.workspaces.items[0].last_agent = "goose";
  validateCheckpoint(roundtrip(cp.capture(r, true)));
});
test("an account's YOLO and Show survive checkpoints and default for old ones", async () => {
  for (const live of [true, false]) {
    using original = fresh();
    original.account_yolo = ["/accounts/work"];
    original.account_hidden = ["/accounts/side"];
    const state = roundtrip(cp.capture(original, live));
    validateCheckpoint(state);
    using restored = new Runtime();
    await restore(restored, state, live);
    expect([restored.account_yolo, restored.account_hidden]).toEqual([["/accounts/work"], ["/accounts/side"]]);
    delete state.account_yolo;
    delete state.account_hidden;
    using old = new Runtime();
    await restore(old, state, live);
    expect([old.account_yolo, old.account_hidden]).toEqual([[], []]);
    expect(() => validateCheckpoint({ ...state, account_yolo: [3] })).toThrow();
  }
});
test("a conversation's headless count and tracking start survive handoffs, not cold restores", async () => {
  for (const live of [true, false]) {
    using original = fresh();
    const actor = original.conversations.get("codex", "headless-usage");
    actor.tracked_since = 1234;
    show(original, actor);
    const first = new Tokens({ input: 100n, cached_input: 40n, output: 10n });
    actor.beginHeadlessUsage(false);
    actor.headless_meter.sample(first, first, true, 60_000);
    const state = roundtrip(cp.capture(original, live));
    validateCheckpoint(state);
    using next = new Runtime();
    await restore(next, state, live);
    const restored = next.conversations.byId(actor.id)!;
    expect(restored.headless_usage).toBe(live);
    expect(restored.tracked_since === 1234).toBe(live);
    if (!live) continue;
    restored.headless_meter.sample(new Tokens({ input: 150n, cached_input: 60n, output: 15n }), null, true, 60_000);
    const usage = restored.usageView(60_000);
    expect(usage.tokens).toEqual(new Tokens({ input: 150n, cached_input: 60n, output: 15n }));
    expect(usage.partial).toBe(false);
    expect(usage.recent_tokens).toBe(165n);
  }
});
test("a workspace's hidden launcher rows survive checkpoints and default for old ones", async () => {
  for (const live of [true, false]) {
    using original = fresh();
    original.workspaces.items[0].launcher_hidden = ["claude:/accounts/side", "custom2"];
    const state = roundtrip(cp.capture(original, live));
    validateCheckpoint(state);
    using restored = new Runtime();
    await restore(restored, state, live);
    expect(restored.workspaces.items[0].launcher_hidden).toEqual(["claude:/accounts/side", "custom2"]);
    expect(() =>
      validateCheckpoint({ ...state, workspaces: [{ ...state.workspaces[0], launcher_hidden: [3] }] }),
    ).toThrow();
    delete state.workspaces[0].launcher_hidden;
    using old = new Runtime();
    await restore(old, state, live);
    expect(old.workspaces.items[0].launcher_hidden).toEqual([]);
  }
});
test("sidebar order survives live and recovery checkpoints and defaults for old state", async () => {
  const r = fresh(),
    id = r.workspaces.items[0].id,
    order = [{ headless: 1 }, { pane: 2 }, { pane: 1 }];
  r.workspaces.items[0].agent_order = Order.restore(order);
  try {
    for (const live of [true, false]) {
      using next = new Runtime();
      await restore(next, cp.capture(r, live), live);
      expect(next.workspaces.get(id)!.agent_order.slice()).toEqual(order);
    }
    const state = cp.capture(r, true);
    Reflect.deleteProperty(state.workspaces[0], "agent_order");
    using next = new Runtime();
    await restore(next, state, true);
    expect(next.workspaces.get(id)!.agent_order.len).toBe(0);
  } finally {
    r.destroy();
  }
});
test("each workspace keeps its last agent, and one that has none follows the latest", async () => {
  const r = fresh(),
    used = r.workspaces.items[0].id,
    unused = await r.workspaces.add("unused", "/tmp");
  r.workspaces.get(used)!.last_agent = "claude";
  try {
    for (const live of [true, false]) {
      using next = new Runtime();
      await restore(next, cp.capture(r, live), live);
      expect(next.lastAgent(next.workspaces.get(used)!)).toBe("claude");
      expect(next.lastAgent(next.workspaces.get(unused)!)).toBe("codex");
      next.last_agent = "claude";
      expect(next.lastAgent(next.workspaces.get(unused)!)).toBe("claude");
    }
  } finally {
    r.destroy();
  }
});
test("each workspace keeps the pane a viewer last used in it", async () => {
  const r = fresh();
  r.workspaces.items[0].focus = 3;
  try {
    for (const live of [true, false]) {
      using next = new Runtime();
      await restore(next, cp.capture(r, live), live);
      expect(next.workspaces.items[0].focus).toBe(3);
    }
  } finally {
    r.destroy();
  }
});
test("conversation checkpoint restores shared bindings and detached unread state", async () => {
  const r = fresh(),
    ws = r.workspaces.items[0],
    shared = r.conversations.get("claude", "shared"),
    detached = r.conversations.get("codex", "detached");
  shared.workspace = ws.id;
  shared.state.state = "blocked";
  shared.status_inference.remember(
    "prior-turn",
    "Explaining cursor visibility",
    parseLabel("Explaining cursor visibility")!,
  );
  shared.state.observation.finish("completed", "hook");
  detached.parent = shared.id;
  detached.state.observation.finish("interrupted", "protocol");
  for (let n = 0; n < 2; n++) {
    const id = ws.model.newTab(""),
      t = Terminal.create(20, 4),
      pane = new Pane(id, t, "/tmp");
    t.exited = true;
    pane.attachment.select(detached);
    pane.attachment.select(shared);
    pane.attachment.hook_seq = 50n;
    r.panes.push(pane);
  }
  r.workspaces.next_pane_id = ws.model.next_id;
  const next = new Runtime(),
    cold = new Runtime();
  try {
    await restore(next, cp.capture(r, true), true);
    expect(next.conversations.items.length).toBe(2);
    const actor = next.conversations.byId(shared.id)!;
    expect(actor.status_inference.previous.text()).toBe("Explaining cursor visibility");
    expect(actor.status_inference.len).toBe(1);
    expect(next.panes[0].attachment.actor).toBe(actor);
    expect(next.panes[1].attachment.actor).toBe(actor);
    expect(next.panes[0].attachment.knows(detached.id)).toBe(true);
    expect(next.panes[0].attachment.hook_seq).toBe(50n);
    actor.acknowledge(1n, null);
    expect(next.panes[1].agent().observation.unread()).toBe(false);
    expect(next.conversations.byId(detached.id)!.state.observation.unread()).toBe(true);
    expect(next.conversations.byId(detached.id)!.parent).toBe(shared.id);
    expect(next.conversations.get("claude", "next").id).toBeGreaterThan(detached.id);
    await restore(cold, cp.capture(r, false), false);
    const historical = cold.conversations.byId(shared.id)!;
    expect(historical.state.state).toBe("unknown");
    expect(historical.observed_at).toBe(0);
    expect(historical.state.observation.unread()).toBe(true);
  } finally {
    next.destroy();
    cold.destroy();
    r.destroy();
  }
});
test("cold recovery keeps a pane's unselected completion until it forgets that conversation", async () => {
  using original = fresh();
  using restored = new Runtime();
  const earlier = original.conversations.get("codex", "earlier"),
    selected = original.conversations.get("codex", "selected");
  earlier.state.observation.finish("completed", "protocol");
  show(original, earlier);
  const binding = original.panes[0].attachment;
  binding.select(selected);
  binding.hook_seq = 50n;
  binding.selection_hash = 123n;
  await restore(restored, cp.capture(original, false), false);
  expect(restored.conversations.byId(earlier.id)?.state.observation.completed).toBe(1n);
  expect(restored.conversations.byId(earlier.id)?.state.observation.read).toBe(0n);
  expect(restored.conversations.byId(earlier.id)?.state.state).toBe("unknown");
  const recovered = restored.panes[0].attachment;
  expect(recovered.actor?.id).toBe(selected.id);
  expect(recovered.hook_seq).toBe(0n);
  expect(recovered.selection_hash).toBe(0n);
  expect(recovered.generation).toBe(binding.generation + 1n);
  expect(restored.pruneConversations()).toBe(false);
  recovered.detach();
  expect(restored.pruneConversations()).toBe(true);
  expect(restored.conversations.byId(earlier.id)).toBeNull();
});
test("a restore forgets the conversations nothing refers to, even a full registry's", async () => {
  const r = fresh(),
    shown = r.conversations.get("claude", "shown");
  while (r.conversations.items.length < 1024) r.conversations.get("codex", `closed-${r.conversations.items.length}`);
  show(r, shown);
  const next = new Runtime(),
    cold = new Runtime();
  try {
    await restore(next, cp.capture(r, true), true);
    expect(next.conversations.items.map(actor => actor.id)).toEqual([shown.id]);
    expect(Number(next.conversations.get("claude", "new").id)).toBe(1025);
    await restore(cold, cp.capture(r, false), false);
    expect(cold.conversations.items.map(actor => actor.id)).toEqual([shown.id]);
  } finally {
    next.destroy();
    cold.destroy();
    r.destroy();
  }
});
test("cold recovery leaves an agent's pane dormant over its old screen, and a live reload keeps it so", async () => {
  const r = fresh(),
    ws = r.workspaces.items[0],
    shell = new Pane(ws.model.newTab(""), Terminal.create(20, 4), "/tmp"),
    agent = new Pane(ws.model.newTab(""), Terminal.create(20, 4), "/tmp");
  r.panes.push(shell, agent);
  r.workspaces.next_pane_id = ws.model.next_id;
  agent.terminal.feed("OLD OUTPUT");
  agent.attachment.select(r.conversations.get("codex", "dormant-session"));
  const cold = new Runtime(),
    live = new Runtime();
  try {
    await restore(cold, cp.capture(r, false), false);
    const [recovered, sleeping] = cold.panes;
    expect([recovered.dormant, recovered.terminal.pid > 0]).toEqual([false, true]);
    expect([sleeping.dormant, sleeping.terminal.exited, sleeping.terminal.pid]).toEqual([true, true, -1]);
    expect(sleeping.terminal.text()).toContain("OLD OUTPUT");
    expect(sleeping.restoring()).toBe("codex resume dormant-session");
    await restore(live, cp.capture(cold, true), true);
    // The handoff gave `live` the panes' fds; the old daemon no longer owns them.
    for (const p of cold.panes) p.terminal.releaseFD();
    expect(live.panes.map(p => p.dormant)).toEqual([false, true]);
    expect(live.panes[1].terminal.exited).toBe(true);
  } finally {
    live.destroy();
    cold.destroy();
    r.destroy();
  }
});
test("cold recovery and a live reload keep every pane however many there are", async () => {
  const r = fresh(),
    ws = r.workspaces.items[0];
  for (let i = 0; i < 80; i++) {
    const p = new Pane(ws.model.newTab(""), Terminal.create(20, 4), "/tmp");
    p.attachment.select(r.conversations.get("codex", `session-${i}`));
    r.panes.push(p);
  }
  r.workspaces.next_pane_id = ws.model.next_id;
  const cold = new Runtime(),
    live = new Runtime();
  try {
    await restore(cold, cp.capture(r, false), false);
    expect(cold.panes.filter(p => p.dormant)).toHaveLength(80);
    await restore(live, cp.capture(cold, true), true);
    expect(live.panes).toHaveLength(80);
  } finally {
    live.destroy();
    cold.destroy();
    r.destroy();
  }
});
test("legacy pane checkpoint migrates identity into an actor", async () => {
  const tree = json.parse(readFileSync(resolve(fixtures, "checkpoint-v4.json"), "utf8"));
  tree.version = 1;
  delete tree.conversations;
  delete tree.next_conversation;
  for (const pane of tree.panes) pane.binding = null;
  const decoded = migrations.decode("checkpoint", json.stringify(tree)),
    r = new Runtime();
  try {
    await restore(r, decoded.value, false);
    expect(r.conversations.items.length).toBe(1);
    expect(r.panes[0].agent().sessionId()).toBe("v3-shared");
    expect(r.panes[0].agent().observation.unread()).toBe(true);
    expect(r.panes[1].attachment.actor).toBeNull();
  } finally {
    r.destroy();
  }
});
test("live compaction restores its clearing source including older checkpoints", async () => {
  for (const item of [
    { saved: true, source: "protocol", owned: true, changed: 0 },
    { saved: false, source: "protocol", owned: false, changed: 0 },
    { saved: null, source: "protocol", owned: true, changed: 0 },
    { saved: null, source: "hook", owned: false, changed: 0 },
    { saved: null, source: "protocol", owned: false, changed: 100 },
  ]) {
    const r = fresh(),
      actor = r.conversations.get("codex", "compacting"),
      next = new Runtime();
    actor.state.state = "working";
    actor.state.compacting = true;
    actor.state.observation.source = item.source as any;
    actor.state.changed_at = item.changed;
    actor.state.setActivity("Reading source");
    actor.screen_compacting = item.owned;
    show(r, actor);
    try {
      const saved = cp.capture(r, true);
      expect(saved.conversations[0].screen_compacting).toBe(item.owned);
      if (item.saved === null) Reflect.deleteProperty(saved.conversations[0], "screen_compacting");
      else saved.conversations[0].screen_compacting = item.saved;
      await restore(next, saved, true);
      const restored = next.conversations.byId(actor.id)!;
      expect(restored.screen_compacting).toBe(item.owned);
      expect(restored.activity_timeline.points[0].label.text()).toBe("Compacting context");
      restored.observeCompactionScreen(false, Date.now() * 1000);
      expect(restored.state.compacting).toBe(!item.owned);
      expect(cp.capture(r, false).conversations[0].agent.compacting).toBe(false);
    } finally {
      next.destroy();
      r.destroy();
    }
  }
});
test("compact checkpoint preserves screens input modes cursor and title without replaying replies", () => {
  const old = Terminal.create(40, 6);
  let next: Terminal | undefined;
  try {
    old.feed(
      "primary history\x1b[?1049h\x1b[2Jalternate\x1b[?2004h\x1b[?1003h\x1b[?1006h\x1b[>3u\x1b]2;agent title\x1b\\\x1b[3;5H",
    );
    next = cp.Screen.restore(cp.Screen.capture(old, true), true);
    const before = old.surface(0),
      after = next.surface(0);
    expect(after.modes).toEqual(before.modes);
    expect(next.bracketed_paste).toBe(true);
    expect(after.surface.cursor).toEqual(before.surface.cursor);
    expect(next.title).toBe("agent title");
    expect(next.pendingBytes).toBe(0);
    expect(next.text()).toContain("alternate");
    next.feed("\x1b[?1049l");
    expect(next.text()).toContain("primary history");
  } finally {
    next?.destroy();
    old.destroy();
  }
});
test("live checkpoint size depends on retained state not output volume", () => {
  const old = Terminal.create(40, 6);
  let next: Terminal | undefined;
  try {
    old.feed("retained content");
    const first = cp.Screen.capture(old, true);
    for (let n = 0; n < 256; n++) old.feed("\r".repeat(4096));
    const compact = cp.Screen.capture(old, true);
    expect(compact.data.length).toBeLessThan(first.data.length + 128);
    next = cp.Screen.restore(compact, true);
    expect(next.text()).toContain("retained content");
  } finally {
    next?.destroy();
    old.destroy();
  }
});
test("link cache and spent inference attempts survive live checkpoints only", async () => {
  const r = fresh();
  r.link_labels.generation = 3n;
  for (let i = 0; i < 3; i++)
    r.link_labels.entries[i] = {
      key: {
        workspace: 1,
        pane: 1,
        pid: 7,
        port: 3000 + i,
        scheme: "http",
        address: 9n,
      },
      generation: BigInt(i + 1),
      attempted: true,
      pending: i === 1,
      name: i === 0 ? links.parseName("Finance")! : new Text(),
    };
  try {
    for (const live of [true, false]) {
      using next = new Runtime();
      await restore(next, cp.capture(r, live), live);
      if (live) {
        expect(next.link_labels.entries[0]!.name.text()).toBe("Finance");
        expect(next.link_labels.entries[1]!.pending).toBe(true);
        expect(next.link_labels.entries[2]!.attempted).toBe(true);
        expect(next.link_labels.generation).toBe(3n);
      } else {
        expect(next.link_labels.entries[0]).toBeNull();
        expect(next.link_labels.generation).toBe(0n);
      }
    }
    const invalid = new links.Cache();
    Object.assign(invalid, r.link_labels);
    invalid.entries = r.link_labels.entries.map(e => (e ? { ...e } : null));
    invalid.entries[0]!.name = new Text("Too many words here");
    expect(() => links.Cache.restore(invalid)).toThrow("InvalidCheckpoint");
    invalid.entries[0]!.name = new Text("Finance");
    invalid.entries[0]!.generation = 4n;
    expect(() => links.Cache.restore(invalid)).toThrow("InvalidCheckpoint");
  } finally {
    r.destroy();
  }
});
test("checkpoint capture copies durable values and rejects invalid saved primitive types", async () => {
  using r = fresh();
  const state = cp.capture(r, true);
  r.last_agent = "claude";
  r.workspaces.items[0].rename("changed");
  expect(state.last_agent).toBe("codex");
  expect(state.workspaces[0].name).toBe("test");
  const invalid = roundtrip(state);
  invalid.revision = -1;
  await expect(restore(new Runtime(), invalid, true)).rejects.toThrow("Overflow");
  invalid.revision = 0;
  invalid.agent_commands[0].command = "x".repeat(2049);
  await expect(restore(new Runtime(), invalid, true)).rejects.toThrow("LengthMismatch");
});

test("redraw cycle changes PTY dimensions only after activation and restores them", () => {
  const fds = new Int32Array(2),
    size = new Uint16Array(2);
  expect(n.probe_pty(ptr(fds))).toBe(0);
  const [master, slave] = fds,
    t = Terminal.create(40, 6);
  try {
    expect(n.probe_resize(master, 40, 6)).toBe(0);
    t.fd = master;
    symbols.app_terminal_fd(t.handle, master, -1);
    t.native({ op: "adopt" });
    expect(n.probe_winsize(slave, ptr(size))).toBe(0);
    expect(size[0]).toBe(40);
    t.refreshRedraw(1000);
    n.probe_winsize(slave, ptr(size));
    expect(size[0]).toBe(39);
    t.refreshRedraw(1100);
    n.probe_winsize(slave, ptr(size));
    expect(size[0]).toBe(39);
    expect(t.redrawing).toBe(true);
    t.refreshRedraw(1250);
    expect(t.redrawing).toBe(false);
    n.probe_winsize(slave, ptr(size));
    expect(size[0]).toBe(40);
  } finally {
    t.destroy();
    n.probe_close(slave);
  }
});
test("a restored candidate terminal does not signal its process until adopted", () => {
  const pids = new Int32Array(2);
  expect(n.probe_fixture_children(ptr(pids))).toBe(0);
  const [exited, pid] = pids;
  n.probe_wait_child(exited);
  try {
    const screen = { cols: 10, rows: 2, data: "", pid, fd: -1, exited: false };
    const candidate = cp.Screen.restore(screen, true);
    expect(candidate.owner).toBe("candidate");
    candidate.destroy();
    expect(waitpid(pid)).toBe(0);
    const adopted = cp.Screen.restore(screen, true);
    adopted.owner = "runtime";
    adopted.destroy();
    expect(n.probe_wait_child(pid)).toBe(pid);
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
    n.probe_wait_child(pid);
  }
});
