import { test, expect, beforeEach } from "bun:test";
import * as breadcrumbs from "./breadcrumbs";
import * as cp from "./persist/checkpoint";
import * as json from "./json";
import { Runtime, Pane } from "./runtime";
import { Terminal } from "./pane/terminal";
import { Workspace } from "./workspace";

beforeEach(() => breadcrumbs.clear());
const said = () => breadcrumbs.capture().map(breadcrumbs.describe);

test("a pane's agent coming and going, and the daemon forgetting it, leave breadcrumbs", () => {
  using r = new Runtime();
  const ws = new Workspace(1, "/tmp");
  r.workspaces.items.push(ws);
  const pane = new Pane(ws.model.newTab(""), Terminal.create(20, 4), "/tmp");
  r.panes.push(pane);
  const actor = r.conversations.get("codex", "one");
  pane.attachment.select(actor);
  pane.attachment.select(actor);
  pane.releaseDetection();
  r.pruneConversations();
  expect(said()).toEqual([
    `pane ${pane.id} showed conversation ${actor.id}`,
    `pane ${pane.id}'s agent went away; it forgot conversation ${actor.id}`,
    `the daemon forgot conversation ${actor.id}, which nothing referred to`,
  ]);
});
test("a pane's attachment, replaced on restore, still names the pane", () => {
  using r = new Runtime();
  const pane = new Pane(7, Terminal.create(20, 4), "/tmp");
  pane.attachment = cp.restoreBinding(r.conversations, {}, false);
  pane.attachment.select(r.conversations.get("claude", "two"));
  pane.id = 9;
  pane.attachment.deselect();
  expect(said()).toEqual(["pane 7 showed conversation 1", "pane 9 stopped showing conversation 1"]);
});
test("breadcrumbs ride the checkpoint and continue after a restore", async () => {
  using r = new Runtime();
  r.workspaces.items.push(new Workspace(1, "/tmp"));
  r.workspaces.next_id = 2;
  breadcrumbs.record("forgot", { actors: [3] });
  const saved = json.parse(json.stringify(cp.capture(r, false)));
  breadcrumbs.clear();
  using next = new Runtime();
  await cp.restore(next, saved, false, "/tmp/unused-breadcrumbs.sock", "/tmp/corgi", false);
  expect(said()).toEqual([
    "the daemon forgot conversation 3, which nothing referred to",
    "the daemon started from a saved checkpoint",
  ]);
});
test("entries a build can't read are left out, and the log keeps the newest", () => {
  expect(
    breadcrumbs.parse([
      { at: 1, kind: "bound", pane: 2, session: 0, actors: [4] },
      { at: 2, kind: "from_the_future", pane: 2, session: 0, actors: [] },
      { at: 3, kind: "bound", pane: -1, session: 0, actors: [] },
      "nonsense",
    ]),
  ).toEqual([{ at: 1, kind: "bound", pane: 2, session: 0, actors: [4] }]);
  for (let i = 0; i < breadcrumbs.capacity + 5; i++) breadcrumbs.record("forgot", { actors: [i] });
  const kept = breadcrumbs.capture();
  expect(kept).toHaveLength(breadcrumbs.capacity);
  expect(kept[0].actors).toEqual([5]);
});
test("a report line says how long before the save it happened", () => {
  const e = { at: 1_000_000, kind: "bound" as const, pane: 16, session: 0, actors: [1] };
  expect(breadcrumbs.line(e, 1_000_000 + 125_000)).toBe("−2m 05s  pane 16 showed conversation 1");
  expect(breadcrumbs.line(e, 1_000_000 + 4_000)).toBe("−4s  pane 16 showed conversation 1");
});
