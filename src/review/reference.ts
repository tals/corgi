// A prompt reference keeps the repository separate from git's revision syntax.
import { recognizeCommits, revisionLabel, type Revision } from "./git";
export type Reference = { folder: string; source: Revision; implicit?: true };
export type Resolved = { cwd: string; source: Revision };
const valid = (ref: string) => /^[A-Za-z0-9_][A-Za-z0-9_./~^{}-]*$/.test(ref) && !ref.includes("..");
export function parse(value: string): Reference | null {
  const at = value.indexOf("@");
  if (at < 1) return null;
  const revision = value.slice(0, at),
    folder = value.slice(at + 1);
  if (!folder || /[\x00-\x1f\x7f]/.test(folder)) return null;
  const parts = revision.split("..");
  if (parts.length === 1 && valid(revision)) return { folder, source: { kind: "commit", hash: revision } };
  if (parts.length === 2 && parts.every(valid))
    return { folder, source: { kind: "range", from: parts[0], to: parts[1] } };
  return null;
}
/** A hash without a folder belongs to the prompt's repository. Other names stay explicit. */
export function code(value: string): Reference | null {
  const bare = /^[0-9a-fA-F]{7,64}(?:\.\.[0-9a-fA-F]{7,64})?$/.test(value);
  const ref = parse(bare ? `${value}@.` : value);
  return ref && (ref.source.kind === "range" || /^(?:[0-9a-fA-F]{7,64}|HEAD(?:[~^]\d*)*)$/.test(ref.source.hash))
    ? bare
      ? { ...ref, implicit: true }
      : ref
    : null;
}
export function label(ref: Reference): string {
  return revisionLabel(ref.source);
}
/** Candidates in prose, with Git deciding which ones are actually commits. */
export function mentions(text: string): { start: number; end: number; ref: Reference }[] {
  const pattern = /(?<![\p{L}\p{N}_/@.-])[0-9a-f]{7,64}(?:\.\.[0-9a-f]{7,64})?(?![\p{L}\p{N}_/@-]|\.[\p{L}\p{N}_.])/giu;
  const out: { start: number; end: number; ref: Reference }[] = [];
  for (const match of text.matchAll(pattern)) {
    const ref = code(match[0]);
    if (ref) out.push({ start: match.index!, end: match.index! + match[0].length, ref });
  }
  return out;
}
export function key(value: Resolved): string {
  const source = value.source;
  return JSON.stringify([value.cwd, source.kind, source.kind === "commit" ? source.hash : [source.from, source.to]]);
}

/** Visible candidates share one batched Git read. Redraws only consult the cache. */
export class Recognizer {
  private answers = new Map<string, { hash: string | null } | null>();
  private queued = new Map<string, Set<string>>();
  private flight: Promise<void> | null = null;
  changed: () => void = () => {};
  constructor(private read = recognizeCommits) {}
  resolve(cwd: string, source: Revision, request = false): Revision | null {
    const hashes = (source.kind === "commit" ? [source.hash] : [source.from, source.to]).map(hash =>
      hash.toLowerCase(),
    );
    const resolved = hashes.map(hash => {
      const key = JSON.stringify([cwd, hash]);
      if (request && !this.answers.has(key)) {
        this.answers.set(key, null);
        let batch = this.queued.get(cwd);
        if (!batch) this.queued.set(cwd, (batch = new Set()));
        batch.add(hash);
        this.start();
      }
      return this.answers.get(key)?.hash ?? null;
    });
    if (resolved.some(hash => hash === null)) return null;
    return source.kind === "commit"
      ? { kind: "commit", hash: resolved[0]! }
      : { kind: "range", from: resolved[0]!, to: resolved[1]! };
  }
  /** A new question or reopening the prompt can follow a repository change. */
  forgetMissing(): void {
    for (const [key, value] of this.answers) if (value?.hash === null) this.answers.delete(key);
  }
  async settled(): Promise<void> {
    while (this.flight) await this.flight;
  }
  private start(): void {
    if (this.flight) return;
    this.flight = Promise.resolve()
      .then(async () => {
        while (this.queued.size) {
          const [cwd, hashes] = this.queued.entries().next().value!;
          this.queued.delete(cwd);
          let found = new Map<string, string>();
          try {
            found = await this.read(cwd, [...hashes]);
          } catch {}
          for (const hash of hashes) this.answers.set(JSON.stringify([cwd, hash]), { hash: found.get(hash) ?? null });
          // Keep pending requests, and the most recent completed lookups.
          for (const [key, value] of this.answers) {
            if (this.answers.size <= 4096) break;
            if (value !== null) this.answers.delete(key);
          }
          this.changed();
        }
      })
      .finally(() => {
        this.flight = null;
        if (this.queued.size) this.start();
      });
  }
}
