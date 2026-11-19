import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import {
  openSync,
  closeSync,
  existsSync,
  writeFileSync,
  symlinkSync,
  lstatSync,
  rmSync,
  chmodSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  Preferences,
  read,
  write,
  update,
  updateKeys,
  inspect,
  load,
  migrate,
  sharedLock,
  type Paths,
} from "./preferences";
import * as state_formats from "./persist/state_formats";
import * as keybindings from "./keybindings";
import { flock } from "./native_bridge";

const current = state_formats.viewer.current;
async function scratch(name: string): Promise<{ root: string; where: Paths }> {
  const root = await mkdtemp(join(tmpdir(), `corgi-${name}-`));
  return {
    root,
    where: {
      viewer: join(root, "state", "corgi", "viewer.json"),
      config: join(root, "config", "corgi", "config.json"),
    },
  };
}
async function json(file: string) {
  return JSON.parse(await readFile(file, "utf8"));
}
async function put(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
}
/** Runs `body` with these variables, as a viewer started with them would see them. */
async function withEnv(env: Record<string, string | undefined>, body: () => Promise<void> | void) {
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(env))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await body();
  } finally {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
}

test.each([false, true])("legacy setup carries over while the files are locked (existing: %s)", async existing => {
  const { root, where } = await scratch("migrate-lock"),
    socket = join(root, "old.sock");
  const shared = Object.assign(new Preferences(), { sidebar_width: 45, keys: { new: "prefix+y" } });
  await mkdir(dirname(where.viewer), { recursive: true });
  // An older build's file beside the socket, settings and all.
  writeFileSync(
    socket + ".viewer.json",
    JSON.stringify({ preset: "tmux", prefix: "ctrl_a", onboarding_complete: true }),
  );
  if (existing) write(shared, where);
  const fd = openSync(where.viewer + ".lock", "a", 0o600);
  const attempt = () => {
    const module = new URL("./preferences.ts", import.meta.url).href;
    const child = Bun.spawnSync(
      [process.execPath, "-e", `import { load } from ${JSON.stringify(module)}; console.log(JSON.stringify(load()));`],
      {
        env: {
          ...process.env,
          XDG_STATE_HOME: join(root, "state"),
          XDG_CONFIG_HOME: join(root, "config"),
          CORGI_ENV_DIR: "",
          CORGI_SOCKET: socket,
        },
      },
    );
    expect(child.exitCode).toBe(0);
    return JSON.parse(child.stdout.toString());
  };
  try {
    expect(flock(fd)).toBe(true);
    // A config.json already there keeps its own choices; only setup being done carries.
    const expected = Object.assign(new Preferences(), existing ? shared : { preset: "tmux", prefix: "ctrl_a" }, {
      onboarding_complete: true,
    });
    expect(attempt()).toEqual(JSON.parse(JSON.stringify(expected)));
    if (existing) expect(read(where)).toEqual(shared);
    else expect(existsSync(where.viewer)).toBe(false);
    flock(fd, false);
    expect(attempt()).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(read(where)).toEqual(expected);
    expect(await json(where.config)).toMatchObject(
      existing ? { preset: "corgi" } : { preset: "tmux", prefix: "ctrl_a" },
    );
    expect(await json(where.viewer)).toMatchObject({ onboarding_complete: true, format: current });
  } finally {
    closeSync(fd);
    await rm(root, { recursive: true, force: true });
  }
});
test("startup retries the legacy import after a busy lock without losing settings or layout", async () => {
  const { root, where } = await scratch("legacy-startup"),
    socket = join(root, "old.sock");
  try {
    await put(`${socket}.viewer.json`, {
      onboarding_complete: true,
      sidebar_width: 44,
      theme: "animal_style",
      keys: { new: "prefix+y" },
    });
    await withEnv(
      {
        XDG_STATE_HOME: join(root, "state"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_RUNTIME_DIR: join(root, "runtime"),
        CORGI_ENV_DIR: undefined,
        CORGI_SOCKET: socket,
      },
      () => {
        const held = openSync(sharedLock(), "a", 0o600);
        try {
          expect(flock(held)).toBe(true);
          expect(load().sidebar_width).toBe(44);
          expect(load().keys).toEqual({ new: "prefix+y" });
          expect(existsSync(where.viewer)).toBe(false);
        } finally {
          closeSync(held);
        }
        const expected = {
          onboarding_complete: true,
          sidebar_width: 44,
          theme: "animal_style",
          keys: { new: "prefix+y" },
        };
        expect(load(true)).toMatchObject(expected);
        expect(read(where)).toMatchObject(expected);
      },
    );
    expect(await json(where.viewer)).not.toHaveProperty("theme");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy setup applies the old keymap and skips only the shortcuts it clashes with", async () => {
  const { root, where } = await scratch("migrate"),
    socket = join(root, "old.sock");
  try {
    await withEnv(
      {
        XDG_STATE_HOME: join(root, "state"),
        XDG_CONFIG_HOME: join(root, "config"),
        CORGI_ENV_DIR: undefined,
        CORGI_SOCKET: socket,
      },
      async () => {
        for (const [preset, prefix, chord] of [
          ["corgi", "ctrl_a", "ctrl+a"],
          ["tmux", "ctrl_b", "prefix+0"],
          ["corgi", "ctrl_a", "prefix+y"],
        ] as const) {
          // A shared viewer.json from before config.json, and none yet.
          rmSync(where.config, { force: true });
          await put(where.viewer, { keys: { new: chord }, sidebar_width: 45 });
          writeFileSync(socket + ".viewer.json", JSON.stringify({ preset, prefix, onboarding_complete: true }));
          const migrated = load();
          expect(() => migrated.bindings()).not.toThrow();
          expect(migrated).toMatchObject({ preset, prefix, onboarding_complete: true, sidebar_width: 45 });
          // The clashing shortcut stays in the file for the person to fix.
          expect(migrated.keys).toEqual(chord === "prefix+y" ? { new: chord } : {});
          expect((await json(where.config)).keys).toEqual({ new: chord });
          expect(read(where)).toEqual(migrated);
        }
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preferences round trip, each field in its file, and fall back to defaults", async () => {
  const { root, where } = await scratch("preferences");
  try {
    expect(read(where)).toEqual(new Preferences());
    const p = new Preferences();
    p.agents = "all";
    p.language = "ja";
    write(p, where);
    expect(read(where)).toEqual(p);
    p.agents = "workspace";
    p.sidebar_width = 44;
    p.sidebar_split = 9;
    p.review_tree_rows = 14;
    p.agent_scroll = { workspace: 2, offset: 7 };
    p.workspace_order = [JSON.stringify(["work", 2]), JSON.stringify(["local", 1])];
    write(p, where);
    update({ agents: "all" }, where);
    expect(read(where)).toMatchObject({
      agents: "all",
      language: "ja",
      sidebar_width: 44,
      sidebar_split: 9,
      review_tree_rows: 14,
      agent_scroll: { workspace: 2, offset: 7 },
      workspace_order: p.workspace_order,
    });
    expect(await json(where.config)).toMatchObject({ language: "ja", preset: "corgi" });
    expect(await json(where.config)).not.toHaveProperty("sidebar_width");
    expect(await json(where.viewer)).toMatchObject({ agents: "all", sidebar_width: 44, format: current });
    await put(where.config, '{"resources":{"enabled":false,"io":false,"alerts":true}}');
    expect(read(where).resources).toEqual({ enabled: false });
    await put(where.config, '{"preset":"cmux"}');
    expect(read(where).preset).toBe(process.platform === "darwin" ? "cmux" : "corgi");
    await put(where.config, '{"theme":"animal_style","corgi_intensity":0}');
    expect(read(where)).toMatchObject({ theme: "animal_style", corgi_intensity: 0 });
    // A theme this build doesn't know keeps the rest of the file.
    await put(where.config, '{"theme":"solarized","corgi_intensity":0}');
    expect(read(where)).toMatchObject({ theme: undefined, corgi_intensity: 0 });
    // Unset, the theme stays out of the file and the terminal keeps picking.
    write(new Preferences(), where);
    expect(await json(where.config)).not.toHaveProperty("theme");
    await put(where.viewer, '{"agent_scroll":{"workspace":null,"offset":4}}');
    expect(read(where).agent_scroll).toEqual({ workspace: null, offset: 4 });
    await put(where.viewer, '{"agent_scroll":{"workspace":2,"offset":-1}}');
    expect(read(where)).toEqual(new Preferences());
    await put(where.config, '{"theme":3}');
    expect(read(where)).toEqual(new Preferences());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent sorting follows the default until explicitly saved", async () => {
  const { root, where } = await scratch("agent-sort");
  try {
    expect(read(where).agentSort()).toBe("manual");
    write(new Preferences(), where);
    expect(await json(where.viewer)).not.toHaveProperty("agent_sort");
    update({ sidebar_width: 44 }, where);
    expect(await json(where.viewer)).not.toHaveProperty("agent_sort");
    expect(read(where).agentSort()).toBe("manual");
    for (const agent_sort of ["activity", "manual"] as const) {
      update({ agent_sort }, where);
      update({ agents: "all" }, where);
      expect(await json(where.viewer)).toHaveProperty("agent_sort", agent_sort);
      expect(read(where).agentSort()).toBe(agent_sort);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the old sleeping-corgi switch becomes brightness, which moves to config.json", async () => {
  const { root, where } = await scratch("intensity");
  try {
    const cases: [Record<string, unknown>, number][] = [
      [{}, 50],
      [{ sleeping_corgis: true }, 50],
      [{ sleeping_corgis: false }, 0],
      [{ sleeping_corgis: true, corgi_intensity: 0 }, 0],
      [{ sleeping_corgis: false, corgi_intensity: 75 }, 75],
      [{ corgi_intensity: 100 }, 100],
    ];
    for (const [saved, intensity] of cases) {
      rmSync(where.config, { force: true });
      await put(where.viewer, { theme: "animal_style", sidebar_width: 44, resources: { enabled: false }, ...saved });
      const before = read(where);
      expect(before).toMatchObject({
        corgi_intensity: intensity,
        theme: "animal_style",
        sidebar_width: 44,
        resources: { enabled: false },
      });
      expect(before).not.toHaveProperty("sleeping_corgis");
      migrate(where);
      // config.json takes what differs from the old defaults.
      expect(await json(where.config)).toEqual({
        theme: "animal_style",
        resources: { enabled: false },
        ...(intensity === 50 ? {} : { corgi_intensity: intensity }),
      });
      expect(await json(where.viewer)).toEqual({ sidebar_width: 44, format: current });
      expect(read(where)).toEqual(before);
    }
    // As before, a brightness the old builds couldn't read leaves the switch in charge.
    for (const invalid of [-1, 101, 12.5, "20", null, {}, true])
      for (const [saved, intensity] of [
        [{ corgi_intensity: invalid, sleeping_corgis: false }, 0],
        [{ corgi_intensity: invalid }, 50],
      ] as const) {
        rmSync(where.config, { force: true });
        await put(where.viewer, saved);
        migrate(where);
        expect(read(where).corgi_intensity).toBe(intensity);
      }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the prompt's last pick round trips, and one this build can't read falls back alone", async () => {
  const { root, where } = await scratch("prompt-model");
  try {
    const pick = {
      provider: "claude" as const,
      account: "/a",
      model: "claude-haiku-4-5",
      name: "Haiku 4.5",
      effort: null,
    };
    update({ prompt_model: pick, sidebar_width: 40 }, where);
    expect(read(where).prompt_model).toEqual(pick);
    await put(where.viewer, { prompt_model: { ...pick, effort: "high" } });
    expect(read(where).prompt_model).toEqual({ ...pick, effort: "high" });
    await put(where.viewer, { prompt_model: { ...pick, effort: "galaxy" } });
    expect(read(where).prompt_model).toEqual(pick);
    await put(where.viewer, { prompt_model: { ...pick, provider: "future" }, sidebar_width: 40 });
    expect(read(where)).toMatchObject({ prompt_model: undefined, sidebar_width: 40 });
    await put(where.viewer, { prompt_model: "opus" });
    expect(read(where).prompt_model).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a setting or shortcut this build can't use falls back alone and is named", async () => {
  const { root, where } = await scratch("preferences-problems");
  try {
    await put(where.viewer, { format: current, onboarding_complete: true, sidebar_width: "wide", review_width: 50 });
    await put(where.config, {
      prefix: "hyper_q",
      worktree_folder: "{nope}",
      corgi_intensity: "20",
      keys: {
        worktrees: "ctrl+alt+g",
        new: "prefix+y",
        bogus: "ctrl+x",
        close: "ctrl+escape",
        "split:right": "prefix+y",
      },
    });
    const { prefs, problems } = inspect(where);
    // viewer.json's fields are the viewers' own, and fall back quietly.
    expect(prefs).toMatchObject({ onboarding_complete: true, prefix: "ctrl_b", sidebar_width: 28, review_width: 50 });
    expect(prefs.keys).toEqual({ worktrees: "ctrl+alt+g", new: "prefix+y" });
    expect(problems.every(p => p.file === where.config)).toBe(true);
    expect(problems.map(p => p.text.slice(0, p.text.indexOf(":")))).toEqual([
      "prefix",
      "corgi_intensity",
      "worktree_folder",
      "keys.bogus",
      "keys.close",
      "keys.split",
    ]);
    expect(problems.at(-1)!.text).toContain("use the same shortcut");
    expect(read(where)).toEqual(prefs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a shortcut that a later entry frees, such as one taking a tab key, still applies", async () => {
  const { root, where } = await scratch("preferences-freed");
  try {
    // ctrl+b is the prefix, so close can't have it; new takes the key tab gives up.
    await put(where.config, { keys: { new: "prefix+1", close: "ctrl+b", tab: [] } });
    const { prefs, problems } = inspect(where);
    expect(prefs.keys).toEqual({ new: "prefix+1", tab: [] });
    expect(problems.map(p => p.text.slice(0, p.text.indexOf(":")))).toEqual(["keys.close"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unusable shortcut does not suppress a later working one", async () => {
  const { root, where } = await scratch("preferences-retry-shortcut");
  try {
    await put(where.config, { keys: { new: ["alt+w", "prefix+1"], help: "alt+w" } });
    const { prefs, problems } = inspect(where);
    expect(prefs.keys).toEqual({ help: "alt+w" });
    expect(problems).toHaveLength(1);
    expect(problems[0].text).toStartWith("keys.new:");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("editing shortcuts preserves a skipped duplicate spelling", async () => {
  const { root, where } = await scratch("preferences-skipped-alias");
  try {
    await put(where.config, { keys: { worktrees: "alt+w", "worktrees:0": "ctrl+b" } });
    const before = read(where);
    const saved = updateKeys(before, { ...before.keys, new: "prefix+y" }, where);
    expect(saved.keys).toEqual({ worktrees: "alt+w", new: "prefix+y" });
    expect((await json(where.config)).keys).toEqual({
      worktrees: "alt+w",
      new: "prefix+y",
      "worktrees:0": "ctrl+b",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saving rewrites only what changed and keeps what this build skipped", async () => {
  const { root, where } = await scratch("preferences-save");
  try {
    const written = { future: { kept: true }, prefix: "hyper_q", keys: { bogus: "ctrl+x", new: "prefix+y" } };
    await put(where.config, written);
    update({ theme: "animal_style", sidebar_width: 50 }, where);
    expect(await json(where.config)).toEqual({ ...written, theme: "animal_style" });
    expect(await json(where.viewer)).toEqual({ format: current, sidebar_width: 50 });
    // The editor's shortcuts come first, so a skipped one can't take their keys.
    updateKeys(read(where), { new: "prefix+z" }, where);
    const saved = await json(where.config);
    expect(saved.keys).toEqual({ new: "prefix+z", bogus: "ctrl+x" });
    expect(Object.keys(saved.keys)).toEqual(["new", "bogus"]);
    expect(saved).toMatchObject({ future: { kept: true }, prefix: "hyper_q", theme: "animal_style" });
    // A save that would make a working shortcut fall back is refused.
    await put(where.config, { keys: { new: "ctrl+a" } });
    expect(() => update({ prefix: "ctrl_a" }, where)).toThrow("keys.new");
    expect(read(where).prefix).toBe("ctrl_b");
    // One already skipped may fall back for a new reason.
    await put(where.config, { keys: { new: ["ctrl+a", "ctrl+b"] } });
    update({ prefix: "ctrl_a" }, where);
    expect(read(where).prefix).toBe("ctrl_a");
    // A skipped shortcut the editor's change frees comes back with the save.
    await put(where.config, { keys: { new: "alt+x", close: "alt+x" } });
    const before = read(where);
    expect(before.keys).toEqual({ new: "alt+x" });
    expect(updateKeys(before, { new: "alt+y" }, where).keys).toEqual({ new: "alt+y", close: "alt+x" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("onboarding's choices go to config.json, and choosing what it holds writes nothing there", async () => {
  const { root, where } = await scratch("preferences-onboarding");
  try {
    update({ preset: "tmux", prefix: "ctrl_a", onboarding_complete: true }, where);
    expect(await json(where.config)).toEqual({ preset: "tmux", prefix: "ctrl_a" });
    expect(await json(where.viewer)).toEqual({ format: current, onboarding_complete: true });
    // A config.json linked read-only, as home-manager links one, still lets setup finish.
    await put(where.viewer, { format: current });
    chmodSync(where.config, 0o400);
    chmodSync(dirname(where.config), 0o500);
    try {
      update({ preset: "tmux", prefix: "ctrl_a", onboarding_complete: true }, where);
      expect(() => update({ preset: "herdr" }, where)).toThrow();
    } finally {
      chmodSync(dirname(where.config), 0o700);
      chmodSync(where.config, 0o600);
    }
    expect(read(where)).toMatchObject({ preset: "tmux", prefix: "ctrl_a", onboarding_complete: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("choosing the system language or the terminal's theme removes the saved one", async () => {
  const { root, where } = await scratch("preferences-unset");
  try {
    update({ language: "ja", theme: "animal_style" }, where);
    expect(await json(where.config)).toEqual({ language: "ja", theme: "animal_style" });
    update({ language: undefined, theme: undefined }, where);
    expect(await json(where.config)).toEqual({});
    expect(await json(where.viewer)).not.toHaveProperty("language");
    expect(read(where)).toMatchObject({ language: undefined, theme: undefined });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file that can't be read keeps setup done and is never overwritten", async () => {
  const { root, where } = await scratch("preferences-broken");
  try {
    await put(where.viewer, '{"onboarding_complete":true,');
    expect(inspect(where)).toEqual({
      prefs: Object.assign(new Preferences(), { onboarding_complete: true }),
      problems: [{ file: where.viewer, text: expect.stringContaining("can't be read") }],
    });
    expect(() => update({ sidebar_width: 40 }, where)).toThrow("Can't read viewer.json");
    migrate(where);
    expect(await readFile(where.viewer, "utf8")).toBe('{"onboarding_complete":true,');
    // It may still hold the settings, so none save until it's repaired.
    expect(() => update({ theme: "animal_style" }, where)).toThrow("Can't read viewer.json");
    expect(existsSync(where.config)).toBe(false);
    await put(where.viewer, { onboarding_complete: "yes" });
    expect(read(where).onboarding_complete).toBe(true);
    // Settings left in an unmigrated viewer.json don't stand in for a config.json that exists.
    await put(where.viewer, { onboarding_complete: true, preset: "tmux" });
    await put(where.config, '{"keys":');
    const reading = inspect(where);
    expect(reading.prefs).toEqual(Object.assign(new Preferences(), { onboarding_complete: true }));
    expect(reading.problems).toEqual([{ file: where.config, text: expect.stringContaining("can't be read") }]);
    expect(() => update({ theme: "animal_style" }, where)).toThrow("Can't read config.json");
    expect(() => updateKeys(reading.prefs, { new: "prefix+y" }, where)).toThrow("repair");
    expect(await readFile(where.config, "utf8")).toBe('{"keys":');
    // What viewers remember still saves, and the settings stay where they are until it's repaired.
    update({ sidebar_width: 40 }, where);
    expect(await json(where.viewer)).toEqual({ onboarding_complete: true, preset: "tmux", sidebar_width: 40 });
    expect(await readFile(where.config, "utf8")).toBe('{"keys":');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("viewer.json's settings move to config.json once, and a config.json already there wins", async () => {
  const { root, where } = await scratch("preferences-split");
  try {
    await put(where.viewer, {
      onboarding_complete: true,
      sidebar_width: 40,
      preset: "tmux",
      prefix: "ctrl_b",
      keys: { new: "prefix+y", bogus: "ctrl+x" },
      corgi_intensity: 50,
      future: 1,
    });
    const before = read(where);
    migrate(where);
    // As written, without the old defaults: what this build skips stays for the person to fix.
    expect(await json(where.config)).toEqual({ preset: "tmux", keys: { new: "prefix+y", bogus: "ctrl+x" } });
    expect(await json(where.viewer)).toEqual({
      onboarding_complete: true,
      sidebar_width: 40,
      future: 1,
      format: current,
    });
    expect(read(where)).toEqual(before);
    const settled = await readFile(where.viewer, "utf8");
    migrate(where);
    expect(await readFile(where.viewer, "utf8")).toBe(settled);
    // An older viewer still open writes its own layout again; config.json wins.
    await put(where.viewer, { onboarding_complete: true, sidebar_width: 41, preset: "herdr" });
    expect(read(where)).toMatchObject({ sidebar_width: 41, preset: "tmux" });
    migrate(where);
    expect(await json(where.config)).toMatchObject({ preset: "tmux" });
    expect(await json(where.viewer)).toEqual({ onboarding_complete: true, sidebar_width: 41, format: current });
    // A newer build's file is read as far as this build can, and left alone.
    const newer = { format: "f".repeat(12), sidebar_width: 42, preset: "herdr" };
    await put(where.viewer, newer);
    migrate(where);
    expect(await json(where.viewer)).toEqual(newer);
    expect(read(where)).toMatchObject({ sidebar_width: 42, preset: "tmux" });
    update({ review_width: 60 }, where);
    expect(await json(where.viewer)).toEqual({ ...newer, review_width: 60 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a save migrates settings first, so a viewer that missed migration at start loses none", async () => {
  const { root, where } = await scratch("preferences-late");
  try {
    await put(where.viewer, { onboarding_complete: true, preset: "tmux", keys: { new: "prefix+y" } });
    update({ theme: "animal_style" }, where);
    expect(await json(where.config)).toEqual({ preset: "tmux", keys: { new: "prefix+y" }, theme: "animal_style" });
    expect(read(where)).toMatchObject({ preset: "tmux", keys: { new: "prefix+y" }, theme: "animal_style" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration removes existing settings copies, and later saves keep them only in config.json", async () => {
  const { root, where } = await scratch("preferences-no-copy");
  try {
    const config = {
      preset: "tmux",
      prefix: "ctrl_a",
      language: "ja",
      theme: "animal_style",
      corgi_intensity: 75,
      resources: { enabled: false },
      keys: { worktrees: "ctrl+alt+g", bogus: "ctrl+x" },
      worktree_folder: "{nope}",
    };
    await put(where.config, config);
    await put(where.viewer, {
      ...config,
      format: "3bc5f3ca7f53",
      onboarding_complete: true,
      sidebar_width: 40,
      theme: "corgi",
    });
    migrate(where);
    const state = { format: current, onboarding_complete: true, sidebar_width: 40 };
    expect(await json(where.viewer)).toEqual(state);
    expect(await json(where.config)).toEqual(config);
    const inode = statSync(where.viewer).ino;
    update({ theme: "corgi" }, where);
    updateKeys(read(where), { worktrees: "alt+w" }, where);
    expect(statSync(where.viewer).ino).toBe(inode);
    expect(await json(where.viewer)).toEqual(state);
    expect(await json(where.config)).toEqual({
      ...config,
      theme: "corgi",
      keys: { worktrees: "alt+w", bogus: "ctrl+x" },
    });
    update({ sidebar_width: 45 }, where);
    expect(await json(where.viewer)).toEqual({ ...state, sidebar_width: 45 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("viewers with their own state folders and config paths share the preferences lock", async () => {
  const { root, where } = await scratch("preferences-shared");
  const other = { viewer: join(root, "other", "viewer.json"), config: where.config };
  try {
    update({ theme: "animal_style" }, where);
    const link = join(root, "linked", "config.json"),
      folder = join(root, "linked-folder");
    await mkdir(dirname(link), { recursive: true });
    symlinkSync(where.config, link);
    symlinkSync(dirname(where.config), folder, "dir");
    const held = openSync(sharedLock(), "a");
    try {
      expect(flock(held)).toBe(true);
      for (const config of [where.config, link, join(folder, "config.json"), join(root, "separate", "config.json")])
        expect(() => update({ theme: "corgi" }, { ...other, config })).toThrow("another viewer");
    } finally {
      closeSync(held);
    }
    // What viewers remember never makes a config folder.
    const bare = await scratch("preferences-bare");
    update({ sidebar_width: 30 }, bare.where);
    expect(existsSync(dirname(bare.where.config))).toBe(false);
    await rm(bare.root, { recursive: true, force: true });
    update({ language: "ja" }, { ...other, config: join(folder, "config.json") });
    expect(await json(where.config)).toEqual({ theme: "animal_style", language: "ja" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a save that cannot open the shared lock leaves preferences unchanged and releases the viewer lock", async () => {
  const { root, where } = await scratch("preferences-lock-unavailable");
  try {
    update({ theme: "animal_style" }, where);
    const before = await Promise.all([readFile(where.viewer, "utf8"), readFile(where.config, "utf8")]);
    const blocked = join(root, "blocked");
    await writeFile(blocked, "not a directory");
    await withEnv({ XDG_RUNTIME_DIR: blocked }, () => {
      expect(() => update({ language: "ja" }, where)).toThrow();
    });
    expect(await Promise.all([readFile(where.viewer, "utf8"), readFile(where.config, "utf8")])).toEqual(before);
    update({ language: "ja" }, where);
    expect(await json(where.config)).toEqual({ theme: "animal_style", language: "ja" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty or broken config.json moves nothing until it's repaired", async () => {
  const { root, where } = await scratch("preferences-empty-config");
  try {
    const old = { onboarding_complete: true, preset: "tmux", keys: { new: "prefix+y" } };
    await put(where.viewer, old);
    await put(where.config, "");
    migrate(where);
    expect(await json(where.viewer)).toEqual(old);
    rmSync(where.config);
    migrate(where);
    expect(await json(where.config)).toEqual({ preset: "tmux", keys: { new: "prefix+y" } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("where shortcuts clash, the first in the file that works wins", async () => {
  const { root, where } = await scratch("preferences-clash");
  const named = () => inspect(where).problems.map(p => p.text.slice(0, p.text.indexOf(":")));
  try {
    // new and close both want the key tab gives up.
    await put(where.config, { keys: { new: "prefix+1", tab: [], close: "prefix+1" } });
    expect(read(where).keys).toEqual({ new: "prefix+1", tab: [] });
    expect(named()).toEqual(["keys.close"]);
    // Two spellings of one action: the first stays, even when the second can't be used.
    await put(where.config, { keys: { worktrees: "alt+w", "worktrees:0": "ctrl+b" } });
    expect(read(where).keys).toEqual({ worktrees: "alt+w" });
    expect(inspect(where).problems.map(p => p.text)).toEqual([
      expect.stringMatching(/^keys\.worktrees:0: worktrees already sets/),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.if(process.platform === "darwin")("key sets that trade keys stay together when another is skipped", async () => {
  const { root, where } = await scratch("preferences-trade");
  try {
    // cmux selects tabs with Ctrl and workspaces with Cmd; each set needs the other's keys.
    await put(where.config, {
      preset: "cmux",
      keys: { tab: "cmd+1..9", "goto-workspace": "ctrl+1..9", close: "ctrl+b" },
    });
    expect(read(where).keys).toEqual({ tab: "cmd+1..9", "goto-workspace": "ctrl+1..9" });
    expect(inspect(where).problems.map(p => p.text.slice(0, p.text.indexOf(":")))).toEqual(["keys.close"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a read-only config.json stays as it is, and a writable one keeps its mode", async () => {
  const { root, where } = await scratch("preferences-mode");
  try {
    await put(where.config, { theme: "corgi" });
    chmodSync(where.config, 0o444);
    expect(() => update({ theme: "animal_style" }, where)).toThrow("read-only");
    expect(await json(where.config)).toEqual({ theme: "corgi" });
    chmodSync(where.config, 0o640);
    update({ theme: "animal_style" }, where);
    expect(await json(where.config)).toEqual({ theme: "animal_style" });
    expect(statSync(where.config).mode & 0o777).toBe(0o640);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("choosing the default replaces a value Corgi skips, and keeps fields it doesn't know", async () => {
  const { root, where } = await scratch("preferences-clear");
  try {
    await put(where.config, { theme: 5, resources: { enabled: true, newer: 1 } });
    update({ theme: undefined }, where);
    update({ resources: { enabled: false } }, where);
    expect(await json(where.config)).toEqual({ resources: { enabled: false, newer: 1 } });
    expect(inspect(where).problems).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("viewer.json stays small enough for either release to read", async () => {
  const { root, where } = await scratch("preferences-size");
  try {
    // Indented, this order alone passes 64 KiB.
    const order = Array.from({ length: 3000 }, (_, i) => `w${String(i).padStart(14, "0")}`);
    await put(where.viewer, { onboarding_complete: true, workspace_order: order });
    migrate(where);
    expect(statSync(where.viewer).size).toBeLessThanOrEqual(64 * 1024);
    expect(read(where).workspace_order).toEqual(order);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saving a config.json linked from dotfiles replaces its target and keeps the link", async () => {
  const { root, where } = await scratch("preferences-link");
  try {
    const dotfiles = join(root, "dotfiles", "corgi.json");
    await put(dotfiles, { preset: "tmux" });
    await mkdir(dirname(where.config), { recursive: true });
    symlinkSync(dotfiles, where.config);
    update({ theme: "animal_style" }, where);
    expect(lstatSync(where.config).isSymbolicLink()).toBe(true);
    expect(await json(dotfiles)).toEqual({ preset: "tmux", theme: "animal_style" });
    // A link made before its target exists, as a fresh dotfiles checkout may.
    rmSync(where.config);
    const fresh = join(root, "dotfiles", "fresh", "corgi.json");
    symlinkSync(fresh, where.config);
    update({ theme: "corgi" }, where);
    expect(lstatSync(where.config).isSymbolicLink()).toBe(true);
    expect(await json(fresh)).toEqual({ theme: "corgi" });
    // Through a chain of links, each stays one.
    rmSync(where.config);
    const middle = join(root, "dotfiles", "middle.json"),
      last = join(root, "checkout", "config.json");
    symlinkSync(last, middle);
    symlinkSync(middle, where.config);
    update({ theme: "animal_style" }, where);
    expect([lstatSync(where.config).isSymbolicLink(), lstatSync(middle).isSymbolicLink()]).toEqual([true, true]);
    expect(await json(last)).toEqual({ theme: "animal_style" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "relative config links inside linked folders reach their target (existing: %s)",
  async existing => {
    const { root, where } = await scratch("preferences-linked-parent");
    try {
      const real = join(root, "real"),
        nested = join(real, "nested"),
        alias = join(root, "alias"),
        destination = join(real, "settings.json");
      await mkdir(nested, { recursive: true });
      symlinkSync(nested, alias, "dir");
      symlinkSync("../settings.json", join(nested, "config.json"));
      if (existing) await put(destination, { theme: "corgi" });
      where.config = join(alias, "config.json");
      update({ theme: "animal_style" }, where);
      expect(await json(destination)).toEqual({ theme: "animal_style" });
      expect(read(where).theme).toBe("animal_style");
      expect(existsSync(join(root, "settings.json"))).toBe(false);
      expect(lstatSync(where.config).isSymbolicLink()).toBe(true);
      expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
