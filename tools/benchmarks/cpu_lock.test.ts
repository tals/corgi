import { test, expect } from "bun:test";
import { acquire } from "./cpu_lock";

// Run outside timed benchmarks: this test deliberately takes the shared lock.
test("benchmark owners exclude independent runs while allowing inherited harnesses", async () => {
  const release = await acquire(),
    source = `import { acquire } from ${JSON.stringify(import.meta.dir + "/cpu_lock.ts")}; await (await acquire())();`,
    run = async (env: NodeJS.ProcessEnv) => {
      const child = Bun.spawn([process.execPath, "-e", source], { env, stdout: "ignore", stderr: "pipe" });
      return { code: await child.exited, error: await new Response(child.stderr).text() };
    };
  try {
    expect((await run({ ...process.env })).code).toBe(0);
    const independent = { ...process.env };
    delete independent.CORGI_CPU_BENCHMARK_LOCK;
    const rejected = await run(independent);
    expect(rejected.code).not.toBe(0);
    expect(rejected.error).toContain("Another CPU benchmark holds");
    const stale = await run({ ...process.env, CORGI_CPU_BENCHMARK_LOCK: `${process.pid}:0` });
    expect(stale.code).not.toBe(0);
    expect(stale.error).toContain("Stale benchmark lock owner");
  } finally {
    await release();
  }
  await (
    await acquire()
  )();
});
