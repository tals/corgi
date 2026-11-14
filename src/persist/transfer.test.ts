import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Runtime, Pane, Launch } from "../runtime";
import { Workspace } from "../workspace";
import { Terminal } from "../pane/terminal";
import { Text } from "../agents";
import * as json from "../json";
import * as checkpoint from "./checkpoint";
import * as core from "./core";
import * as formats from "./formats";
import * as transfer from "./transfer";
import * as state_formats from "./state_formats";
import * as handoff_rollback from "./handoff_rollback";
import * as migrations from "./migrations";
import * as root from "./revisions/r_68139a93dee0_terminal_core_handoff_baseline";
import baselineFixture from "../fixtures/transfer-v1.json";

function createHistory(current: string, revisions: formats.Revision[]) {
  return new formats.History(current, [root.revision, ...revisions]);
}

function fixture(count = 2) {
  const runtime = new Runtime(),
    workspace = new Workspace(1, "/tmp", "workspace");
  runtime.workspaces.items.push(workspace);
  runtime.workspaces.next_id = 2;
  for (let i = 0; i < count; i++) {
    const pane = new Pane(workspace.model.newTab(`pane ${i}`), Terminal.create(20, 4), "/tmp");
    pane.terminal.exited = true;
    pane.terminal.feed(`screen ${i}`);
    runtime.panes.push(pane);
  }
  runtime.workspaces.next_pane_id = workspace.model.next_id;
  return runtime;
}
function manifest(runtime: Runtime) {
  return {
    runtime: checkpoint.capture(runtime, true),
    requester: -1,
    request_id: null,
    start_lock: -1,
    older_updater: false,
    links: [],
    theme: {},
  };
}
test("the baseline envelope and core retain their frozen version-one shape", () => {
  using runtime = fixture(1);
  const saved = manifest(runtime);
  saved.runtime.saved_at = 1700000000;
  saved.runtime.panes[0].screen.data = "";
  expect(json.clone(transfer.encode(runtime, saved, [formats.baseline], []))).toEqual(baselineFixture);
  expect(transfer.decode(baselineFixture).runtime.panes).toHaveLength(1);
});
test("core-only transfer retains every pane and pending bytes through a downgrade and upgrade", async () => {
  using original = fixture(70);
  original.panes[0].terminal.send(Buffer.from([0, 128, 255, 27, 10]));
  original.panes[1].dormant = true;
  original.panes[1].manual_resume = true;
  original.panes[1].manual_command = "echo manual";
  const wire = json.clone(transfer.encode(original, manifest(original), [formats.baseline], [])),
    decoded = transfer.decode(wire);
  expect(wire.payload).toBeNull();
  using downgraded = new Runtime();
  await checkpoint.restore(downgraded, decoded.runtime, true, "/tmp/unused", "/tmp/corgi");
  expect(downgraded.panes.map(p => p.id)).toEqual(original.panes.map(p => p.id));
  expect(downgraded.panes[0].terminal.pendingInput()).toBe("AID/Gwo=");
  expect(downgraded.panes[1].manual_command).toBe("echo manual");
  expect(downgraded.panes[1].dormant).toBe(true);
  using upgraded = new Runtime();
  const next = transfer.decode(
    json.clone(transfer.encode(downgraded, manifest(downgraded), transfer.info().formats, [])),
  );
  await checkpoint.restore(upgraded, next.runtime, true, "/tmp/unused", "/tmp/corgi");
  expect(upgraded.panes[0].terminal.pendingInput()).toBe(original.panes[0].terminal.pendingInput());
  expect(upgraded.panes[69].terminal.text()).toContain("screen 69");
});
test("metadata migrations cannot replace handles or remove core panes", () => {
  using original = fixture();
  const id = "a".repeat(12),
    parent = "b".repeat(12),
    history = createHistory(id, [
      {
        id,
        parent,
        description: "Discard pane metadata while retaining the terminal core",
        down: value => value,
        up: () => ({ runtime: { panes: [], workspaces: [], next_pane: 1 } }),
      },
      { id: parent, parent: formats.baseline, description: "Initial metadata", up: () => null, down: () => null },
    ]),
    sent = transfer.encode(original, manifest(original), [parent, formats.baseline], [], history),
    restored = transfer.decode(sent, history);
  expect(restored.runtime.panes.map(p => p.id)).toEqual(original.panes.map(p => p.id));
  expect(restored.runtime.next_pane).toBe(original.workspaces.next_pane_id);
  expect(restored.runtime.workspaces[0].model.tabs).toHaveLength(2);
});

test("lossy migrations retain dormant commands through downgrade, upgrade and cold recovery", async () => {
  using original = fixture(1);
  const pane = original.panes[0],
    command = "printf 'retained command\\n'";
  pane.dormant = true;
  pane.manual_resume = true;
  pane.manual_command = command;
  let up = 0,
    down = 0;
  const discard = (value: unknown) => {
      const saved = json.object(value);
      for (const pane of saved.runtime.panes) {
        pane.launch = null;
        pane.manual_command = null;
        pane.resume_hint = {};
      }
      return saved;
    },
    newer = new formats.History("a".repeat(12), [
      ...state_formats.revisions,
      {
        id: "a".repeat(12),
        parent: state_formats.current,
        description: "Discard launcher metadata",
        up: value => {
          up++;
          return discard(value);
        },
        down: value => {
          down++;
          return discard(value);
        },
      },
    ]),
    sent = transfer.encode(original, manifest(original), transfer.info().formats, [], newer);
  using downgraded = new Runtime();
  await checkpoint.restore(
    downgraded,
    transfer.decode(json.clone(sent)).runtime,
    true,
    "/tmp/unused",
    "/tmp/corgi",
    false,
  );
  expect(downgraded.panes[0].manual_command).toBe(command);
  expect(downgraded.panes[0].restoring()).toBe(command);
  expect(core.capture(downgraded, checkpoint.capture(downgraded, true)).panes[0].command).toBe(command);
  using upgraded = new Runtime();
  const back = transfer.encode(downgraded, manifest(downgraded), formats.supported(newer), []);
  await checkpoint.restore(
    upgraded,
    transfer.decode(json.clone(back), newer).runtime,
    true,
    "/tmp/unused",
    "/tmp/corgi",
    false,
  );
  expect(upgraded.panes[0].manual_resume).toBe(true);
  expect(upgraded.panes[0].restoring()).toBe(command);
  const saved = transfer.recovery(upgraded, checkpoint.capture(upgraded, false));
  expect(saved.transfer.core.panes[0].command).toBe(command);
  using recovered = new Runtime();
  await checkpoint.restore(
    recovered,
    transfer.recover(json.stringify(saved)).value,
    false,
    "/tmp/unused",
    "/tmp/corgi",
    false,
  );
  expect(recovered.panes[0].dormant).toBe(true);
  expect(recovered.panes[0].manual_resume).toBe(true);
  expect(recovered.panes[0].restoring()).toBe(command);
  expect([down, up]).toEqual([1, 1]);
});

test("discarding resume hints while retaining a launcher preserves the core resume command", async () => {
  using original = fixture(1);
  const pane = original.panes[0];
  pane.dormant = true;
  pane.launch = new Launch({ provider: "codex" });
  pane.resume_hint.provider = "codex";
  pane.resume_hint.session = new Text("saved-session");
  const command = pane.restoring(),
    discard = (value: unknown) => {
      for (const pane of json.object(value).runtime.panes) pane.resume_hint = {};
      return value;
    },
    newer = new formats.History("a".repeat(12), [
      ...state_formats.revisions,
      {
        id: "a".repeat(12),
        parent: state_formats.current,
        description: "Discard resume hints",
        up: discard,
        down: discard,
      },
    ]),
    wire = transfer.encode(original, manifest(original), transfer.info().formats, [], newer);
  using downgraded = new Runtime();
  await checkpoint.restore(
    downgraded,
    transfer.decode(json.clone(wire)).runtime,
    true,
    "/tmp/unused",
    "/tmp/corgi",
    false,
  );
  expect(downgraded.panes[0].restoring()).toBe(command);
  expect(core.capture(downgraded, checkpoint.capture(downgraded, true)).panes[0].command).toBe(command);
  using upgraded = new Runtime();
  const back = transfer.encode(downgraded, manifest(downgraded), formats.supported(newer), []);
  await checkpoint.restore(
    upgraded,
    transfer.decode(json.clone(back), newer).runtime,
    true,
    "/tmp/unused",
    "/tmp/corgi",
    false,
  );
  expect(upgraded.panes[0].restoring()).toBe(command);
  using recovered = new Runtime();
  const saved = transfer.recovery(upgraded, checkpoint.capture(upgraded, false));
  await checkpoint.restore(
    recovered,
    transfer.recover(json.stringify(saved)).value,
    false,
    "/tmp/unused",
    "/tmp/corgi",
    false,
  );
  expect(recovered.panes[0].restoring()).toBe(command);
});

test("retained provider resume metadata keeps its launch options and does not duplicate resume arguments", async () => {
  using original = fixture();
  for (const pane of original.panes) {
    pane.dormant = true;
    pane.resume_hint.provider = "codex";
    pane.resume_hint.session = new Text("saved-session");
  }
  original.panes[1].launch = new Launch({
    provider: "codex",
    model: "custom-model",
    args: ["--foo"],
    env: [["KEPT", "1"]],
  });
  const expected = original.panes.map(pane => pane.restoring()),
    sent = transfer.encode(original, manifest(original), transfer.info().formats, []);
  using restored = new Runtime();
  await checkpoint.restore(
    restored,
    transfer.decode(json.clone(sent)).runtime,
    true,
    "/tmp/unused",
    "/tmp/corgi",
    false,
  );
  expect(restored.panes[0].launch).toBeNull();
  expect(restored.panes[1].launch?.agent).toEqual(original.panes[1].launch.agent);
  expect(restored.panes.map(pane => pane.restoring())).toEqual(expected);
});

test("live baseline handoff bypasses failing migrations and auxiliary serialization", async () => {
  using original = fixture();
  original.panes[0].terminal.send(Buffer.from([0, 128, 255, 27, 10]));
  let calls = 0;
  const fail = () => {
      calls++;
      throw Error("AuxiliaryMigrationFailed");
    },
    id = "a".repeat(12),
    history = createHistory(id, [
      { id, parent: formats.baseline, description: "Unusable auxiliary migrations", up: fail, down: fail },
    ]),
    saved = { ...manifest(original), theme: { toJSON: fail } },
    wire = json.clone(transfer.encode(original, saved, [formats.baseline], [], history));
  expect(wire.payload).toBeNull();
  // Baseline readers ignore auxiliary bytes even if an older sender included them.
  wire.payload = { runtime: { panes: "unreadable metadata" } };
  const decoded = transfer.decode(wire, history);
  using restored = new Runtime();
  await checkpoint.restore(restored, decoded.runtime, true, "/tmp/unused", "/tmp/corgi");
  expect(restored.panes.map(pane => pane.id)).toEqual(original.panes.map(pane => pane.id));
  expect(restored.panes[0].terminal.pendingInput()).toBe("AID/Gwo=");
  expect(calls).toBe(0);
  const invalid = json.clone(wire);
  invalid.core.panes[0].workspace = 999;
  expect(() => transfer.decode(invalid, history)).toThrow("InvalidHandoffCore");
});

test("failed non-baseline export and import can both retry using core alone", () => {
  using original = fixture();
  const id = "a".repeat(12),
    parent = "b".repeat(12),
    fail = () => {
      throw Error("AuxiliaryMigrationFailed");
    },
    shared = { id: parent, parent: formats.baseline, description: "Initial metadata", up: fail, down: fail },
    current = createHistory(id, [{ id, parent, description: "Incompatible metadata", up: fail, down: fail }, shared]),
    older = createHistory(parent, [shared]),
    saved = manifest(original);
  expect(() => transfer.encode(original, saved, formats.supported(older), [], current)).toThrow(
    "AuxiliaryMigrationFailed",
  );
  const down = transfer.encode(original, saved, [formats.baseline], [], current);
  expect(transfer.decode(down, older).runtime.panes).toHaveLength(original.panes.length);
  const up = transfer.encode(original, saved, formats.supported(current), [], older);
  expect(() => transfer.decode(up, current)).toThrow("AuxiliaryMigrationFailed");
  const retry = transfer.encode(original, saved, [formats.baseline], [], older);
  expect(transfer.decode(retry, current).runtime.panes).toHaveLength(original.panes.length);
});

test("cold baseline and unknown revisions skip auxiliary migrations too", () => {
  using original = fixture();
  let calls = 0;
  const id = "a".repeat(12),
    fail = () => {
      calls++;
      throw Error("AuxiliaryMigrationFailed");
    },
    history = createHistory(id, [
      { id, parent: formats.baseline, description: "Unusable auxiliary migrations", up: fail, down: fail },
    ]),
    saved = { ...transfer.recovery(original, checkpoint.capture(original, false)), panes: "invalid metadata" };
  for (const revision of [formats.baseline, "f".repeat(12)]) {
    saved.transfer.format = revision;
    expect(transfer.recover(json.stringify(saved), history).value.panes).toHaveLength(original.panes.length);
  }
  saved.transfer.format = id;
  expect(transfer.recover(json.stringify(saved), history, true).value.panes).toHaveLength(original.panes.length);
  expect(calls).toBe(0);
});
test("cold recovery of an unknown branch ignores its schema and retains the baseline", async () => {
  using original = fixture();
  const saved = transfer.recovery(original, checkpoint.capture(original, false));
  saved.transfer.format = "f".repeat(12);
  const bytes = json.stringify({
      ...saved,
      version: 999,
      panes: "a future representation",
      conversations: "different",
    }),
    decoded = transfer.recover(bytes);
  expect(decoded.migrated).toBe(true);
  using recovered = new Runtime();
  await checkpoint.restore(recovered, decoded.value, false, "/tmp/unused", "/tmp/corgi", false);
  expect(recovered.panes.map(p => p.id)).toEqual(original.panes.map(p => p.id));
  expect(recovered.panes[0].terminal.text()).toContain("screen 0");
  expect(recovered.panes.every(p => p.terminal.fd === -1)).toBe(true);
});
test("matching recovery formats preserve metadata and legacy checkpoints still decode", () => {
  using original = fixture();
  original.panes[0].label = "kept";
  const saved = checkpoint.capture(original, false),
    wrapped = transfer.recovery(original, saved);
  expect(transfer.recover(json.stringify(wrapped)).value.panes[0].label).toBe("kept");
  expect(transfer.recover(json.stringify(saved)).value).toEqual(json.clone(saved));
  expect(transfer.recover(json.stringify(wrapped)).migrated).toBe(false);
});
test("invalid core and descriptor inventories fail before any process is adopted", () => {
  using original = fixture();
  const sent = transfer.encode(original, manifest(original), transfer.info().formats, []);
  for (const mutate of [
    (v: typeof sent) => {
      v.core.panes[0].workspace = 999;
    },
    (v: typeof sent) => {
      v.core.panes[0].id = v.core.panes[1].id;
    },
    (v: typeof sent) => {
      v.core.panes[0].screen.fd = 64;
    },
    (v: typeof sent) => {
      v.handles = [64, 64];
    },
  ]) {
    const value = json.clone(sent);
    mutate(value);
    expect(() => transfer.decode(value)).toThrow("InvalidHandoffCore");
  }
  const saved = core.capture(original, checkpoint.capture(original, false));
  saved.panes[0].screen.pending = "YQ==";
  expect(() => core.decode(saved)).toThrow("InvalidHandoffCore");
});
test("the current format includes the immutable baseline and round trips opaque metadata", () => {
  expect(formats.supported(state_formats.history).at(-1)).toBe(formats.baseline);
  using original = fixture();
  const before = manifest(original),
    sent = transfer.encode(original, before, transfer.info().formats, []);
  expect(transfer.decode(sent).runtime.panes[0].binding).toEqual(json.clone(before.runtime.panes[0].binding));
});

test("numbered checkpoints continue through later revisions with their core protected", () => {
  let calls = 0;
  const history = new formats.History("a".repeat(12), [
    ...state_formats.revisions,
    {
      id: "a".repeat(12),
      parent: formats.initial,
      description: "Reorganize auxiliary state",
      up(value) {
        calls++;
        const saved = json.object(value);
        expect(saved.runtime.version).toBe(6);
        expect(saved.runtime.panes.every((p: any) => p.screen === undefined)).toBe(true);
        return { runtime: { ...saved.runtime, panes: [], upgraded: true } };
      },
      down: () => null,
    },
  ]);
  for (const version of [2, 3, 4, 5, 6]) {
    const bytes = readFileSync(new URL(`../fixtures/checkpoint-v${version}.json`, import.meta.url), "utf8"),
      original = transfer.recover(bytes).value,
      migrated = transfer.recover(bytes, history);
    expect(migrated.migrated).toBe(true);
    expect(migrated.value.upgraded).toBe(true);
    expect(migrated.value.panes.map((p: any) => p.id)).toEqual(original.panes.map((p: any) => p.id));
    expect(migrated.value.panes.map((p: any) => p.screen.data)).toEqual(original.panes.map((p: any) => p.screen.data));
  }
  expect(calls).toBe(5);
  using runtime = fixture();
  const invalid = { ...checkpoint.capture(runtime, false), next_pane: 0 };
  expect(() => transfer.recover(json.stringify(invalid), history)).toThrow("InvalidCheckpoint");
});

test("later revisions cannot replace legacy handoff descriptors or lose its core on failure", () => {
  using runtime = fixture();
  const saved = json.clone({ ...manifest(runtime), retired: { listener: 55, clients: [{ fd: 56 }] }, requester: 57 }),
    transform = (up: formats.Step) =>
      new formats.History("a".repeat(12), [
        ...state_formats.revisions,
        { id: "a".repeat(12), parent: formats.initial, description: "Change metadata", up, down: () => null },
      ]);
  for (const up of [
    () => ({ requester: 99, retired: { listener: 99 }, runtime: { panes: [] } }),
    () => null,
    () => {
      throw Error("AuxiliaryMigrationFailed");
    },
  ]) {
    const migrated = transfer.upgrade(saved, transform(up));
    expect(migrated.requester).toBe(57);
    expect(migrated.retired).toEqual(saved.retired);
    expect(migrated.runtime.panes.map((p: any) => p.id)).toEqual(runtime.panes.map(p => p.id));
  }
});

test("release exports reverse shared revisions before the historical handoff downgrade", async () => {
  using original = fixture();
  const saved = json.object(json.clone(manifest(original)));
  saved.version = migrations.handoff_version;
  saved.runtime.closed_tabs = saved.runtime.closed;
  delete saved.runtime.closed;
  let calls = 0;
  const history = new formats.History("a".repeat(12), [
      ...state_formats.revisions,
      {
        id: "a".repeat(12),
        parent: state_formats.current,
        description: "Rename closed tabs",
        up: value => value,
        down(value) {
          calls++;
          const metadata = json.object(value);
          expect(metadata.runtime.panes.every((p: any) => p.screen === undefined)).toBe(true);
          metadata.runtime.closed = metadata.runtime.closed_tabs;
          delete metadata.runtime.closed_tabs;
          metadata.requester = 999;
          return metadata;
        },
      },
    ]),
    exported = transfer.downgrade(original, saved, history),
    numbered = handoff_rollback.downgrade(exported, 17);
  expect(calls).toBe(1);
  expect(exported.runtime.closed).toEqual([]);
  expect(numbered.version).toBe(6);
  expect(numbered.requester).toBe(-1);
  expect(numbered.runtime.panes.map((p: any) => p.screen)).toEqual(saved.runtime.panes.map((p: any) => p.screen));
  expect(numbered.runtime).not.toHaveProperty("closed_tabs");
  using restored = new Runtime();
  await checkpoint.restore(
    restored,
    migrations.decode("handoff", json.stringify(numbered)).value.runtime,
    true,
    "/tmp/unused",
    "/tmp/corgi",
    false,
  );
  expect(restored.panes.map(p => p.id)).toEqual(original.panes.map(p => p.id));
});

test("release exports retain core when shared down steps fail or discard metadata", () => {
  using original = fixture();
  const saved = manifest(original);
  for (const down of [
    () => null,
    () => {
      throw Error("FailedMigration");
    },
  ]) {
    const history = new formats.History("a".repeat(12), [
      ...state_formats.revisions,
      { id: "a".repeat(12), parent: state_formats.current, description: "Discard metadata", up: value => value, down },
    ]);
    const exported = transfer.downgrade(original, saved, history);
    expect(exported.runtime.panes.map((p: any) => p.screen)).toEqual(saved.runtime.panes.map(p => p.screen));
    expect(exported.requester).toBe(-1);
  }
});
