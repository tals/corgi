import path from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { Agent, Provider, Text, type State } from "./agents";
import { n, ptr, processArgs } from "./native_bridge";
import { processJob, processTree, processArgs as readProcessArgs } from "./os";
export type Job = { pid: number; provider: Provider };
export const process_buffer = 1024 * 1024;
function name(p: string): Provider | null {
  return (
    Provider.named(path.basename(p)) ??
    Provider.all.find((k) =>
      Provider.info(k).install_markers.some((m: string) => p.includes(m)),
    ) ??
    null
  );
}
export function identify(argv: string[]): Provider | null {
  if (!argv.length) return null;
  const direct = name(argv[0]);
  if (direct) return direct;
  const exe = path.basename(argv[0]);
  if (
    (!["node", "bun", "sh", "bash", "zsh"].includes(exe) &&
      !/^python/i.test(exe)) ||
    argv.length < 2
  )
    return null;
  let i = 1;
  if (exe === "bun" && argv[i] === "run") i++;
  while (i < argv.length && argv[i].startsWith("-")) {
    const flag = argv[i++];
    if (flag === "--") break;
    if (
      !(exe === "bun" && ["--bun", "-b"].includes(flag)) &&
      !["-u", "--no-warnings"].includes(flag)
    )
      return null;
  }
  if (exe === "bun" && argv[i] === "run") i++;
  if (i >= argv.length) return null;
  return (
    name(argv[i]) ??
    Provider.all.find((k) =>
      Provider.info(k).scripts.some((s: string) => argv[i].endsWith(s)),
    ) ??
    null
  );
}
export function claudeProcess(info: { exe: string; argv: string[] }) {
  return (
    name(info.exe) === "claude" ||
    identify(info.argv) === "claude" ||
    (!!info.argv.length && name(info.argv[0].split(" ")[0]) === "claude")
  );
}
export function backgroundJob(pid: number) {
  const info = processJob(pid);
  return !!info && (info.tpgid <= 0 || info.pgid !== info.tpgid);
}
function readClaudeProcess(pid: number) {
  const info = readProcessArgs(pid, process_buffer, { env: true });
  return !!info?.complete && claudeProcess({ exe: info.exe, argv: info.argv });
}
export function claudeRunning(pid: number, _buffer?: Uint8Array) {
  return pid > 1 && readClaudeProcess(pid);
}
function backgroundSession(pid: number) {
  return (
    readProcessArgs(pid, process_buffer, { env: true })
      ?.environ()
      .includes("CLAUDE_CODE_SESSION_KIND=bg") ?? false
  );
}
export function hookOrigin() {
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid > 1; i++) {
    const job = processJob(pid);
    if (readClaudeProcess(pid)) {
      return {
        pid,
        background:
          backgroundSession(pid) ||
          (!!job && (job.tpgid <= 0 || job.pgid !== job.tpgid)),
      };
    }
    if (!job) break;
    pid = job.ppid;
  }
  return { pid: 0, background: false };
}
function tail(screen: string) {
  return screen
    .trimEnd()
    .split("\n")
    .slice(-8)
    .join("\n")
    .slice(0, 8192)
    .toLowerCase();
}
export function screenState(
  provider: Provider,
  title: string,
  screen: string,
): State | null {
  const s = Provider.info(provider).screen,
    text = tail(screen);
  if (s.blocked_title && title.includes(s.blocked_title)) return "blocked";
  if (
    (text.includes("enter to confirm") && text.includes("esc to cancel")) ||
    text.includes("enter to submit answer") ||
    text.includes("enter to submit all")
  )
    return "blocked";
  if (text.includes("esc to interrupt")) return "working";
  if (s.idle_title && title.startsWith(s.idle_title)) return "idle";
  if (
    s.idle_prompt &&
    text.split("\n").some((r) => r.trimStart().startsWith(s.idle_prompt))
  )
    return "idle";
  return null;
}
export function screenCompacting(screen: string): boolean | null {
  for (const row of screen.trimEnd().split("\n").slice(-8).reverse()) {
    const hint = row.indexOf("esc to interrupt");
    if (hint < 0) continue;
    return /^(?:[•◦·] )?Compacting (?:context|conversation) /.test(
      row.slice(0, hint).trimStart(),
    );
  }
  return null;
}
export function screenToolActive(provider: Provider, screen: string) {
  if (!Provider.info(provider).screen.background_status) return false;
  for (const row of screen.trimEnd().split("\n").slice(-8).reverse()) {
    const hint = row.indexOf("esc to interrupt)");
    if (hint < 0) continue;
    if (row.slice(0, hint).includes("Waiting for background terminal"))
      return true;
    const m = row
      .slice(hint + 17)
      .trim()
      .match(/^· (\d+) (.+)$/);
    if (!m || Number(m[1]) === 0) continue;
    if (
      m[2].startsWith("background terminal") ||
      (m[2].endsWith("…") &&
        m[2].length >= 13 &&
        "background terminals running".startsWith(m[2].slice(0, -1)))
    )
      return true;
  }
  return false;
}
export function claudeComposer(screen: string) {
  let after = false,
    input = false,
    found = false;
  for (const row of screen.split("\n")) {
    if (/^─{10,}$/.test(row.trim())) {
      if (input) found = true;
      input = false;
      after = true;
      continue;
    }
    if (after) input = row.trimStart().startsWith("❯");
    after = false;
  }
  if (!found) return "covered";
  if (
    /esc to cancel|enter to select|enter to confirm|enter to submit/.test(
      tail(screen),
    )
  )
    return "unknown";
  return "open";
}
export const Composer = {
  open: "open",
  covered: "covered",
  unknown: "unknown",
} as const;
export class PromptWatch {
  seen = false;
  covered = 0;
  open = 0;
  answered(blocked: boolean, screen: string): State | null {
    if (!blocked) {
      Object.assign(this, new PromptWatch());
      return null;
    }
    switch (claudeComposer(screen)) {
      case "covered":
        this.covered = Math.min(255, this.covered + 1);
        this.open = 0;
        if (this.covered >= 2) this.seen = true;
        return null;
      case "unknown":
        this.covered = 0;
        this.open = 0;
        return null;
      case "open":
        this.covered = 0;
        if (!this.seen) return null;
        this.open = Math.min(255, this.open + 1);
        if (this.open < 2) return null;
        Object.assign(this, new PromptWatch());
        return screenState("claude", "", screen) === "working"
          ? "working"
          : "idle";
    }
    return null;
  }
}
export function interruptKey(bytes: string | Uint8Array) {
  const s = typeof bytes === "string" ? bytes : Buffer.from(bytes).toString();
  return (
    s === "\x1b" ||
    s.includes("\x03") ||
    /\x1b\[(?:27|99;5)(?:[;:][\d;:]*|)u/.test(s)
  );
}
export class Tracker {
  pid = 0;
  missing = 0;
  candidate: State | null = null;
  confirmations = 0;
  ready = false;
  idle_since = 0;
  interrupt_key_at = 0;
  observeInput(bytes: string | Uint8Array, now: number) {
    if (interruptKey(bytes)) this.interrupt_key_at = now;
  }
  interrupted(title: string, screen: string, now: number) {
    if (screenState("claude", title, screen) !== "idle") {
      this.idle_since = 0;
      return false;
    }
    if (!this.idle_since) this.idle_since = now;
    if (
      this.interrupt_key_at &&
      now - this.interrupt_key_at <= 5000000 &&
      now - Math.max(this.idle_since, this.interrupt_key_at) >= 250000
    )
      return true;
    return now - this.idle_since >= 1500000;
  }
  update(
    agent: Agent,
    job: Job | null,
    title: string,
    screen: string,
    watched: boolean,
  ) {
    if (!job) {
      if (this.pid && ++this.missing >= 2) {
        agent.reset();
        Object.assign(this, new Tracker());
      }
      return false;
    }
    this.missing = 0;
    if (this.pid !== job.pid || agent.provider !== job.provider) {
      if (this.pid || agent.provider !== job.provider) agent.reset();
      this.pid = job.pid;
      this.candidate = null;
      this.confirmations = 0;
      this.ready = false;
      agent.provider = job.provider;
      if (!agent.last_seq) agent.state = "initializing";
    }
    if (agent.last_seq) return false;
    const next = screenState(job.provider, title, screen);
    if (!next || (next === "working" && !this.ready)) {
      this.candidate = null;
      this.confirmations = 0;
      return false;
    }
    if (this.candidate !== next) {
      this.candidate = next;
      this.confirmations = 0;
    }
    this.confirmations = Math.min(255, this.confirmations + 1);
    if (this.confirmations < (next === "idle" ? 3 : 2)) return false;
    agent.tool_active =
      next === "working" && screenToolActive(job.provider, screen);
    if (agent.state === next) return false;
    if (next === "idle") this.ready = true;
    agent.state = next;
    agent.changed_at = Date.now() * 1000;
    agent.activity = new Text();
    agent.observation.source = "screen";
    if (next === "working")
      agent.attention = agent.observation.unread() ? "finished" : "none";
    if (next === "blocked") {
      if (!watched) agent.attention = "needs_input";
      return true;
    }
    return false;
  }
}

export function foreground(fd: number): Job | null {
  const pgid = n.probe_foreground(fd);
  if (pgid <= 0) return null;
  const inspect = (pid: number) => {
    const info = processArgs(pid);
    return info.complete ? identify(info.argv) : null;
  };
  const leader = inspect(pgid);
  if (leader) return { pid: pgid, provider: leader };
  // The group's other members, found with getpgid rather than by reading
  // every process's /proc stat, as detection.zig does.
  const pids = new Int32Array(process.platform === "darwin" ? 128 : 4096);
  const count = n.probe_group_pids(pgid, ptr(pids), pids.length);
  for (let i = 0; i < Math.min(pids.length, count); i++) {
    const pid = pids[i];
    if (pid <= 0 || pid === pgid) continue;
    const provider = inspect(pid);
    if (provider) return { pid, provider };
  }
  return null;
}

/** A foreground group's members, found among the panes' own processes, or
 * with getpgid across the host where the kernel can't list children. */
function groupMembers(pgid: number, roots: number[]): number[] | null {
  const tree = processTree(roots);
  if (tree) return tree.filter((pid) => processJob(pid)?.pgid === pgid).sort((a, b) => a - b);
  const pids = new Int32Array(4096);
  const count = n.probe_group_pids(pgid, ptr(pids), pids.length);
  if (count < 0 || count === pids.length) return null;
  return [...pids.subarray(0, count)];
}

export function foregroundJobs(terminals: { fd: number; pid: number }[]) {
  const result = new Map<number, Job | null>();
  if (process.platform === "darwin") {
    for (const { fd } of terminals) result.set(fd, foreground(fd));
    return result;
  }
  const groups = new Map<number, number[]>();
  for (const { fd } of terminals) {
    const pgid = n.probe_foreground(fd);
    result.set(fd, null);
    if (pgid <= 0) continue;
    const argv = processArgs(pgid);
    const provider = argv.complete ? identify(argv.argv) : null;
    if (provider) {
      result.set(fd, { pid: pgid, provider });
      continue;
    }
    const members = groups.get(pgid) ?? [];
    members.push(fd);
    groups.set(pgid, members);
  }
  if (!groups.size) return result;
  for (const [pgid, fds] of [...groups]) {
    const roots = terminals.filter((t) => fds.includes(t.fd)).map((t) => t.pid);
    const members = groupMembers(pgid, roots);
    if (!members) continue;
    for (const pid of members) {
      if (pid <= 0 || pid === pgid) continue;
      const argv = processArgs(pid);
      const provider = argv.complete ? identify(argv.argv) : null;
      if (!provider) continue;
      for (const fd of fds) result.set(fd, { pid, provider });
      break;
    }
    groups.delete(pgid);
  }
  if (!groups.size) return result;
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry),
        job = processJob(pid);
      if (!job || pid === job.pgid || !groups.has(job.pgid)) continue;
      const argv = processArgs(pid),
        provider = argv.complete ? identify(argv.argv) : null;
      if (!provider) continue;
      for (const fd of groups.get(job.pgid)!) result.set(fd, { pid, provider });
      groups.delete(job.pgid);
      if (!groups.size) break;
    }
  } catch {}
  return result;
}
