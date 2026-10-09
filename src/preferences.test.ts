import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    await write(file, p);
    await updateFile(file, { agents: "all" });
    expect(await read(file)).toMatchObject({
      agents: "all",
      sidebar_width: 44,
    });
    await writeFile(file, '{"resources":{"enabled":false,"io":false,"alerts":true}}');
    expect((await read(file)).resources).toEqual({ enabled: false });
    await writeFile(file, '{"preset":"cmux","onboarding_complete":true}');
    expect((await read(file)).preset).toBe(process.platform === "darwin" ? "cmux" : "corgi");
    await writeFile(file, '{"theme":"tokyo_night","sleeping_corgis":false}');
    expect(await read(file)).toMatchObject({ theme: "tokyo_night", sleeping_corgis: false });
    // A theme this build doesn't know keeps the rest of the file.
    await writeFile(file, '{"theme":"solarized","sleeping_corgis":false}');
    expect(await read(file)).toMatchObject({ theme: "corgi", sleeping_corgis: false });
    await writeFile(file, '{"theme":3}');
    expect(await read(file)).toEqual(new Preferences());
    await writeFile(file, "{broken");
    expect(await read(file)).toEqual(new Preferences());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
