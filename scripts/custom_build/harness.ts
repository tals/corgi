import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Harness } from "./config";
import * as git from "./git";
import { harnessArgs, streamParser, type Usage } from "./harness_stream";

export type Kind = "conflict" | "build";
export type Vars = Record<string, string | number | string[] | null>;

/** Fills `{{name}}` placeholders; lists become `- item` lines. */
export function fill(template: string, vars: Vars): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
    if (!(name in vars)) return whole;
    const value = vars[name];
    if (Array.isArray(value)) return value.length ? value.map(item => `- ${item}`).join("\n") : "- (none)";
    return value === null || value === "" ? "none" : String(value);
  });
}
/** A shipped prompt template, from the first of `dirs` that has it. */
export function template(name: string, dirs: string[]): string {
  for (const dir of dirs) {
    const path = join(dir, "prompts", `${name}.md`);
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  throw Error(`prompt template ${name}.md is missing`);
}

/** The harness executable, or null when it can't be run. */
export function executable(h: Harness, repo: string, env: Record<string, string | undefined>): string | null {
  const exe = h.command[0];
  if (!exe) return null;
  if (exe.includes("/")) {
    const path = isAbsolute(exe) ? exe : resolve(repo, exe);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      return null;
    }
  }
  return Bun.which(exe, { PATH: env.PATH ?? "" });
}

/** A finished call: its exit code (null when killed), the last line it
 * printed, the log holding its output, and its tokens. */
export type Call = { timedOut: boolean; code: number | null; tail: string; log: string; usage: Usage | null };
/** Runs the harness once on `text`: the prompt goes to a file named in the
 * command and to stdin. With a `kind`, its
 * stdout is a JSON stream: the log and the echo get the readable lines, the raw
 * stream goes to a `.jsonl` file beside the log, and the call's tokens come back. */
export async function invoke(
  h: Harness,
  kind: Kind,
  text: string,
  o: {
    repo: string;
    reportDir: string;
    number: number;
    env: Record<string, string | undefined>;
    echo?: (chunk: Uint8Array) => void;
    /** Each one-line activity the harness reports (only with a `kind`). */
    onActivity?: (line: string) => void;
  },
): Promise<Call> {
  const dir = join(o.reportDir, "prompts"),
    base = join(dir, `${String(o.number).padStart(2, "0")}-${kind}`),
    prompt = `${base}.md`,
    log = `${base}.log`,
    raw = `${base}.jsonl`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(prompt, text);
  const exe = executable(h, o.repo, o.env);
  if (!exe) throw Error(`harness ${h.command[0]} is not executable`);
  const cmd = harnessArgs(
    [exe, ...h.command.slice(1)].map(arg => arg.replaceAll("{prompt_file}", prompt)),
    h.kind,
  );
  // One parser per call: the codex parser remembers the items it has shown.
  const parser = h.kind ? streamParser(h.kind) : null;
  writeFileSync(log, `$ ${cmd.join(" ")}\n`);
  // Its own process group, so a timeout or Ctrl-C takes down everything it
  // started, not just the harness, and nothing keeps editing the tree after.
  const child = Bun.spawn(cmd, {
    cwd: o.repo,
    env: { ...o.env, CORGI_CUSTOM_BUILD_KIND: kind, CORGI_CUSTOM_BUILD_PROMPT: prompt },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const killGroup = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  const onSignal = (signal: NodeJS.Signals) => {
    killGroup();
    process.exit({ SIGINT: 130, SIGHUP: 129, SIGTERM: 143 }[signal as "SIGINT" | "SIGHUP" | "SIGTERM"]);
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, onSignal);
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      appendFileSync(log, chunk);
      o.echo?.(chunk);
    }
  };
  const encoder = new TextEncoder();
  const readable = (text: string) => {
    const parsed = parser!.feed(text);
    if (parsed.text.length) {
      const lines = parsed.text.map(line => `${line}\n`).join("");
      appendFileSync(log, lines);
      o.echo?.(encoder.encode(lines));
    }
    if (parsed.activity !== null) o.onActivity?.(parsed.activity);
  };
  const pumpParsed = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      appendFileSync(raw, chunk);
      readable(decoder.decode(chunk, { stream: true }));
    }
    readable(decoder.decode());
  };
  if (parser) writeFileSync(raw, "");
  const pumps = Promise.all([parser ? pumpParsed(child.stdout) : pump(child.stdout), pump(child.stderr)]).catch(
    () => {},
  );
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      killGroup();
    },
    (h.timeoutSeconds ?? 900) * 1000,
  );
  try {
    child.stdin.write(text);
    await child.stdin.end();
  } catch {}
  const code = await child.exited;
  clearTimeout(timer);
  killGroup();
  for (const signal of signals) process.off(signal, onSignal);
  // Children it left behind may hold its output open; don't wait for them.
  await Promise.race([pumps, Bun.sleep(1000)]);
  // The parser holds a last line that ended without a newline until it sees one.
  if (parser) readable("\n");
  const tail = lastLine(readFileSync(log, "utf8"));
  appendFileSync(log, timedOut ? `\n(killed after ${h.timeoutSeconds ?? 900}s)\n` : `\n(exit ${code})\n`);
  return { timedOut, code: timedOut ? null : code, tail, log, usage: parser?.usage() ?? null };
}
/** The last non-empty line a call printed, after the command line the log starts with. */
function lastLine(log: string): string {
  const line =
    log
      .split("\n")
      .slice(1)
      .findLast(line => line.trim()) ?? "";
  return line.trim().length > 200 ? `${line.trim().slice(0, 199)}…` : line.trim();
}

/** The verdict on a finished call: a timeout, or `accept`'s verdict on what it
 * left. A rejected call that exited non-zero is reported by its exit instead,
 * and is `broken`: a harness that fails to start (an expired login, a bad flag)
 * fails the same way on the next attempt. */
export function judge(call: Call, h: Harness, accept: () => Verdict): { verdict: Verdict; broken: boolean } {
  if (call.timedOut)
    return { verdict: { ok: false, reason: `it timed out after ${h.timeoutSeconds ?? 900}s` }, broken: false };
  const verdict = accept();
  if (verdict.ok || !call.code) return { verdict, broken: false };
  return { verdict: { ok: false, reason: `it exited ${call.code}${call.tail ? `: ${call.tail}` : ""}` }, broken: true };
}

/** A temporary file an interrupted `bun build` leaves in the checkout; never part of a fix. */
export function buildLeftover(path: string): boolean {
  return /(^|\/)\.[^/]+\.bun-build$/.test(path);
}

export type Verdict = { ok: true; files: string[] } | { ok: false; reason: string };
/** A verdict as a recorded call's outcome. */
export const outcome = (verdict: Verdict): { ok: boolean; reason?: string } =>
  verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason };
/** Seconds since a `performance.now()` reading, to a tenth. */
export const since = (started: number) => Math.round((performance.now() - started) / 100) / 10;
const marker = (line: string) => line.startsWith("<<<<<<< ") || line.startsWith(">>>>>>> ") || line === "=======";

/** Whether the harness resolved the conflict: the merge or rebase is still in progress,
 * HEAD is unchanged, no markers remain and only the conflicted files changed.
 * On success the files are staged for the merge commit. */
export function acceptConflict(
  repo: string,
  files: string[],
  headBefore: string,
  before: git.Snapshot,
  exclude: string[],
): Verdict {
  if (git.revParse(repo, "HEAD") !== headBefore) return { ok: false, reason: "it committed" };
  if (!git.conflictInProgress(repo)) return { ok: false, reason: "it ended the merge or rebase" };
  const outside = git.changedSince(repo, before, exclude).filter(path => !files.includes(path));
  if (outside.length) return { ok: false, reason: `it changed files outside the conflict: ${outside.join(", ")}` };
  for (const file of files) {
    const path = join(repo, file);
    if (existsSync(path) && readFileSync(path, "utf8").split("\n").some(marker))
      return { ok: false, reason: `conflict markers remain in ${file}` };
  }
  git.must(repo, ["add", "-A", "--", ...files]);
  const left = git.unmergedFiles(repo);
  if (left.length) return { ok: false, reason: `still unmerged: ${left.join(", ")}` };
  return { ok: true, files };
}

/** Whether the harness changed anything for a build fix; a commit it made is
 * undone with its changes kept, so the tool commits them itself. */
export function acceptFix(repo: string, headBefore: string, before: git.Snapshot, exclude: string[]): Verdict {
  if (git.revParse(repo, "HEAD") !== headBefore) git.must(repo, ["reset", "--quiet", "--soft", headBefore]);
  const files = git.changedSince(repo, before, exclude).filter(path => !buildLeftover(path));
  return files.length ? { ok: true, files } : { ok: false, reason: "it changed nothing" };
}

/** Undoes what a rejected attempt changed: back to `head`, without files it created. */
export function discard(repo: string, head: string, before: git.Snapshot, exclude: string[]): void {
  const created = git.changedSince(repo, before, exclude).filter(path => !(path in before));
  git.git(repo, ["merge", "--abort"]);
  git.must(repo, ["reset", "--quiet", "--hard", head]);
  for (const path of created)
    if (git.git(repo, ["cat-file", "-e", `HEAD:${path}`]).code !== 0) rmSync(join(repo, path), { force: true });
}
