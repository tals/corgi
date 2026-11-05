/**
 * The review panel's git on the landing page. The recorder made moonlander's
 * checkouts for real and kept what git answered about each in frames.json;
 * this answers the panel the same for the one it reads, its times moved up to
 * now. package.json's "browser" field puts it in place of src/review/git.ts.
 */
import type { Base, Change, Commit, Loaded, Revision, Source } from "../../src/review/git";
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
const sourceKey = (s: Source) =>
  s.kind === "worktree" ? `w:${s.against}` : `${s.kind === "commit" ? "c" : "r"}:${revisionLabel(s)}`;

/** As git.ts has it. */
export const empty_tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
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
export async function edited(root: string, paths: string[]): Promise<Map<string, number>> {
  const f = at(root);
  return new Map(paths.filter(path => path in f.edited).map(path => [path, f.edited[path] + shift * 1000]));
}
export async function fileDiff(root: string, source: Source, change: Change): Promise<Loaded> {
  const found = at(root).diffs[`${sourceKey(source)}\0${change.path}`];
  if (found === undefined) return { kind: "failed", message: "git diff failed" };
  if (typeof found !== "string") return found;
  const parsed = diff.parse(found);
  return parsed === "binary" ? { kind: "binary" } : { kind: "diff", diff: parsed };
}
