import { expect, setSystemTime, test } from "bun:test";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import * as state_revision from "../../scripts/state_revision";
import * as state_formats from "./state_formats";
import * as formats from "./formats";

const root = join(import.meta.dir, "../.."),
  fixtures = join(root, "src/fixtures/state_revisions");

test("saved structures require an explicit state revision", () => {
  const recorded = JSON.parse(readFileSync(join(fixtures, state_formats.current + ".json"), "utf8"));
  expect(
    state_revision.structures(root),
    'Saved structures changed: add a migration with bun tools/state_revision.ts "Describe the change"; keep existing revision fixtures.',
  ).toEqual(recorded.structures);
});

test("every revision is registered with its original parent and structure fixture", async () => {
  const files = readdirSync(join(root, "src/persist/revisions")).filter(name => name.endsWith(".ts")),
    ids = await Promise.all(files.map(async file => (await import(`./revisions/${file}`)).revision.id));
  expect(ids.sort()).toEqual(state_formats.revisions.map(revision => revision.id).sort());
  expect(readdirSync(fixtures).sort()).toEqual(ids.map(id => id + ".json").sort());
  for (const revision of state_formats.revisions) {
    const recorded = JSON.parse(readFileSync(join(fixtures, revision.id + ".json"), "utf8"));
    expect(recorded.parent).toBe(revision.parent);
    expect(revision.description.trim().length).toBeGreaterThan(0);
  }
});

test("migration drafts have independent identities even with identical descriptions", async () => {
  const first = state_revision.draft(formats.baseline, 'Store "last_seen" in milliseconds'),
    second = state_revision.draft(formats.baseline, 'Store "last_seen" in milliseconds');
  expect(first.id).toMatch(/^[a-f0-9]{12}$/);
  expect(second.id).not.toBe(first.id);
  const compiled = await Bun.build({
    entrypoints: ["revision.ts"],
    target: "bun",
    plugins: [
      {
        name: "revision",
        setup(build) {
          build.onResolve({ filter: /^revision\.ts$/ }, () => ({ path: "revision.ts", namespace: "revision" }));
          build.onLoad({ filter: /.*/, namespace: "revision" }, () => ({ contents: first.source, loader: "ts" }));
        },
      },
    ],
  });
  expect(compiled.success).toBe(true);
  const loaded = await import(
    "data:text/javascript;base64," + Buffer.from(await compiled.outputs[0].text()).toString("base64")
  );
  expect(loaded.revision.description).toBe('Store "last_seen" in milliseconds');
  expect(loaded.revision.parent).toBe(formats.baseline);
  expect(loaded.revision.up({ private: "old metadata" })).toBeNull();
  expect(loaded.revision.down({ private: "new metadata" })).toBeNull();
  expect(() => state_revision.draft(formats.baseline, " ")).toThrow("InvalidStateRevision");
});

test("the generator appends migrations and schema checks without rewriting previous revisions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "corgi-state-revision-"));
  try {
    mkdirSync(join(directory, "src/persist"), { recursive: true });
    cpSync(join(root, "src/persist/revisions"), join(directory, "src/persist/revisions"), { recursive: true });
    for (const file of ["formats.ts", "state_formats.ts", "revision_values.ts"])
      cpSync(join(root, "src/persist", file), join(directory, "src/persist", file));
    mkdirSync(join(directory, "src/fixtures"), { recursive: true });
    for (const name of ["checkpoint", "handoff", "protocol", "viewer"])
      cpSync(join(root, "src/fixtures", name + ".schema"), join(directory, "src/fixtures", name + ".schema"));
    setSystemTime(new Date("2026-11-18T23:55:00-08:00"));
    const first = await state_revision.create(directory, "Store last_seen in milliseconds"),
      fixture = join(directory, "src/fixtures/state_revisions", first.id + ".json"),
      recorded = readFileSync(fixture, "utf8");
    expect(first.name).toBe(`20261119_075500_${first.id}_store_last_seen_in_milliseconds`);
    appendFileSync(join(directory, "src/fixtures/checkpoint.schema"), "\n$.new_field: string\n");
    expect(JSON.parse(recorded).structures).not.toEqual(state_revision.structures(directory));
    // Clock order must not change the parent selected from the registry.
    setSystemTime(new Date("2026-11-18T07:55:00Z"));
    const second = await state_revision.create(directory, "Add a new field"),
      next = JSON.parse(readFileSync(join(directory, "src/fixtures/state_revisions", second.id + ".json"), "utf8"));
    expect(second.name).toBe(`20261118_075500_${second.id}_add_a_new_field`);
    expect(next.parent).toBe(first.id);
    expect(next.structures).toEqual(state_revision.structures(directory));
    expect(readFileSync(fixture, "utf8")).toBe(recorded);
    const workspace = await state_revision.create(directory, "Name workspace groups", "workspaces"),
      viewer = await state_revision.create(directory, "Rename a setting", "viewer"),
      updated = await import(
        pathToFileURL(join(directory, "src/persist/state_formats.ts")).href + `?revision=${workspace.id}`
      ),
      saved = { workspaces: [{ id: 1, name: "retained" }] },
      files = { viewer: { sidebar_width: 30 }, config: { theme: "animal_style" } };
    expect(updated.current).toBe(second.id);
    expect(updated.history.ancestors.slice(0, 3)).toEqual([second.id, first.id, state_formats.current]);
    expect(updated.workspaces.current).toBe(workspace.id);
    expect(updated.workspaces.up(saved, state_formats.workspaces.current)).toEqual(saved);
    expect(updated.workspaces.down(saved, state_formats.workspaces.current)).toEqual(saved);
    expect(updated.viewer.current).toBe(viewer.id);
    expect(updated.viewer.ancestors[1]).toBe(state_formats.viewer.current);
    expect(updated.viewer.up(files, state_formats.viewer.current)).toEqual(files);
    expect(updated.checkpoint.current).toBe(state_formats.checkpoint.current);
    expect(updated.handoff.current).toBe(state_formats.handoff.current);
  } finally {
    setSystemTime();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the generator rejects unresolved merged histories before writing files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "corgi-state-conflict-")),
    revisions = join(directory, "src/persist/revisions"),
    registry = join(directory, "src/persist/state_formats.ts");
  try {
    mkdirSync(join(directory, "src/persist"), { recursive: true });
    cpSync(join(root, "src/persist/revisions"), revisions, { recursive: true });
    for (const file of ["formats.ts", "state_formats.ts", "revision_values.ts"])
      cpSync(join(root, "src/persist", file), join(directory, "src/persist", file));
    const original = readFileSync(registry, "utf8");
    for (const scenario of ["fork", "unselected", "root"]) {
      const next = state_revision.draft(
          scenario === "fork" ? formats.baseline : state_formats.current,
          "Conflicting migration",
        ),
        path = join(revisions, next.name + ".ts");
      writeFileSync(
        path,
        scenario === "root" ? next.source.replace(/parent: "[a-f0-9]{12}"/, "parent: null") : next.source,
      );
      const before = readdirSync(revisions);
      // Neither saved format can append while the checkout has unresolved revisions.
      for (const kind of ["state", "workspaces", "viewer"] as const)
        await expect(state_revision.create(directory, "Next migration", kind)).rejects.toThrow(
          scenario === "fork" ? "ForkedStateHistory" : "InvalidStateHeads",
        );
      expect(readFileSync(registry, "utf8")).toBe(original);
      expect(readdirSync(revisions)).toEqual(before);
      expect(readdirSync(join(directory, "src"))).toEqual(["persist"]);
      rmSync(path);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
