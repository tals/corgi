import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as json from "../json";
import * as migrations from "./migrations";
import * as state_formats from "./state_formats";
import * as handoff_rollback from "./handoff_rollback";

function fixture(direction: "in" | "out") {
  return json.parse(
    readFileSync(new URL(`../fixtures/steps/handoff-7.down.${direction}.json`, import.meta.url), "utf8"),
  );
}

test("histories downgrade to release 20261106T233845Z-03c72b717526 without changing process state", () => {
  const original = fixture("in"),
    saved = state_formats.handoff.down(original, migrations.legacy.handoff[6]);
  expect(json.clone(saved)).toEqual(fixture("out"));
  expect(original).toEqual(fixture("in"));
  expect(state_formats.checkpoint.down(original.runtime, migrations.legacy.checkpoint[6])).toEqual(original.runtime);
  const workspaces = { version: 2, workspaces: [{ id: 1, name: "kept", cwd: "/tmp" }] };
  expect(state_formats.workspaces.down(workspaces, migrations.legacy.workspaces[2])).toEqual(workspaces);
  const upgraded = json.object(state_formats.handoff.up(saved, migrations.legacy.handoff[6]));
  expect(upgraded.runtime).toEqual(original.runtime);
  expect(upgraded.summaries).toEqual(original.summaries);
  expect(upgraded.bell_seq).toBe(original.bell_seq);
  expect(upgraded.retired).toEqual({ listener: 5, clients: [{ fd: 7, viewer: false }] });
  expect(upgraded.links).toEqual([]);
});

test("live rollback uses the revision with a newly supplied listener and numeric release header", () => {
  const original = fixture("in");
  delete original.retired;
  const saved = handoff_rollback.downgrade(original, 17);
  expect(json.clone(saved)).toEqual({ ...fixture("out"), version: 6, listener: 17 });
  expect(original.version).toBe(7);
  expect(original.links).toHaveLength(1);
  expect(original.retired).toBeUndefined();
  const upgraded = migrations.decode("handoff", json.stringify(saved)).value;
  expect(upgraded.version).toBe(migrations.handoff_version);
  expect(upgraded.runtime).toEqual(original.runtime);
  expect(upgraded.retired.listener).toBe(17);
});
