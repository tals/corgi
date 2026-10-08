import { milliTimestamp } from "../clock";
import { Quit, run as subprocessRun } from "../subprocess";
import { clean } from "./git_status";
import type { Store } from "../workspace";
import type { Tracker } from "./git_status";
export const preview_changed =
  "Branch, commits, or upstream changed. Review the refreshed preview and retry.";
export type Phase = "idle" | "pushing" | "succeeded" | "failed";
export type View = { phase: Phase; message: string };
export class State {
  phase: Phase = "idle";
  operation = 0n;
  message = "";
  until = 0;
  view(): View {
    return { phase: this.phase, message: this.message };
  }
}
export class RefView {
  root = "";
  head = "";
  branch = "";
  remote = "";
  destination = "";
  constructor(fields: Partial<RefView> = {}) {
    Object.assign(this, fields);
  }
  sameBranch(other: RefView) {
    return ["root", "branch", "remote", "destination"].every(
      (k) => this[k] === other[k],
    );
  }
  eql(other: RefView) {
    return this.sameBranch(other) && this.head === other.head;
  }
  [key: string]: any;
}
export class Ref extends RefView {
  static init(
    root: string,
    head: string,
    branch: string,
    remote: string,
    destination: string,
  ) {
    if (
      [root, head, branch, remote, destination].some(
        (s, i) => Buffer.byteLength(s) > [4096, 64, 1024, 1024, 1024][i],
      )
    )
      return new Ref();
    return new Ref({ root, head, branch, remote, destination });
  }
  view() {
    return new RefView({
      root: this.root,
      head: this.head,
      branch: this.branch,
      remote: this.remote,
      destination: this.destination,
    });
  }
}
export class Manager {
  jobs: ({
    id: bigint;
    ref: Ref;
    done: boolean;
    result: State;
    quit: Quit;
  } | null)[] = Array(32).fill(null);
  next_id = 1n;
  busy() {
    return this.jobs.some(Boolean);
  }
  deinit() {
    for (const job of this.jobs) job?.quit.signal();
    this.jobs.fill(null);
  }
  async start(
    store: Store | { workspaces: Store },
    id: number,
    expected: RefView,
  ) {
    const s = "workspaces" in store ? store.workspaces : store,
      ws = s.get(id);
    if (!ws) throw Error("NoWorkspace");
    const ref = ws.git_ref.view(),
      wanted = new RefView(expected);
    if (!ref.eql(wanted)) throw Error("GitPreviewChanged");
    if (!ref.head || !ref.branch || !ws.git_ahead) throw Error("NothingToPush");
    for (const job of this.jobs)
      if (job && job.ref.root === ref.root) {
        if (!job.ref.view().eql(ref)) throw Error("GitPushInProgress");
        for (const w of s.items)
          if (w.git_ref.root === ref.root)
            w.git_push = Object.assign(new State(), {
              phase: "pushing",
              operation: job.id,
            });
        return;
      }
    const slot = this.jobs.indexOf(null);
    if (slot < 0) throw Error("TooManyPushes");
    const job = {
      id: this.next_id++,
      ref: new Ref(ref),
      done: false,
      result: new State(),
      quit: Quit.init(),
    };
    this.jobs[slot] = job;
    for (const w of s.items)
      if (w.git_ref.root === ref.root)
        w.git_push = Object.assign(new State(), {
          phase: "pushing",
          operation: job.id,
        });
    void this.push(job)
      .then(() => {
        job.result.phase = "succeeded";
      })
      .catch((e) => {
        job.result.phase = "failed";
        if (!job.result.message)
          job.result.message = clean(
            (e as Error).message === "GitPreviewChanged"
              ? preview_changed
              : (e as Error).message === "NoPushDestination"
                ? "No remote tracking branch. Configure an upstream in your terminal, then retry."
                : (e as Error).message === "TimedOut"
                  ? "Push timed out. Check authentication and the remote in your terminal, then retry."
                  : (e as Error).message,
            2048,
          );
      })
      .finally(() => {
        job.done = true;
      });
  }
  tick(store: Store, tracker: Tracker) {
    let changed = false;
    const now = milliTimestamp();
    this.jobs.forEach((job, i) => {
      if (!job?.done) return;
      for (const w of store.items)
        if (w.git_push.operation === job.id) {
          w.git_push = Object.assign(new State(), job.result, {
            until: now + 1600,
          });
        }
      this.jobs[i] = null;
      tracker.next_refresh = 0;
      changed = true;
    });
    for (const w of store.items)
      if (w.git_push.phase === "succeeded" && now >= w.git_push.until) {
        w.git_push = new State();
        changed = true;
      }
    return changed;
  }
  async push(job: NonNullable<Manager["jobs"][number]>) {
    const ref = job.ref.view(),
      head = await this.command(job, ["rev-parse", "--verify", "HEAD"]),
      branch = await this.command(job, ["symbolic-ref", "--quiet", "HEAD"]);
    if (head !== ref.head || branch !== ref.branch)
      throw Error("GitPreviewChanged");
    if (!branch.startsWith("refs/heads/")) throw Error("NoPushDestination");
    let remote: string, destination: string;
    try {
      remote = await this.command(job, [
        "config",
        "--get",
        `branch.${branch.slice(11)}.remote`,
      ]);
      destination = await this.command(job, [
        "config",
        "--get",
        `branch.${branch.slice(11)}.merge`,
      ]);
    } catch {
      throw Error("NoPushDestination");
    }
    if (remote !== ref.remote || destination !== ref.destination)
      throw Error("GitPreviewChanged");
    if (!remote || !destination.startsWith("refs/heads/"))
      throw Error("NoPushDestination");
    await this.command(
      job,
      [
        "-c",
        `remote.${remote}.mirror=false`,
        "push",
        "--porcelain",
        "--no-force",
        "--no-mirror",
        "--no-follow-tags",
        "--recurse-submodules=no",
        "--",
        remote,
        `${ref.head}:${destination}`,
      ],
      true,
    );
  }
  async command(
    job: NonNullable<Manager["jobs"][number]>,
    args: string[],
    pushing = false,
  ) {
    const out = await subprocessRun(
      [
        "git",
        "-c",
        "core.askPass=",
        "-c",
        "credential.interactive=false",
        "-C",
        job.ref.root,
        ...args,
      ],
      {
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "Never",
        },
        timeout_ms: pushing ? 120000 : 5000,
        max_output: 16384,
        stderr: true,
        quit: job.quit,
      },
    );
    if (!out.ok()) {
      if (pushing)
        job.result.message = clean(
          (out.stderr.length ? out.stderr : out.stdout).toString().trim(),
          2048,
        );
      throw Error("GitPushFailed");
    }
    return out.stdout.toString().trim();
  }
}

export async function start(
  runtime: { workspaces: Store; git_push: Manager },
  workspace: number,
  ref: RefView,
) {
  await runtime.git_push.start(runtime.workspaces, workspace, new RefView(ref));
}
