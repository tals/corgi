//! Every git call the review panel makes: the checkout and its base branch,
//! what changed and by how much, the branch's commits, and one file's diff.
//! Reads only; nothing here writes to the repository. Mirrors
//! herdr-reviewr's `git.rs`.
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import * as subprocess from "../subprocess";
import * as diff from "./diff";

/** git's empty tree, the base for a commit with no parent or an unborn HEAD. */
export const empty_tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** Untracked files listed at most; past this the listing stops. */
const max_untracked = 2000;
const timeout_ms = 15_000;

export type ChangeKind = "added" | "modified" | "deleted" | "renamed" | "untracked";
export interface Change {
  path: string;
  /** The path before a rename. */
  from: string | null;
  kind: ChangeKind;
  /** Lines added and removed; null where git counts none (binary). */
  adds: number | null;
  dels: number | null;
  binary: boolean;
  generated: boolean;
}
/** What a listing diffs: the working tree against a revision, or one commit. */
export type Source = { kind: "worktree"; against: string } | { kind: "commit"; hash: string };
export interface Base {
  /** The branch compared against, such as `main`. */
  name: string;
  merge_base: string;
}
export interface Commit {
  hash: string;
  subject: string;
  /** Seconds since the epoch. */
  time: number;
  /** Files it touched and lines it added and removed; a merge counts against its first parent. */
  files: number;
  adds: number;
  dels: number;
}
export type Loaded =
  | { kind: "diff"; diff: diff.FileDiff }
  | { kind: "binary" }
  | { kind: "too_large"; bytes: number }
  | { kind: "failed"; message: string };

async function git(
  root: string,
  args: string[],
  options: Partial<subprocess.Options> = {},
): Promise<subprocess.Output> {
  return subprocess.run(["git", "-C", root, "-c", "core.quotepath=false", ...args], {
    timeout_ms,
    max_output: 4 * 1024 * 1024,
    stderr: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    ...options,
  });
}
async function line(root: string, args: string[]): Promise<string | null> {
  try {
    const out = await git(root, args);
    return out.ok() ? out.stdout.toString().trim() || null : null;
  } catch {
    return null;
  }
}

/** The checkout `cwd` sits in, or null outside one. */
export async function toplevel(cwd: string): Promise<string | null> {
  if (!cwd) return null;
  return line(cwd, ["rev-parse", "--show-toplevel"]);
}
export async function head(root: string): Promise<string | null> {
  return line(root, ["rev-parse", "--verify", "-q", "HEAD"]);
}
export async function branch(root: string): Promise<string | null> {
  return line(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
}

/** The branch a checkout is compared against: the default branch, as
 * `origin/HEAD` names it, else `init.defaultBranch`, `main` or `master`.
 * Of its local and origin copies, the one the checkout forked from latest
 * wins, so neither commits main hasn't pushed nor ones it hasn't pulled
 * count as the branch's. On the default branch itself, origin's copy is
 * the base. */
export async function base(root: string): Promise<Base | null> {
  const [remote_head, configured, current] = await Promise.all([
    line(root, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]),
    line(root, ["config", "--get", "init.defaultBranch"]),
    branch(root),
  ]);
  const names = [remote_head?.replace(/^origin\//, ""), configured, "main", "master"].filter(
    (name): name is string => !!name,
  );
  for (const name of new Set(names)) {
    let best: Base | null = null,
      ahead = Infinity;
    const refs = name === current ? [`origin/${name}`] : [`refs/heads/${name}`, `refs/remotes/origin/${name}`];
    for (const ref of refs) {
      if ((await line(root, ["rev-parse", "--verify", "-q", `${ref}^{commit}`])) === null) continue;
      const merge_base = await line(root, ["merge-base", ref, "HEAD"]);
      if (!merge_base) continue;
      const count = Number(await line(root, ["rev-list", "--count", "--first-parent", `${merge_base}..HEAD`]));
      if (count < ahead) [best, ahead] = [{ name: name === current ? ref : name, merge_base }, count];
    }
    if (best) return best;
  }
  return null;
}

/** When each of `paths` in the working tree was last written, in ms; a
 * missing file has none. */
export async function edited(root: string, paths: string[]): Promise<Map<string, number>> {
  const times = await Promise.all(
    paths.map(path =>
      stat(join(root, path)).then(
        info => info.mtimeMs,
        () => null,
      ),
    ),
  );
  return new Map(paths.flatMap((path, i) => (times[i] === null ? [] : [[path, times[i]] as [string, number]])));
}

/** Parses `git log` with `log_format` and `--shortstat`: a record per
 * commit, its fields on the first line and its stat after. */
export function parseLog(raw: string): Commit[] {
  return raw
    .split("\x1e")
    .filter(record => record.trim().length > 0)
    .map(record => {
      const [head, ...rest] = record.split("\n");
      const [hash, time, subject] = head.split("\0");
      const stat = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(
        rest.join("\n"),
      );
      return {
        hash,
        time: Number(time) || 0,
        subject: subject ?? "",
        files: Number(stat?.[1] ?? 0),
        adds: Number(stat?.[2] ?? 0),
        dels: Number(stat?.[3] ?? 0),
      };
    })
    .filter(c => /^[0-9a-f]{7,64}$/.test(c.hash));
}
const log_format = "--format=%x1e%H%x00%ct%x00%s";
/** The branch's own commits, newest first, or the latest ones without a
 * base. First parents only, so commits a merge brought in stay with it. */
export async function commits(root: string, base: Base | null): Promise<Commit[]> {
  const range = base ? ["-n", "200", `${base.merge_base}..HEAD`] : ["-n", "50", "HEAD"];
  const log = await git(root, [
    "log",
    "--first-parent",
    "--diff-merges=first-parent",
    log_format,
    "--shortstat",
    ...range,
  ]).catch(() => null);
  return log?.ok() ? parseLog(log.stdout.toString()) : [];
}

/** Parses `git diff --raw --numstat -z -M`: the raw records name each
 * change's kind, the numstat records count its lines. */
export function parseChanges(raw: string): Change[] {
  const fields = raw.split("\0");
  const changes = new Map<string, Change>();
  const order: string[] = [];
  let i = 0;
  while (i < fields.length) {
    const field = fields[i];
    if (field.startsWith(":")) {
      const status = field.split(" ").pop() ?? "";
      const letter = status[0];
      if (letter === "R" || letter === "C") {
        const from = fields[i + 1],
          to = fields[i + 2];
        changes.set(to, {
          path: to,
          from,
          kind: letter === "R" ? "renamed" : "added",
          adds: null,
          dels: null,
          binary: false,
          generated: false,
        });
        order.push(to);
        i += 3;
        continue;
      }
      const path = fields[i + 1];
      const kind: ChangeKind = letter === "A" ? "added" : letter === "D" ? "deleted" : "modified";
      changes.set(path, { path, from: null, kind, adds: null, dels: null, binary: false, generated: false });
      order.push(path);
      i += 2;
      continue;
    }
    const counts = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(field);
    if (counts) {
      let path = counts[3];
      if (path === "") {
        path = fields[i + 2];
        i += 3;
      } else i += 1;
      const change = changes.get(path);
      if (change) {
        change.binary = counts[1] === "-";
        change.adds = change.binary ? null : Number(counts[1]);
        change.dels = change.binary ? null : Number(counts[2]);
      }
      continue;
    }
    i += 1;
  }
  return order.map(path => changes.get(path)!);
}
const generated_names =
  /(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock)$|\.min\.(js|css)$|\.map$/;
export function parseCheckAttr(raw: string): Set<string> {
  const out = new Set<string>();
  const fields = raw.split("\0");
  for (let i = 0; i + 2 < fields.length; i += 3)
    if (fields[i + 2] === "set" || fields[i + 2] === "true") out.add(fields[i]);
  return out;
}

/** Untracked files whose lines are counted; the rest list without a count. */
const counted_untracked = 300;
const max_counted_bytes = 256 * 1024;
async function countLines(root: string, change: Change): Promise<void> {
  try {
    const file = join(root, change.path),
      info = await stat(file);
    if (!info.isFile() || info.size > max_counted_bytes) return;
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(info.size);
      await handle.read(buffer, 0, info.size, 0);
      if (buffer.subarray(0, 8000).includes(0)) change.binary = true;
      else {
        let lines = 0;
        for (const byte of buffer) if (byte === 10) lines++;
        change.adds = lines + (buffer.length > 0 && buffer[buffer.length - 1] !== 10 ? 1 : 0);
      }
    } finally {
      await handle.close();
    }
  } catch {}
}
async function untracked(root: string): Promise<Change[]> {
  const out = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!out.ok()) return [];
  const listed = out.stdout
    .toString()
    .split("\0")
    .filter(Boolean)
    .slice(0, max_untracked)
    .map((path): Change => ({
      path,
      from: null,
      kind: "untracked",
      adds: null,
      dels: 0,
      binary: false,
      generated: false,
    }));
  const counted = listed.slice(0, counted_untracked);
  for (let i = 0; i < counted.length; i += 16)
    await Promise.all(counted.slice(i, i + 16).map(c => countLines(root, c)));
  return listed;
}

/** The parent a commit diffs against: its first parent, or the empty tree. */
async function parentOf(root: string, hash: string): Promise<string> {
  return (await line(root, ["rev-parse", "--verify", "-q", `${hash}^`])) ?? empty_tree;
}

/** The files `source` changed, with untracked files for a working tree. */
export async function changes(root: string, source: Source): Promise<Change[]> {
  const range = source.kind === "worktree" ? [source.against] : [await parentOf(root, source.hash), source.hash];
  const out = await git(root, ["diff", "--raw", "--numstat", "-z", "-M", "--no-ext-diff", ...range]);
  if (!out.ok()) throw Error(out.stderr.toString().trim() || "GitFailed");
  const listed = parseChanges(out.stdout.toString());
  if (source.kind === "worktree") listed.push(...(await untracked(root)));
  const paths = listed.map(c => c.path);
  let marked = new Set<string>();
  if (paths.length) {
    const attrs = await git(root, ["check-attr", "-z", "--stdin", "linguist-generated"], {
      input: paths.join("\0") + "\0",
    }).catch(() => null);
    if (attrs?.ok()) marked = parseCheckAttr(attrs.stdout.toString());
  }
  for (const change of listed) change.generated = marked.has(change.path) || generated_names.test(change.path);
  return listed;
}

async function blobSize(root: string, rev: string, path: string): Promise<number> {
  const size = await line(root, ["cat-file", "-s", `${rev}:${path}`]);
  return size === null ? 0 : Number(size) || 0;
}
async function fileSize(root: string, path: string): Promise<number> {
  try {
    return (await stat(join(root, path))).size;
  } catch {
    return 0;
  }
}

/** One file's diff with the whole file as context, or why there is none. */
export async function fileDiff(root: string, source: Source, change: Change): Promise<Loaded> {
  if (change.binary) return { kind: "binary" };
  const old_path = change.from ?? change.path;
  const old_rev = source.kind === "worktree" ? source.against : await parentOf(root, source.hash);
  const new_size =
    change.kind === "deleted"
      ? 0
      : source.kind === "worktree"
        ? await fileSize(root, change.path)
        : await blobSize(root, source.hash, change.path);
  const old_size = change.kind === "added" || change.kind === "untracked" ? 0 : await blobSize(root, old_rev, old_path);
  if (old_size + new_size > diff.max_bytes) return { kind: "too_large", bytes: old_size + new_size };
  const context = `-U${diff.max_lines + 1}`;
  const paths = change.from ? [change.from, change.path] : [change.path];
  const args =
    change.kind === "untracked"
      ? ["diff", "--no-index", "--no-color", "--no-ext-diff", context, "--", "/dev/null", change.path]
      : source.kind === "worktree"
        ? ["diff", "--no-color", "--no-ext-diff", context, "-M", source.against, "--", ...paths]
        : ["diff", "--no-color", "--no-ext-diff", context, "-M", old_rev, source.hash, "--", ...paths];
  try {
    const out = await git(root, args, { max_output: 3 * diff.max_bytes + 65536 });
    // `--no-index` exits 1 when the files differ.
    if (!out.ok() && !(change.kind === "untracked" && "exited" in out.term && out.term.exited === 1))
      return { kind: "failed", message: out.stderr.toString().trim() || "git diff failed" };
    const parsed = diff.parse(out.stdout.toString());
    if (parsed === "binary") return { kind: "binary" };
    if (parsed.old.length + parsed.new.length > diff.max_lines)
      return { kind: "too_large", bytes: old_size + new_size };
    return { kind: "diff", diff: parsed };
  } catch (error) {
    const name = (error as Error).message;
    return name === "OutputTooLarge"
      ? { kind: "too_large", bytes: old_size + new_size }
      : { kind: "failed", message: name };
  }
}
