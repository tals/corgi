//! The review panel's reads, answered by the daemon of the machine whose
//! checkouts they are, so a remote machine's review reads its own files.
//!
//! What a checkout is and which files changed (`read`) travels apart from
//! the files' text (`diffs`), and both stay small: a listing names at most
//! `max_listed` files in `listed_chars` of paths, and a diffs reply carries at most `reply_chars` of
//! text, the rest of a long file in later slices. A poll that finds nothing
//! new answers `same` instead of the listing again. Viewers ask for both on
//! the data connection, which pane frames share, so no reply holds them long.
import { homedir } from "node:os";
import { join } from "node:path";
import type * as protocol from "../protocol";
import * as git from "./git";

/** Files a listing names at most; its totals count every one. */
export const max_listed = 3000;
/** Path text a listing names at most, so long paths keep a reply far under
 * the 4 MB a connection queues. */
export const listed_chars = 256 * 1024;
/** Diff text one reply carries at most, in UTF-16 units. Replies share the
 * data connection with pane frames, which wait while one is sent; JSON escapes
 * can make one several times this, and a connection fails past 4 MB queued. */
export const reply_chars = 64 * 1024;
/** Files one diffs request names at most. */
export const max_files = 64;
/** Commit hashes one recognize request names at most. */
export const max_hashes = 256;
/** Starting a file in a reply that already holds others takes at least this much room. */
const min_slice = 16 * 1024;
/** Files a diffs reply reads at once. */
const parallel_reads = 4;
/** A read still running after this answers with a timeout; a client
 * gives up on a reply after 120 s. */
const deadline_ms = 60_000;
/** Long diffs kept between their slices, and for how long. */
const kept_chars = 8 * 1024 * 1024;
const kept_ms = 60_000;

export interface Totals {
  files: number;
  adds: number;
  dels: number;
}
export interface Listing {
  source: git.Source;
  /** The first `max_listed` files. */
  changes: git.Change[];
  totals: Totals;
  /** Each listed working-tree file's size and when it was last written, in
   * ms; none for a commit. */
  stats: [string, number, number][] | null;
}
export interface Checkout {
  head: string | null;
  branch: string | null;
  base: git.Base | null;
  commits: git.Commit[];
  /** The request's reference and pick, as full hashes. */
  reference: git.Revision | null;
  pick: string | null;
  /** The scope's files, then for "all" the working copy's alone, which says
   * where each file's change is. */
  listings: Listing[];
  error: string | null;
}
export interface ReadRequest {
  cwd: string;
  scope: git.Scope;
  pick: string | null;
  reference: git.Revision | null;
  /** The hash of the reply the asker has, so an unchanged one isn't sent again. */
  known: string;
}
export interface Read {
  /** The checkout `cwd` is in, or null outside one. */
  root: string | null;
  hash: string;
  /** The asker already has this reply: `checkout` is left out. */
  same: boolean;
  checkout: Checkout | null;
}
/** A file to read, as its listing named it. `offset` continues a text
 * whose slices came with `hash`. */
export interface DiffFile {
  path: string;
  from: string | null;
  kind: git.ChangeKind;
  binary: boolean;
  funcname: boolean;
  offset: number;
  hash: string;
}
export interface DiffsRequest {
  root: string;
  source: git.Source;
  files: DiffFile[];
}
/** Part of a file's diff text from `offset`, of `total`; a slice whose
 * `hash` differs from the one asked for starts the text over. */
export type Slice =
  | { kind: "text"; text: string; offset: number; total: number; hash: string; headers: [number, string][] | null }
  | Exclude<git.Text, { kind: "text" }>;
/** The files read, in the order asked; those left out didn't fit. */
export interface Diffs {
  files: { path: string; slice: Slice }[];
}
export interface Summary {
  root: string | null;
  /** The branch compared against. */
  base: string | null;
  totals: Totals | null;
}

export function totals(changes: git.Change[]): Totals {
  let adds = 0,
    dels = 0;
  for (const ch of changes) {
    adds += ch.adds ?? 0;
    dels += ch.dels ?? 0;
  }
  return { files: changes.length, adds, dels };
}
/** A 53-bit hash (cyrb53) that runs anywhere, the landing page included. */
function hashOf(text: string): string {
  let h1 = 0xdeadbeef,
    h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
/** Fails with Timeout once `ms` pass, leaving `work` to finish unwatched. */
async function within<T>(work: Promise<T>, ms = deadline_ms): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("Timeout")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function list(root: string, source: git.Source): Promise<Listing> {
  const all = await git.changes(root, source);
  let count = 0,
    chars = 0;
  for (; count < Math.min(all.length, max_listed); count++) {
    chars += all[count].path.length + (all[count].from?.length ?? 0);
    if (chars > listed_chars) break;
  }
  const changes = all.slice(0, count);
  return {
    source,
    changes,
    totals: totals(all),
    stats:
      source.kind === "worktree"
        ? await git.stats(
            root,
            changes.map(ch => ch.path),
          )
        : null,
  };
}
async function readCheckout(
  root: string,
  scope: git.Scope,
  pick: string | null,
  reference: git.Revision | null,
): Promise<Checkout> {
  const [head, branch, base] = await Promise.all([git.head(root), git.branch(root), git.base(root)]);
  const commits = await git.commits(root, base);
  const out: Checkout = { head, branch, base, commits, reference, pick, listings: [], error: null };
  try {
    if (reference) out.reference = await git.resolveRevision(root, reference);
    // A pick from elsewhere may name its commit short, or one off the
    // branch's own, such as one a merge brought in. Only "commits" shows it.
    const picked = pick ? commits.find(cm => cm.hash.startsWith(pick)) : undefined;
    if (picked) out.pick = picked.hash;
    else if (pick && scope === "commits" && !out.reference) {
      const resolved = await git.resolveRevision(root, { kind: "commit", hash: pick });
      if (resolved.kind === "commit") out.pick = resolved.hash;
    }
    const source = git.sourceOf(scope, out.pick, out.reference, head, base);
    if (!source) return out;
    out.listings.push(await list(root, source));
    const working: git.Source = { kind: "worktree", against: head ?? git.empty_tree };
    if (scope === "all" && !out.reference && git.sourceKey(source) !== git.sourceKey(working))
      out.listings.push(await list(root, working));
  } catch (error) {
    out.error = (error as Error).message;
  }
  return out;
}
/** Reads under way, so viewers polling the same checkout share one, even
 * past an asker's deadline: the next poll waits on it rather than start another. */
const reads = new Map<string, Promise<{ root: string | null; hash: string; checkout: Checkout | null }>>();
export async function read(request: ReadRequest): Promise<Read> {
  const { cwd, scope, pick, reference } = request,
    key = JSON.stringify([cwd, scope, pick, reference]);
  let running = reads.get(key);
  if (!running) {
    running = (async () => {
      const root = await git.toplevel(cwd);
      const checkout = root ? await readCheckout(root, scope, pick, reference) : null;
      return { root, checkout, hash: hashOf(JSON.stringify([root, checkout])) };
    })().finally(() => reads.delete(key));
    reads.set(key, running);
  }
  const { root, checkout, hash } = await within(running);
  const same = hash === request.known;
  return { root, hash, same, checkout: same ? null : checkout };
}

/** Long texts between their slices, oldest first. */
const kept = new Map<string, { hash: string; text: git.Text & { kind: "text" }; at: number }>();
let sweep: ReturnType<typeof setTimeout> | undefined;
function keep(key: string, hash: string, text: git.Text & { kind: "text" }): void {
  kept.delete(key);
  kept.set(key, { hash, text, at: Date.now() });
  evict();
}
/** Drops the oldest texts past `kept_chars` and those past `kept_ms`, then
 * comes back when the oldest left is due, so none stays long after its time. */
function evict(): void {
  const now = Date.now();
  let chars = 0;
  for (const entry of kept.values()) chars += entry.text.text.length;
  for (const [k, entry] of kept) {
    if (chars <= kept_chars && now - entry.at < kept_ms) break;
    kept.delete(k);
    chars -= entry.text.text.length;
  }
  clearTimeout(sweep);
  const oldest = kept.values().next().value;
  sweep = oldest ? setTimeout(evict, oldest.at + kept_ms - now) : undefined;
  sweep?.unref?.();
}
const keptKey = (root: string, source: git.Source, path: string) => JSON.stringify([root, git.sourceKey(source), path]);
async function fileText(root: string, source: git.Source, file: DiffFile): Promise<{ hash: string; read: git.Text }> {
  const held = kept.get(keptKey(root, source, file.path));
  if (file.offset > 0 && held && held.hash === file.hash && Date.now() - held.at < kept_ms)
    return { hash: held.hash, read: held.text };
  const { path, from, kind, binary, funcname } = file;
  const read = await git.fileText(root, source, {
    path,
    from,
    kind,
    binary,
    funcname,
    adds: null,
    dels: null,
    generated: false,
  });
  return { hash: read.kind === "text" ? hashOf(read.text) : "", read };
}
/** The files' diffs in the order asked, until the reply holds `reply_chars`. */
export async function diffs(request: DiffsRequest): Promise<Diffs> {
  const { root, source } = request,
    files = request.files.slice(0, max_files),
    out: Diffs["files"] = [];
  let room = reply_chars;
  return within(
    (async () => {
      for (let i = 0; i < files.length && room > 0; i += parallel_reads) {
        const batch = files.slice(i, i + parallel_reads),
          texts = await Promise.all(batch.map(file => fileText(root, source, file)));
        for (const [j, { hash, read }] of texts.entries()) {
          const file = batch[j];
          if (read.kind !== "text") {
            out.push({ path: file.path, slice: read });
            continue;
          }
          const offset = hash === file.hash ? Math.min(file.offset, read.text.length) : 0,
            rest = read.text.length - offset,
            take = Math.min(rest, room);
          // A long file starts in a reply of its own rather than a sliver of this one.
          if (take < rest && take < min_slice && out.length) {
            room = 0;
            break;
          }
          if (take < rest) keep(keptKey(root, source, file.path), hash, read);
          out.push({
            path: file.path,
            slice: {
              kind: "text",
              text: read.text.slice(offset, offset + take),
              offset,
              total: read.text.length,
              hash,
              headers: offset === 0 ? read.headers : null,
            },
          });
          room -= take;
          if (room <= 0) break;
        }
      }
      return { files: out };
    })(),
  );
}

/** Summaries under way, shared as `reads` are. */
const summaries = new Map<string, Promise<Summary>>();
/** What reviewing `cwd`'s checkout would open on: its files and lines
 * changed since it left the base branch, uncommitted ones included. */
export function summary(cwd: string): Promise<Summary> {
  let running = summaries.get(cwd);
  if (!running) {
    running = (async (): Promise<Summary> => {
      const root = await git.toplevel(cwd);
      if (!root) return { root: null, base: null, totals: null };
      const [base, head] = await Promise.all([git.base(root), git.head(root)]);
      const changes = await git.changes(root, {
        kind: "worktree",
        against: base?.merge_base ?? head ?? git.empty_tree,
      });
      return { root, base: base?.name ?? null, totals: totals(changes) };
    })().finally(() => summaries.delete(cwd));
    summaries.set(cwd, running);
  }
  return within(running);
}

export async function recognize(cwd: string, hashes: string[]): Promise<[string, string][]> {
  return [...(await within(git.recognizeCommits(cwd, hashes.slice(0, max_hashes))))];
}

export type Op = "review.read" | "review.diffs" | "review.summary" | "review.recognize";
/** Answers a review request as its daemon decoded it. */
export async function answer(request: Extract<protocol.DecodedRequest, { op: Op }>): Promise<object> {
  switch (request.op) {
    case "review.read": {
      const { scope, known } = request.payload,
        pick = request.payload.pick === null ? null : refName(request.payload.pick),
        reference = request.payload.reference === null ? null : revision(request.payload.reference);
      return read({ cwd: folder(request.payload.cwd), scope, pick, reference, known });
    }
    case "review.diffs": {
      const { root } = request.payload;
      return diffs({ root, source: source(request.payload.source), files: diffFiles(request.payload.files) });
    }
    case "review.summary":
      return summary(folder(request.payload.cwd));
    case "review.recognize":
      return { found: await recognize(folder(request.payload.cwd), request.payload.hashes) };
  }
}
/** A folder named from the home, as a prompt's `HEAD@~/repo` is, in this machine's home. */
export function folder(cwd: string): string {
  return cwd === "~" ? homedir() : cwd.startsWith("~/") ? join(homedir(), cwd.slice(2)) : cwd;
}

// Requests as the daemon decodes them: what the protocol leaves as JSON is
// checked here, once.
const hash_pattern = /^[0-9a-f]{40,64}$/;
const kinds: git.ChangeKind[] = ["added", "modified", "deleted", "renamed", "untracked"];
const text = (value: unknown): string => {
  if (typeof value !== "string" || value.includes("\0")) throw Error("UnexpectedToken");
  return value;
};
/** A ref or hash as a person names it, never an option. */
export function refName(value: unknown): string {
  const ref = text(value);
  if (!ref || ref.startsWith("-")) throw Error("UnexpectedToken");
  return ref;
}
/** A revision as a person names it. */
export function revision(value: unknown): git.Revision {
  const v = value as Record<string, unknown> | null;
  switch (v?.kind) {
    case "commit":
      return { kind: "commit", hash: refName(v.hash) };
    case "range":
      return { kind: "range", from: refName(v.from), to: refName(v.to) };
  }
  throw Error("InvalidEnumTag");
}
/** A source a listing named: every revision in it a full hash. */
export function source(value: unknown): git.Source {
  const v = value as Record<string, unknown> | null;
  const hash = (field: unknown) => {
    const h = text(field);
    if (!hash_pattern.test(h)) throw Error("UnexpectedToken");
    return h;
  };
  switch (v?.kind) {
    case "worktree":
      return { kind: "worktree", against: hash(v.against) };
    case "commit":
      return { kind: "commit", hash: hash(v.hash) };
    case "range":
      return { kind: "range", from: hash(v.from), to: hash(v.to) };
  }
  throw Error("InvalidEnumTag");
}
/** A path inside the checkout: relative, and never up out of it. */
function inside(value: unknown): string {
  const path = text(value);
  if (!path || path.startsWith("/") || path.split("/").includes("..")) throw Error("InvalidPath");
  return path;
}
export function diffFiles(value: unknown): DiffFile[] {
  if (!Array.isArray(value) || value.length > max_files) throw Error("UnexpectedToken");
  return value.map(item => {
    const v = item as Record<string, unknown> | null;
    const kind = kinds.find(k => k === v?.kind);
    if (!v || !kind) throw Error("InvalidEnumTag");
    const offset = v.offset ?? 0;
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) throw Error("UnexpectedToken");
    return {
      path: inside(v.path),
      from: v.from == null ? null : inside(v.from),
      kind,
      binary: v.binary === true,
      funcname: v.funcname === true,
      offset,
      hash: typeof v.hash === "string" ? v.hash : "",
    };
  });
}
