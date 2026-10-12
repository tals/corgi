import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Preferences, read, write, updateFile } from "./preferences";
test("preferences round trip and fall back to defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "corgi-preferences-"));
  try {
    const file = join(root, "nested", "viewer.json");
    expect(await read(file)).toEqual(new Preferences());
    const p = new Preferences();
    p.agents = "all";
    await write(file, p);
    expect(await read(file)).toEqual(p);
    p.agents = "workspace";
    p.sidebar_width = 44;
    p.sidebar_split = 9;
    p.agent_scroll = { workspace: 2, offset: 7 };
    await write(file, p);
    await updateFile(file, { agents: "all" });
    expect(await read(file)).toMatchObject({
      agents: "all",
      sidebar_width: 44,
      sidebar_split: 9,
      agent_scroll: { workspace: 2, offset: 7 },
    });
    await writeFile(file, '{"resources":{"enabled":false,"io":false,"alerts":true}}');
    expect((await read(file)).resources).toEqual({ enabled: false });
    await writeFile(file, '{"preset":"cmux","onboarding_complete":true}');
    expect((await read(file)).preset).toBe(process.platform === "darwin" ? "cmux" : "corgi");
    await writeFile(file, '{"theme":"animal_style","sleeping_corgis":false}');
    expect(await read(file)).toMatchObject({ theme: "animal_style", corgi_intensity: 0 });
    // A theme this build doesn't know keeps the rest of the file.
    await writeFile(file, '{"theme":"solarized","sleeping_corgis":false}');
    expect(await read(file)).toMatchObject({ theme: "corgi", corgi_intensity: 0 });
    await writeFile(file, '{"agent_scroll":{"workspace":null,"offset":4}}');
    expect((await read(file)).agent_scroll).toEqual({ workspace: null, offset: 4 });
    await writeFile(file, '{"agent_scroll":{"workspace":2,"offset":-1}}');
    expect(await read(file)).toEqual(new Preferences());
    await writeFile(file, '{"theme":3}');
    expect(await read(file)).toEqual(new Preferences());
    await writeFile(file, "{broken");
    expect(await read(file)).toEqual(new Preferences());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corgi intensity migrates the old toggle without losing unrelated preferences", async () => {
  const root = await mkdtemp(join(tmpdir(), "corgi-intensity-"));
  const file = join(root, "viewer.json");
  try {
    const cases: [Record<string, unknown>, number][] = [
      [{}, 50],
      [{ sleeping_corgis: true }, 50],
      [{ sleeping_corgis: false }, 0],
      [{ sleeping_corgis: true, corgi_intensity: 0 }, 0],
      [{ sleeping_corgis: false, corgi_intensity: 75 }, 75],
      [{ corgi_intensity: 100 }, 100],
    ];
    for (const invalid of [-1, 101, 12.5, "20", null, {}, true]) {
      cases.push([{ corgi_intensity: invalid, sleeping_corgis: false }, 0]);
      cases.push([{ corgi_intensity: invalid }, 50]);
    }
    for (const [saved, intensity] of cases) {
      await writeFile(
        file,
        JSON.stringify({ theme: "animal_style", sidebar_width: 44, resources: { enabled: false }, ...saved }),
      );
      const migrated = read(file);
      expect(migrated).toMatchObject({
        corgi_intensity: intensity,
        theme: "animal_style",
        sidebar_width: 44,
        resources: { enabled: false },
      });
      expect(migrated).not.toHaveProperty("sleeping_corgis");
      updateFile(file, { agents: "all" });
      const written = JSON.parse(await readFile(file, "utf8"));
      expect(written).not.toHaveProperty("sleeping_corgis");
      expect(read(file)).toEqual({ ...migrated, agents: "all" });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
