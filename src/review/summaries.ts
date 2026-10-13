//! The agent menu's "N files +a −d" line for each checkout, read ahead of the
//! menu so it opens with the numbers in place. A checkout's line is kept until
//! something says it changed: a turn starting or ending in it, or age.
import * as dropdown from "../dropdown";
import * as git from "./git";
import { summary } from "./panel";

/** A line older than this is read again the next time it is wanted. */
export const fresh_ms = 15_000;
/** A checkout that took longer than this to read is read only when its menu asks. */
export const slow_ms = 1_000;

interface Line {
  runs: dropdown.Run[];
  at: number;
  stale: boolean;
}
interface Job {
  cwd: string;
  /** Asked for by an open menu: read even when fresh or slow. */
  asked: boolean;
}

export class Summaries {
  /** Called when a checkout's line changes. */
  changed: () => void = () => {};
  /** Each directory's checkout, or null outside git. */
  private roots = new Map<string, string | null>();
  private lines = new Map<string, Line>();
  private slow = new Set<string>();
  private queue: Job[] = [];
  private running: string | null = null;

  constructor(
    private read: (root: string) => Promise<dropdown.Run[]> = summary,
    private toplevel: (cwd: string) => Promise<string | null> = git.toplevel,
    private now: () => number = Date.now,
  ) {}

  /** The line for `cwd`'s checkout, if one was read. */
  get(cwd: string): dropdown.Run[] | null {
    const key = this.key(cwd);
    return key === null ? null : (this.lines.get(key)?.runs ?? null);
  }
  /** Reads `cwd`'s line in the background unless what's kept is still good. */
  want(cwd: string): void {
    const key = this.key(cwd);
    if (key !== null && (this.slow.has(key) || this.good(key))) return;
    this.enqueue({ cwd, asked: false });
  }
  /** Reads `cwd`'s line now, ahead of anything wanted; a menu shows it. */
  ask(cwd: string): void {
    this.enqueue({ cwd, asked: true });
  }
  /** Marks `cwd`'s line as needing another read. */
  invalidate(cwd: string): void {
    const key = this.key(cwd);
    const line = key === null ? undefined : this.lines.get(key);
    if (line) line.stale = true;
  }
  /** Keeps a line read elsewhere, such as by the review panel. */
  put(root: string, runs: dropdown.Run[]): void {
    this.keep(root, runs);
  }

  private key(cwd: string): string | null {
    const root = this.roots.get(cwd);
    return root === undefined ? null : (root ?? cwd);
  }
  private good(key: string): boolean {
    const line = this.lines.get(key);
    return !!line && !line.stale && this.now() - line.at < fresh_ms;
  }
  private enqueue(job: Job): void {
    const queued = this.queue.findIndex(j => j.cwd === job.cwd);
    if (queued >= 0) {
      if (!job.asked) return;
      this.queue.splice(queued, 1);
    } else if (!job.asked && this.running === job.cwd) return;
    if (job.asked) this.queue.unshift(job);
    else this.queue.push(job);
    void this.drain();
  }
  /** Reads one checkout at a time, so a burst of wants never starts many gits at once. */
  private async drain(): Promise<void> {
    if (this.running !== null) return;
    for (let job = this.queue.shift(); job; job = this.queue.shift()) {
      this.running = job.cwd;
      try {
        await this.run(job);
      } catch {}
      this.running = null;
    }
  }
  private async run(job: Job): Promise<void> {
    let root = this.roots.get(job.cwd);
    if (root === undefined) {
      root = await this.toplevel(job.cwd).catch(() => null);
      this.roots.set(job.cwd, root);
    }
    const key = root ?? job.cwd;
    // Another directory in the same checkout may have read it meanwhile.
    if (!job.asked && (this.slow.has(key) || this.good(key))) return;
    if (root === null) return this.keep(key, [["Not in a git checkout", "faint"]]);
    const start = this.now();
    const runs = await this.read(root);
    if (this.now() - start > slow_ms) this.slow.add(root);
    else this.slow.delete(root);
    this.keep(root, runs);
  }
  private keep(key: string, runs: dropdown.Run[]): void {
    const old = this.lines.get(key);
    this.lines.set(key, { runs, at: this.now(), stale: false });
    if (!old || !dropdown.sameRuns(old.runs, runs)) this.changed();
  }
}
