import { expect, test, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime, Pane, Launch } from "../runtime";
import { Text } from "../agents";
import { Workspace } from "../workspace";
import { Terminal } from "../pane/terminal";
import * as json from "../json";
import * as checkpoint from "./checkpoint";
import * as transfer from "./transfer";
import * as recovery from "./recovery";
import * as check from "./check";
import * as cold from "./cold";
import * as formats from "./formats";
import * as breadcrumbs from "../breadcrumbs";

function saved() {
  using runtime = new Runtime();
  const workspace = new Workspace(1, "/tmp", "retained workspace");
  runtime.workspaces.items.push(workspace);
  runtime.workspaces.next_id = 2;
  for (let i = 0; i < 2; i++) {
    const pane = new Pane(workspace.model.newTab("saved pane"), Terminal.create(20, 4), "/tmp");
    pane.terminal.exited = true;
    pane.dormant = true;
    pane.manual_resume = true;
    pane.manual_command = "echo retained";
    runtime.panes.push(pane);
  }
  runtime.workspaces.next_pane_id = workspace.model.next_id;
  const saved = json.clone(transfer.recovery(runtime, checkpoint.capture(runtime, false)));
  // Earlier envelopes kept metadata as an object.
  return { ...saved, transfer: { ...saved.transfer, payload: json.parse(saved.transfer.payload) } };
}

test("preflight and cold recovery discard invalid auxiliary data under a recognized revision", async () => {
  const directory = mkdtempSync(join(tmpdir(), "corgi-cold-core-")),
    socket = join(directory, "control.sock"),
    previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = directory;
  try {
    const state = saved();
    json.object(state.transfer.payload.runtime).closed = [{}];
    const bytes = json.stringify(state),
      path = recovery.path(socket);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    await Bun.write(path, bytes);
    const decoded = await cold.read(bytes, socket, process.execPath);
    expect(decoded.discarded).toBe(true);
    expect(decoded.value.closed).toEqual([]);
    expect(await check.run(path, socket, process.execPath)).toEqual({ ok: true });
    using restored = new Runtime();
    expect(await recovery.load(restored, socket, process.execPath)).toBe(true);
    expect(restored.panes.map(pane => pane.id)).toEqual(state.transfer.core.panes.map(pane => pane.id));
    expect(restored.panes.every(pane => pane.dormant && pane.terminal.fd === -1)).toBe(true);
    expect(restored.panes[0].manual_command).toBe("echo retained");
    // Named for its format, so a later migration cannot overwrite it.
    expect(readFileSync(`${path}.${state.transfer.format}`, "utf8")).toBe(bytes);
    expect(existsSync(path + ".v6")).toBe(false);
    expect(json.parse(readFileSync(path, "utf8")).closed).toEqual([]);
    expect(recovery.takeRepairs(socket)).not.toBeNull();
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fallback starts with a fresh runtime after a partial metadata restore", async () => {
  const state = saved();
  state.transfer.payload.runtime.panes[1].binding.provisional.observation.read = 2n;
  state.transfer.payload.runtime.panes[1].binding.provisional.observation.completed = 1n;
  const decoded = await cold.read(json.stringify(state), "/tmp/unused", process.execPath);
  expect(decoded.discarded).toBe(true);
  using restored = new Runtime();
  await checkpoint.restore(restored, decoded.value, false, "/tmp/unused", process.execPath, false);
  expect(restored.panes).toHaveLength(2);
  expect(new Set(restored.panes.map(pane => pane.id)).size).toBe(2);
});

test("invalid core is rejected even when its auxiliary metadata can be discarded", async () => {
  const state = { ...saved(), closed: [{}] };
  state.transfer.core.panes[0].workspace = 999;
  await expect(cold.read(json.stringify(state), "/tmp/unused", process.execPath)).rejects.toThrow("InvalidHandoffCore");
});

test("matching valid metadata is retained without a recovery rewrite", async () => {
  const state = saved(),
    decoded = await cold.read(json.stringify(state), "/tmp/unused", process.execPath);
  expect(decoded.discarded).toBe(false);
  expect(decoded.migrated).toBe(false);
  expect(decoded.value.panes[0].binding).toEqual(state.panes[0].binding);
});

test("preflight does not append saved breadcrumbs before the real restore", async () => {
  const before = breadcrumbs.capture();
  try {
    breadcrumbs.clear();
    const state = saved();
    state.transfer.payload.runtime.breadcrumbs = [{ at: 1, kind: "opened", pane: 1, session: 0, actors: [] }];
    const decoded = await cold.read(json.stringify(state), "/tmp/unused", process.execPath);
    expect(breadcrumbs.capture()).toEqual([]);
    using restored = new Runtime();
    await checkpoint.restore(restored, decoded.value, false, "/tmp/unused", process.execPath, false);
    expect(breadcrumbs.capture().map(entry => entry.kind)).toEqual(["opened", "restored_cold"]);
  } finally {
    breadcrumbs.clear();
    breadcrumbs.restore(before);
  }
});

test("cold recovery resumes agents without replaying ordinary commands, even after metadata loss", async () => {
  using original = new Runtime();
  const workspace = new Workspace(1, "/tmp", "workspace");
  original.workspaces.items.push(workspace);
  original.workspaces.next_id = 2;
  for (let i = 0; i < 3; i++) {
    const pane = new Pane(workspace.model.newTab("pane"), Terminal.create(20, 4), "/tmp");
    pane.terminal.exited = true;
    original.panes.push(pane);
  }
  original.workspaces.next_pane_id = workspace.model.next_id;
  const agent = original.panes[0];
  agent.launch = new Launch({ provider: "codex" });
  agent.resume_hint.provider = "codex";
  agent.resume_hint.session = new Text("retained-session");
  original.panes[2].launch = new Launch(undefined, "codex 'initial prompt'");
  const starts: unknown[][] = [],
    spawn = spyOn(Terminal.prototype, "spawn").mockImplementation(async (...args) => {
      starts.push(args);
    });
  try {
    using handed = new Runtime();
    const wire = transfer.encode(
      original,
      {
        runtime: checkpoint.capture(original, true),
        requester: -1,
        request_id: null,
        start_lock: -1,
        older_updater: false,
        links: [],
        theme: {},
      },
      [formats.baseline],
      [],
    );
    await checkpoint.restore(
      handed,
      transfer.decode(json.clone(wire)).runtime,
      true,
      "/tmp/unused",
      process.execPath,
      false,
    );
    for (const source of [original, handed]) {
      const saved = transfer.recovery(source, checkpoint.capture(source, false));
      for (const metadata of ["valid", "unknown", "invalid", "legacy"]) {
        const state = json.clone(saved);
        if (metadata === "unknown") state.transfer.format = "f".repeat(12);
        else if (metadata === "invalid") {
          const payload = json.parse(state.transfer.payload);
          json.object(payload.runtime).closed = [{}];
          state.transfer.payload = json.stringify(payload);
        } else if (metadata === "legacy") delete json.object(state).transfer;
        starts.length = 0;
        using restored = new Runtime();
        const decoded = await cold.read(json.stringify(state), "/tmp/unused", process.execPath);
        await checkpoint.restore(restored, decoded.value, false, "/tmp/unused", process.execPath);
        expect(restored.panes[0].dormant).toBe(true);
        expect(restored.panes[0].restoring()).toBe("codex resume retained-session");
        expect(restored.panes.slice(1).map(pane => pane.dormant)).toEqual([false, false]);
        expect(starts.map(args => [args[2], args[4]])).toEqual(original.panes.slice(1).map(pane => [pane.id, null]));
      }
    }
  } finally {
    spawn.mockRestore();
  }
});
