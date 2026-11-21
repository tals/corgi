//! The review panel's reads as a viewer asks them of the daemon whose
//! checkouts they are (see service.ts). Replies are normalized here, once.
import * as git from "./git";
import type * as service from "./service";

export interface Reader {
  read(request: service.ReadRequest): Promise<service.Read>;
  diffs(request: service.DiffsRequest): Promise<service.Diffs>;
  summary(cwd: string): Promise<service.Summary>;
  recognize(cwd: string, hashes: string[]): Promise<Map<string, string>>;
}
/** Sends `op` to a daemon and resolves with its reply, throwing its error. */
export type Call = (op: string, payload: object) => Promise<unknown>;

export function daemon(call: Call): Reader {
  return {
    read: async request => read(await call("review.read", request)),
    diffs: async request => diffs(await call("review.diffs", request)),
    summary: async cwd => summary(await call("review.summary", { cwd })),
    recognize: async (cwd, hashes) => {
      const reply = (await call("review.recognize", { cwd, hashes })) as { found?: unknown };
      const found = Array.isArray(reply.found) ? reply.found : [];
      return new Map(
        found.flatMap((pair: unknown) =>
          Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string"
            ? [[pair[0], pair[1]] as [string, string]]
            : [],
        ),
      );
    },
  };
}

const str = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);
const strOrNull = (value: unknown) => (typeof value === "string" ? value : null);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const numOrNull = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);
const kinds: git.ChangeKind[] = ["added", "modified", "deleted", "renamed", "untracked"];

function revision(value: any): git.Revision | null {
  if (value?.kind === "commit") return { kind: "commit", hash: str(value.hash) };
  if (value?.kind === "range") return { kind: "range", from: str(value.from), to: str(value.to) };
  return null;
}
function source(value: any): git.Source | null {
  return value?.kind === "worktree" ? { kind: "worktree", against: str(value.against) } : revision(value);
}
function totals(value: any): service.Totals {
  return { files: num(value?.files), adds: num(value?.adds), dels: num(value?.dels) };
}
function change(value: any): git.Change {
  return {
    path: str(value?.path),
    from: strOrNull(value?.from),
    kind: kinds.find(k => k === value?.kind) ?? "modified",
    adds: numOrNull(value?.adds),
    dels: numOrNull(value?.dels),
    binary: value?.binary === true,
    generated: value?.generated === true,
    funcname: value?.funcname === true,
  };
}
function listing(value: any): service.Listing | null {
  const s = source(value?.source);
  if (!s) return null;
  return {
    source: s,
    changes: list(value.changes).map(change),
    totals: totals(value.totals),
    stats:
      value.stats == null
        ? null
        : list(value.stats).map((stat): [string, number, number] => [str(stat?.[0]), num(stat?.[1]), num(stat?.[2])]),
  };
}
function checkout(value: any): service.Checkout {
  const base = value?.base;
  return {
    head: strOrNull(value?.head),
    branch: strOrNull(value?.branch),
    base: base && typeof base === "object" ? { name: str(base.name), merge_base: str(base.merge_base) } : null,
    commits: list(value?.commits).map(cm => ({
      hash: str(cm?.hash),
      subject: str(cm?.subject),
      time: num(cm?.time),
      files: num(cm?.files),
      adds: num(cm?.adds),
      dels: num(cm?.dels),
    })),
    reference: revision(value?.reference),
    pick: strOrNull(value?.pick),
    listings: list(value?.listings).flatMap(l => listing(l) ?? []),
    error: strOrNull(value?.error),
  };
}
export function read(value: any): service.Read {
  const root = strOrNull(value?.root),
    same = value?.same === true;
  return {
    root,
    hash: str(value?.hash),
    same,
    checkout: root !== null && !same && value?.checkout ? checkout(value.checkout) : null,
  };
}
function slice(value: any): service.Slice {
  switch (value?.kind) {
    case "text":
      return {
        kind: "text",
        text: str(value.text),
        offset: num(value.offset),
        total: num(value.total),
        hash: str(value.hash),
        headers:
          value.headers == null ? null : list(value.headers).map((h): [number, string] => [num(h?.[0]), str(h?.[1])]),
      };
    case "binary":
      return { kind: "binary" };
    case "too_large":
      return { kind: "too_large", bytes: num(value.bytes) };
    default:
      return { kind: "failed", message: str(value?.message, "git diff failed") };
  }
}
export function diffs(value: any): service.Diffs {
  return { files: list(value?.files).map(f => ({ path: str(f?.path), slice: slice(f?.slice) })) };
}
export function summary(value: any): service.Summary {
  const root = strOrNull(value?.root);
  return { root, base: strOrNull(value?.base), totals: root && value?.totals ? totals(value.totals) : null };
}

/** A file's diff text as its slices arrive. */
export class Partial {
  private parts: string[] = [];
  private length = 0;
  hash = "";
  headers: [number, string][] | null = null;
  /** Where the next slice starts. */
  get offset(): number {
    return this.length;
  }
  /** Takes `slice`; the whole text once it has every part, else null. A
   * slice from the start begins the text again. */
  add(slice: service.Slice & { kind: "text" }): git.Text | null {
    if (slice.offset === 0 || slice.hash !== this.hash) {
      this.parts = [];
      this.length = 0;
      this.hash = slice.hash;
      this.headers = slice.headers;
    }
    if (slice.offset !== this.length) return null;
    this.parts.push(slice.text);
    this.length += slice.text.length;
    if (this.length < slice.total) return null;
    return { kind: "text", text: this.parts.join(""), headers: this.headers };
  }
}
