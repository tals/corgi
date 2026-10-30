/** Agent-matrix receipts; every /proc and pane read is outside CPU windows. */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

export type Workload = "all" | "idle" | "busy";
export function workload(value: string | undefined): Workload {
  switch (value ?? "all") {
    case "all":
      return "all";
    case "idle":
      return "idle";
    case "busy":
      return "busy";
    default:
      throw Error("Unknown agent matrix workload");
  }
}
export function providers(home: string, count: number) {
  const pids = readdirSync(home).flatMap(name => {
    const match = /^ordinary-(claude|codex)-(\d+)\.jsonl$/.exec(name);
    if (!match) return [];
    const pid = Number(match[2]);
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      return args.includes(`${home}/bin/${match[1]}`) ? [pid] : [];
    } catch {
      return [];
    }
  });
  if (pids.length !== count || new Set(pids).size !== count)
    throw Error(`Expected ${count} live isolated providers, found ${pids.length}`);
  return pids.sort((a, b) => a - b);
}
export function counters(pids: number[]) {
  return pids.map(pid => {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8"),
      fields = stat.slice(stat.lastIndexOf(")") + 2).split(" "),
      io = Object.fromEntries(
        readFileSync(`/proc/${pid}/io`, "utf8")
          .trim()
          .split("\n")
          .map(line => line.split(":").map(field => field.trim())),
      );
    if (!/^\d+$/.test(io.wchar ?? "") || !/^\d+$/.test(io.syscw ?? "")) throw Error("Missing provider I/O counters");
    return { pid, start_ticks: fields[19], wchar: io.wchar, syscw: io.syscw };
  });
}
export function idle(
  before: ReturnType<typeof counters>,
  after: ReturnType<typeof counters>,
  screensBefore: string[],
  screensAfter: string[],
) {
  const quiet =
    before.length > 0 &&
    before.length === after.length &&
    before.every((a, i) => {
      const b = after[i];
      return a.pid === b.pid && a.start_ticks === b.start_ticks && a.wchar === b.wchar && a.syscw === b.syscw;
    });
  const prompts =
    screensBefore.length === before.length &&
    screensAfter.length === before.length &&
    screensBefore.every((text, i) => text.trim() === "›" && text === screensAfter[i]);
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  return {
    valid: quiet && prompts,
    providers: before.length,
    no_provider_writes: quiet,
    stable_prompts: prompts,
    outside_cpu_window: true,
    before,
    after,
    screen_sha256_before: screensBefore.map(hash),
    screen_sha256_after: screensAfter.map(hash),
  };
}
export function validate(value: ReturnType<typeof idle>) {
  if (!value.valid) throw Error("Idle providers wrote bytes, changed identity, or lost their stable prompt");
}
