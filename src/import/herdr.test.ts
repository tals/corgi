import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import * as herdr from "./herdr";
import * as runtime from "../runtime";
import * as checkpoint from "../persist/checkpoint";

function staged(sessions = ["imported-session"], name = "Imported") {
  const job = new herdr.Job("/tmp/unused-herdr.sock", "/tmp/unused-corgi", {}, null);
  job.restoreManifest({
    panes: sessions.map((_, i) => ({
      pane_id: i + 1,
      child_pid: 123,
      cols: 80,
      rows: 24,
      agent_state: { authority: { state: "Idle" } },
    })),
    snapshot: {
      workspaces: [
        {
          identity_cwd: "/tmp",
          custom_name: name,
          tabs: sessions.map((session, i) => ({
            custom_name: "Codex",
            layout: { Pane: i + 1 },
            panes: {
              [i + 1]: {
                cwd: "/tmp",
                agent_session: { kind: "id", agent: "codex", value: session },
              },
            },
          })),
        },
      ],
    },
  });
  // Exercise ownership transitions without live processes or PTYs.
  job.fds = sessions.map(() => -1);
  job.pids = sessions.map(() => -1);
  job.phase = "preparing";
  const manager = new herdr.Manager();
  manager.job = job;
  return { job, manager };
}

test("live Herdr import roots a workspace at the folder its panes report", () => {
  const { job, manager } = staged();
  try {
    // /tmp is a link to /private/tmp on macOS, which is what panes report there.
    expect(job.staged.workspaces.items[0].cwd).toBe(realpathSync("/tmp"));
  } finally {
    manager.cancel();
  }
});

test("a blank Herdr workspace name takes the folder's", () => {
  const { job, manager } = staged(undefined, "  ");
  try {
    expect(job.staged.workspaces.items[0].name()).toBe("tmp");
  } finally {
    manager.cancel();
  }
});
test("live Herdr import survives pruning between preparation and adoption", async () => {
  using r = new runtime.Runtime();
  const { job, manager } = staged();
  try {
    manager.tick(r);
    const pane = job.staged.panes[0],
      actor = pane.attachment.actor!;
    expect(r.panes).toHaveLength(0);
    r.conversations.get("codex", "unreferenced");
    expect(r.pruneConversations()).toBe(true);
    expect(r.conversations.byId(actor.id)).toBe(actor);

    job.phase = "complete";
    expect(manager.tick(r)).toBe(true);
    expect(r.pruneConversations()).toBe(false);
    for (const live of [true, false]) {
      using restored = new runtime.Runtime();
      await checkpoint.restore(restored, checkpoint.capture(r, live), live, "/tmp/unused-corgi.sock", "/tmp/corgi");
      expect(restored.panes[0].attachment.actor?.id).toBe(actor.id);
      expect(restored.panes[0].attachment.known).toEqual([actor.id]);
    }

    pane.terminal.exited = true;
    r.close(pane.id);
    expect(r.pruneConversations()).toBe(true);
    expect(r.conversations.items).toHaveLength(0);
  } finally {
    manager.cancel();
  }
});

test.each(["cancelled", "failed"])("a %s Herdr import releases its staged conversations", async outcome => {
  using r = new runtime.Runtime();
  const { job, manager } = staged();
  try {
    manager.tick(r);
    if (outcome === "cancelled") manager.cancel();
    else {
      job.transfer = async () => {
        throw Error("HerdrHandoffRolledBack");
      };
      await job.run();
      expect(job.phase).toBe("failed");
    }
    expect(r.pruneConversations()).toBe(true);
    expect(r.conversations.items).toHaveLength(0);
  } finally {
    manager.cancel();
  }
});

test("failed Herdr preparation releases conversations already bound to staged panes", () => {
  using r = new runtime.Runtime();
  const { job, manager } = staged(["valid-session", "invalid-\ufffd-session"]);
  try {
    expect(manager.tick(r)).toBe(false);
    expect(job.preparation_failure).toBe("InvalidSession");
    expect(r.pruneConversations()).toBe(true);
    expect(r.conversations.items).toHaveLength(0);
  } finally {
    manager.cancel();
  }
});
