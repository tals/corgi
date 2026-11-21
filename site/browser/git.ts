/**
 * The review panel's git on the landing page. The recorder made moonlander's
 * checkouts for real and kept what git answered about each in frames.json;
 * this answers the page's review service the same for the one it reads, its
 * times moved up to now. package.json's "browser" field puts it in place of
 * src/review/git.ts.
 */
import type { Base, Change, Commit, Loaded, Revision, Scope, Source, Text } from "../../src/review/git";
import * as diff from "../../src/review/diff";
import DATA from "../frames.json";

/** What git answered, as the recorder keeps it. */
export interface Fixture {
  /** When git was read, in seconds. */
  at: number;
  root: string;
  head: string;
  branch: string;
  base: Base | null;
  commits: Commit[];
  /** Each source's changes, under the panel's key for the source. */
  listings: Record<string, Change[]>;
  /** When each file in the working tree was last written, in ms. */
  edited: Record<string, number>;
  /** Each file's diff under its source's key and path: the patch, or why there is none. */
  diffs: Record<string, string | Exclude<Loaded, { kind: "diff" }>>;
}
const fixtures = (DATA as unknown as { review: Fixture[] }).review;
const shift = Date.now() / 1000 - fixtures[0].at;
/** The checkout at `root`: the one named so, else the first. */
const at = (root: string) => fixtures.find(f => f.root === root) ?? fixtures[0];

/** As git.ts has them. */
export const empty_tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export function sourceKey(s: Source): string {
  return s.kind === "worktree" ? `w:${s.against}` : `${s.kind === "commit" ? "c" : "r"}:${revisionLabel(s)}`;
}
export function sourceOf(
  scope: Scope,
  pick: string | null,
  reference: Revision | null,
  head: string | null,
  base: Base | null,
): Source | null {
  if (reference) return reference;
  if (scope === "commits") return pick ? { kind: "commit", hash: pick } : null;
  if (scope === "all" && base) return { kind: "worktree", against: base.merge_base };
  return { kind: "worktree", against: head ?? empty_tree };
}
export function parseText(read: Text): Loaded {
  if (read.kind !== "text") return read;
  const parsed = diff.parse(read.text);
  if (parsed === "binary") return { kind: "binary" };
  if (read.headers) parsed.headers = new Map(read.headers);
  return { kind: "diff", diff: parsed };
}
export function revisionLabel(source: Revision, short = false): string {
  const name = (ref: string) => (short && /^[0-9a-f]{7,64}$/i.test(ref) ? ref.slice(0, 7) : ref);
  return source.kind === "commit" ? name(source.hash) : `${name(source.from)}..${name(source.to)}`;
}
/** The recordings name commits by their full hashes already. */
export async function resolveRevision(_root: string, source: Revision): Promise<Revision> {
  return source;
}
/** The commits a checkout recorded, by the prefixes asked for. */
export async function recognizeCommits(root: string, candidates: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const prefix of candidates.map(c => c.toLowerCase()))
    if (/^[0-9a-f]{7,64}$/.test(prefix)) {
      const commit = at(root).commits.find(c => c.hash.startsWith(prefix));
      if (commit) found.set(prefix, commit.hash);
    }
  return found;
}
export async function toplevel(cwd: string): Promise<string | null> {
  return cwd ? at(cwd).root : null;
}
export async function head(root: string): Promise<string | null> {
  return at(root).head;
}
export async function branch(root: string): Promise<string | null> {
  return at(root).branch;
}
export async function base(root: string): Promise<Base | null> {
  return at(root).base;
}
export async function commits(root: string, _base: Base | null): Promise<Commit[]> {
  return at(root).commits.map(c => ({ ...c, time: Math.round(c.time + shift) }));
}
export async function changes(root: string, source: Source): Promise<Change[]> {
  const listed = at(root).listings[sourceKey(source)];
  if (!listed) throw Error("GitFailed");
  // Recorded before Changes carried `funcname`.
  return listed.map(c => ({ ...c, funcname: c.funcname ?? false }));
}
/** Each file's last write; the recording keeps no sizes. */
export async function stats(root: string, paths: string[]): Promise<[string, number, number][]> {
  const f = at(root);
  return paths.filter(path => path in f.edited).map(path => [path, 0, f.edited[path] + shift * 1000]);
}
export async function fileText(root: string, source: Source, change: Change): Promise<Text> {
  const found = at(root).diffs[`${sourceKey(source)}\0${change.path}`];
  if (found === undefined) return { kind: "failed", message: "git diff failed" };
  return typeof found === "string" ? { kind: "text", text: found, headers: null } : found;
}
