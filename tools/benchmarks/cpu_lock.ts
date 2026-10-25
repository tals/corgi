/** One Linux benchmark at a time; child harnesses inherit their live owner's marker. */
import { readFileSync } from "node:fs";

const marker = "CORGI_CPU_BENCHMARK_LOCK";
function identity(pid: number) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/)[19];
}
export async function acquire(): Promise<() => Promise<void>> {
  if (process.platform !== "linux") throw Error("CPU benchmarks require Linux");
  const inherited = process.env[marker];
  if (inherited) {
    const match = /^(\d+):(\d+)$/.exec(inherited);
    if (!match || identity(Number(match[1])) !== match[2]) throw Error("Stale benchmark lock owner");
    return async () => {};
  }
  const file = `/tmp/corgi-cpu-benchmark-${process.getuid!()}.lock`;
  // The pipe lifetime owns the lock. setsid prevents Ctrl-C from unlocking early.
  const lock = Bun.spawn(
    [
      "setsid",
      "flock",
      "--exclusive",
      "--nonblock",
      "--conflict-exit-code",
      "75",
      file,
      "sh",
      "-c",
      "printf 'locked\\n'; cat >/dev/null",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  );
  const reader = lock.stdout.getReader();
  let response = "";
  try {
    while (!response.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      response += new TextDecoder().decode(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (response !== "locked\n") {
    lock.stdin.end();
    throw Error(`Another CPU benchmark holds ${file} (exit ${await lock.exited})`);
  }
  process.env[marker] = `${process.pid}:${identity(process.pid)}`;
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    delete process.env[marker];
    lock.stdin.end();
    await lock.exited;
  };
}
