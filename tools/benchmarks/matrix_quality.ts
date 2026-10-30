/** Agent-matrix receipts; every /proc and pane read is outside CPU windows. */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

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
interface TerminalIo {
  schema: "terminal-io-v1";
  pid: number;
  at_ns: string;
  stdout_bytes: number;
  stdout_writes: number;
  stderr_bytes: number;
  stderr_writes: number;
}
const terminalFields = ["stdout_bytes", "stdout_writes", "stderr_bytes", "stderr_writes"] as const;
function receipt(value: unknown, pid: number): TerminalIo {
  if (!value || typeof value !== "object") throw Error("Invalid terminal I/O receipt");
  const row = value as Record<string, unknown>;
  if (
    row.schema !== "terminal-io-v1" ||
    row.pid !== pid ||
    typeof row.at_ns !== "string" ||
    !/^\d+$/.test(row.at_ns) ||
    terminalFields.some(key => typeof row[key] !== "number" || !Number.isSafeInteger(row[key]) || row[key] < 0)
  )
    throw Error("Invalid terminal I/O receipt");
  return row as unknown as TerminalIo;
}
async function terminalCounters(home: string, pid: number) {
  const path = join(home, `terminal-io-${pid}.json`);
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  process.kill(pid, "SIGUSR2");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      return receipt(JSON.parse(readFileSync(path, "utf8")), pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await Bun.sleep(5);
  }
  throw Error(`No terminal I/O receipt for provider ${pid}`);
}
export async function counters(home: string, pids: number[]) {
  const identities = pids.map(pid => {
    const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"),
      provider = ["claude", "codex"].find(name => args.includes(join(home, "bin", name))),
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    if (!provider) throw Error(`Not an isolated provider: ${pid}`);
    return { provider, start_ticks: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] };
  });
  const terminal = await Promise.all(pids.map(pid => terminalCounters(home, pid)));
  return pids.map((pid, i) => {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8"),
      fields = stat.slice(stat.lastIndexOf(")") + 2).split(" "),
      io = Object.fromEntries(
        readFileSync(`/proc/${pid}/io`, "utf8")
          .trim()
          .split("\n")
          .map(line => line.split(":").map(field => field.trim())),
      );
    if (!/^\d+$/.test(io.wchar ?? "") || !/^\d+$/.test(io.syscw ?? "")) throw Error("Missing provider I/O counters");
    const { provider, start_ticks } = identities[i];
    if (fields[19] !== start_ticks) throw Error(`Provider identity changed: ${pid}`);
    const path = join(home, `ordinary-${provider}-${pid}.jsonl`),
      info = statSync(path, { bigint: true }),
      transcript = {
        path,
        dev: String(info.dev),
        ino: String(info.ino),
        size: String(info.size),
        mtime_ns: String(info.mtimeNs),
        ctime_ns: String(info.ctimeNs),
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      };
    return { pid, start_ticks: fields[19], wchar: io.wchar, syscw: io.syscw, terminal: terminal[i], transcript };
  });
}
export function idle(
  before: Awaited<ReturnType<typeof counters>>,
  after: Awaited<ReturnType<typeof counters>>,
  screensBefore: string[],
  screensAfter: string[],
) {
  const identity =
    before.length > 0 &&
    before.length === after.length &&
    before.every(
      (a, i) =>
        a.pid === after[i].pid &&
        a.start_ticks === after[i].start_ticks &&
        BigInt(after[i].terminal.at_ns) > BigInt(a.terminal.at_ns),
    );
  const quiet =
      identity && before.every((a, i) => terminalFields.every(key => a.terminal[key] === after[i].terminal[key])),
    transcripts =
      identity && before.every((a, i) => JSON.stringify(a.transcript) === JSON.stringify(after[i].transcript)),
    allFdQuiet = identity && before.every((a, i) => a.wchar === after[i].wchar && a.syscw === after[i].syscw);
  const prompts =
    screensBefore.length === before.length &&
    screensAfter.length === before.length &&
    screensBefore.every((text, i) => text.trim() === "›" && text === screensAfter[i]);
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  return {
    schema: "idle-terminal-v2",
    valid: quiet && transcripts && prompts,
    providers: before.length,
    process_identity: identity,
    no_terminal_writes: quiet,
    unchanged_transcripts: transcripts,
    all_fd_io_unchanged: allFdQuiet,
    all_fd_scope: "diagnostic only; includes out-of-window terminal-counter receipt writes",
    stable_prompts: prompts,
    outside_cpu_window: true,
    before,
    after,
    screen_sha256_before: screensBefore.map(hash),
    screen_sha256_after: screensAfter.map(hash),
  };
}
export function validate(value: ReturnType<typeof idle>) {
  if (!value.valid)
    throw Error("Idle providers wrote terminal bytes, changed transcripts or identity, or lost their stable prompt");
}
