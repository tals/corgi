//! Claude Code processes: whether one still runs, and which one sent a hook.
import { identify } from "../../detection";
import { processArgs, processJob } from "../../os";
import { owns } from "../common";
import { info as claude } from "./info";
const buffer = 1024 * 1024;
/** Whether `info` runs Claude Code, even as a process it retitled ("claude bg-spare"). */
export function claudeProcess(info: { exe: string; argv: string[] }) {
  return (
    owns(claude.programs, info.exe) ||
    identify(info.argv) === "claude" ||
    (!!info.argv.length && owns(claude.programs, info.argv[0].split(" ")[0]))
  );
}
function read(pid: number) {
  const info = processArgs(pid, buffer, { env: true });
  return !!info?.complete && claudeProcess({ exe: info.exe, argv: info.argv });
}
export function running(pid: number) {
  return pid > 1 && read(pid);
}
/** The Claude Code process a hook runs under, and whether it is a
 * background session rather than its pane's own. Its background daemon
 * inherits the environment of whichever pane first spawned it, and so does a
 * `claude -p` an agent runs from a tool. */
export function hookOrigin() {
  const origin = runningUnder();
  return { pid: origin.pid, background: process.env.CLAUDE_CODE_SESSION_KIND === "bg" || origin.background };
}
/** Clears the variables that tell Claude Code it runs inside another session. */
export function unnest(env: Record<string, string | undefined>) {
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
}
function runningUnder() {
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid > 1; i++) {
    const job = processJob(pid);
    if (read(pid)) {
      const daemon =
        processArgs(pid, buffer, { env: true })?.environ().includes("CLAUDE_CODE_SESSION_KIND=bg") ?? false;
      return { pid, background: daemon || (!!job && (job.tpgid <= 0 || job.pgid !== job.tpgid)) };
    }
    if (!job) break;
    pid = job.ppid;
  }
  return { pid: 0, background: false };
}
