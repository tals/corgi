//! The Corgi prompt's memory, plain Markdown as OpenClaw keeps it: MEMORY.md
//! is curated and always loaded, YYYY-MM-DD.md are append-only daily logs
//! (today's and yesterday's loaded), and workspaces/<name>.md is loaded in
//! that workspace. Each loads capped, its oldest lines dropped first.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import * as accounts from "./accounts";
import { matches } from "./search";

/** A line as a file holds it, and the file. */
export type Written = { file: string; line: string };
/** A line a search found: its file relative to the memory folder, its line
 * number from 1, and its text without the "- ". */
export type Hit = { file: string; line: number; text: string };
/** A memory file as the viewer lists it: its non-blank lines by line number,
 * without their "- ", and whether the model starts with it loaded. */
export type Group = {
  file: string;
  title: string;
  loaded: boolean;
  lines: { at: number; text: string }[];
};
/** Bytes each file loads at most, as OpenClaw's: MEMORY.md nearly whole,
 * each recent log a little, the two logs together a little more. */
export const caps = { long: 20_000, day: 1200, days: 2800, workspace: 2048 };
/** A log line recalled this often, on this many days, moves to MEMORY.md;
 * the lines moved there take this many bytes at most, the oldest leaving first. */
export const promotion = { recalls: 3, days: 2, bytes: 10_000 };
const long_name = "MEMORY.md";
const recalls_name = ".recalls.json";
const daily = /^(\d{4})-(\d{2})-(\d{2})\.md$/;
/** The turn a conversation gets before it's let go, OpenClaw's memory flush. */
export const flush =
  "Memory flush: this conversation is ending. Store anything from it worth keeping in today's log, " +
  'with `corgi memory add "<line>"`, one self-contained line each. Treat MEMORY.md as read-only now ' +
  "and append only what isn't stored yet. If nothing needs storing, reply with NO_REPLY.";
/** How often each log line came back from a search, and on which days;
 * when one moved to MEMORY.md. */
type Recalls = {
  lines: Record<string, { n: number; days: string[] }>;
  promoted: { text: string; on: string }[];
};

export class Memory {
  constructor(readonly dir: string) {}
  /** Beside accounts.json, under the base state directory every environment shares. */
  static root(): string {
    return join(dirname(accounts.path()), "memory");
  }
  /** What the model starts with: MEMORY.md, yesterday's and today's logs and
   * the workspace's note, each under a heading, and their loaded lines. */
  load(workspace: string | null, now: Date): { text: string; files: { name: string; lines: number }[] } {
    // Each says when older lines didn't fit, so the model knows to search for them.
    const section = (name: string, heading: string, cap: number) => {
      const all = read(join(this.dir, name))
          .split("\n")
          .filter(line => line.trim()).length,
        lines = tail(read(join(this.dir, name)), cap),
        left = all - lines.length,
        note = left ? ` (${left} older line${left === 1 ? "" : "s"} not loaded; search for them)` : "";
      return {
        name,
        lines,
        text: `## ${heading}${note}\n${lines.join("\n")}`,
        bytes: lines.reduce((n, line) => n + Buffer.byteLength(line) + 1, 0),
      };
    };
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1),
      note = workspace === null ? "" : noteName(workspace),
      // Today's log first: yesterday's has what the two may take that today's left.
      today = section(`${day(now)}.md`, `${day(now)} (today)`, caps.day),
      shown = [
        section(long_name, long_name, caps.long),
        section(`${day(yesterday)}.md`, `${day(yesterday)} (yesterday)`, Math.min(caps.day, caps.days - today.bytes)),
        today,
        ...(note ? [section(join("workspaces", note), `Workspace ${workspace}`, caps.workspace)] : []),
      ].filter(s => s.lines.length);
    return {
      text: shown.map(s => s.text).join("\n\n"),
      files: shown.map(s => ({ name: s.name, lines: s.lines.length })),
    };
  }
  /** Counts the log lines a search brought back, by day, for `dream`. */
  recall(hits: Hit[], now: Date): void {
    const logs = hits.filter(h => daily.test(h.file));
    if (!logs.length) return;
    const recalls = this.recalls(),
      today = day(now);
    for (const h of logs) {
      const seen = (recalls.lines[`${h.file}\t${h.text}`] ??= { n: 0, days: [] });
      seen.n++;
      if (!seen.days.includes(today)) seen.days = [...seen.days, today].slice(-30);
    }
    this.keep(recalls);
  }
  /** OpenClaw's dreaming, kept small: a log line that searches keep bringing
   * back moves to MEMORY.md, where the model starts with it. The lines moved
   * there stay under a cap, the oldest leaving first. Returns the lines moved. */
  dream(now: Date): string[] {
    const recalls = this.recalls(),
      long = join(this.dir, long_name),
      moved: string[] = [];
    for (const [key, seen] of Object.entries(recalls.lines)) {
      if (seen.n < promotion.recalls || seen.days.length < promotion.days) continue;
      const [file, text] = key.split("\t");
      delete recalls.lines[key];
      // A line edited or gone since, or in MEMORY.md already, stays as it is.
      if (
        !read(join(this.dir, file))
          .split("\n")
          .some(l => clean(l) === text)
      )
        continue;
      if (
        read(long)
          .split("\n")
          .some(l => clean(l) === text)
      )
        continue;
      this.append(long, text);
      recalls.promoted.push({ text, on: day(now) });
      moved.push(text);
    }
    let size = recalls.promoted.reduce((n, p) => n + Buffer.byteLength(p.text) + 3, 0);
    while (size > promotion.bytes && recalls.promoted.length) {
      const oldest = recalls.promoted.shift()!;
      size -= Buffer.byteLength(oldest.text) + 3;
      this.strike([{ file: long, line: `- ${oldest.text}` }]);
    }
    this.keep(recalls);
    return moved;
  }
  private recalls(): Recalls {
    try {
      const v = JSON.parse(read(join(this.dir, recalls_name)) || "{}");
      return {
        lines: v.lines && typeof v.lines === "object" ? v.lines : {},
        promoted: Array.isArray(v.promoted) ? v.promoted : [],
      };
    } catch {
      return { lines: {}, promoted: [] };
    }
  }
  private keep(recalls: Recalls): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, recalls_name), JSON.stringify(recalls));
  }
  /** The prompt's system instructions: who Corgi is, what it remembers,
   * where it was opened, and where it may write. */
  instructions(loaded: string, context: string, now: Date): string {
    return [
      "You are Corgi, a terse, helpful assistant living in the user's terminal multiplexer. " +
        "You know the coding agents they run in it and what each is doing. " +
        `Answer in a few short lines. Today is ${day(now)}.`,
      loaded && `# Memory\n\n${loaded}`,
      context && `# Context\n\n${context}`,
      [
        "# Memory Recall",
        `Your memory is Markdown in ${this.dir}: MEMORY.md (curated lasting facts and decisions), ` +
          "YYYY-MM-DD.md (daily logs) and workspaces/<name>.md. MEMORY.md, today's and yesterday's logs " +
          "and this workspace's note are loaded above; older logs are not.",
        "When an answer depends on prior work, decisions, dates, people, preferences, or todos not already " +
          "present in the current turn, run `corgi memory search <words>`; for hits, use " +
          "`corgi memory get FILE:LINE` to pull only the needed lines. Do not repeat memory retrieval when " +
          "supplied context fully answers the question. If low confidence after search, say you checked.",
        "# Writing memory",
        "Mental notes do not survive a restart: write concrete updates, never empty placeholders. Asked to " +
          'remember something, add it to today\'s log with `corgi memory add "<one self-contained line>"`, ' +
          "or to the relevant workspace's note with `--workspace NAME`. Capture decisions, context, and " +
          "things to remember. Skip secrets unless asked to keep them. When a preference or fact changes, " +
          "supersede the old line with `--replaces FILE:LINE` rather than adding one that contradicts it; " +
          "`corgi memory forget FILE:LINE` drops one.",
        "MEMORY.md is curated: change it (`--long`) only when the user asks you to curate memory. Log lines " +
          "that searches keep finding move there on their own.",
        "These commands only read and write the memory folder, and run without asking.",
      ].join("\n"),
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  /** Appends `- line` to MEMORY.md or today's log; returns the file and the
   * line as written, "" when there was nothing to write. */
  remember(line: string, now: Date, where: "long" | "today"): Written {
    return this.append(where === "long" ? join(this.dir, long_name) : this.today(now), line);
  }
  /** Lines holding every word, newest first: daily logs by date, the
   * others by when they changed, each file's last line first. `file` is
   * relative to the memory folder; `line` drops its "- ". */
  find(words: string): { file: string; line: string }[] {
    if (!words.trim()) return [];
    const out: { file: string; line: string }[] = [];
    for (const file of this.files()) {
      const lines = read(file).split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = clean(lines[i]);
        if (line && matches(words, line)) out.push({ file: relative(this.dir, file), line });
      }
    }
    return out;
  }
  /** Lines holding the most of `words`, a file's name counting as part of
   * each of its lines: every word first, any one only when no line holds them
   * all. MEMORY.md and the workspace notes come before the logs, newest
   * first, and each file's last lines before its first. */
  search(words: string): Hit[] {
    const terms = words.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const scored: { hit: Hit; matched: number }[] = [];
    for (const file of this.ordered()) {
      const name = relative(this.dir, file),
        lines = read(file).split("\n");
      for (let at = lines.length - 1; at >= 0; at--) {
        const text = clean(lines[at]),
          hay = `${name} ${text}`.toLowerCase(),
          matched = terms.filter(t => hay.includes(t)).length;
        if (text && matched) scored.push({ hit: { file: name, line: at + 1, text }, matched });
      }
    }
    const all = scored.filter(s => s.matched === terms.length);
    return (all.length ? all : scored.sort((a, b) => b.matched - a.matched)).map(s => s.hit);
  }
  /** Each file with its lines and whether the model starts with it loaded,
   * in `groups`' order. */
  list(now: Date, workspace: string | null): { file: string; lines: number; loaded: string }[] {
    const today = this.today(now);
    return this.groups(now, workspace)
      .filter(g => g.lines.length || g.file !== today)
      .map(g => ({
        file: relative(this.dir, g.file),
        lines: g.lines.length,
        loaded: !g.loaded
          ? ""
          : g.title === "Today" || g.title === "Yesterday"
            ? `loaded (${g.title.toLowerCase()})`
            : "loaded",
      }));
  }
  /** Up to `count` lines of `name`, a file in the memory folder, from line
   * `from`; `next` is the line after them when the file goes on. */
  excerpt(name: string, from = 1, count = 120): { lines: { n: number; text: string }[]; next: number | null } {
    const all = read(this.resolve(name)).split("\n");
    if (all.at(-1) === "") all.pop();
    const start = Math.max(1, from),
      lines = all.slice(start - 1, start - 1 + count).map((text, i) => ({ n: start + i, text }));
    return { lines, next: start - 1 + count < all.length ? start + count : null };
  }
  /** Writes `text` as one line: to today's log, MEMORY.md, or a workspace's
   * note. With `replaces`, the old line goes: rewritten in place, or with
   * `moved`, dropped there and the new one written where asked. Nothing is
   * written when the line is in that file or MEMORY.md already. */
  add(
    text: string,
    where: "today" | "long" | { workspace: string },
    now: Date,
    replaces: { file: string; line: number; moved?: boolean } | null = null,
  ): { status: "added" | "already" | "replaced"; file: string; line: number } {
    const line = clean(text);
    if (!line) throw Error("EmptyLine");
    if (replaces) {
      const file = this.resolve(replaces.file),
        lines = read(file).split("\n"),
        at = replaces.line - 1;
      if (at < 0 || at >= lines.length || !lines[at].trim()) throw Error("NoSuchLine");
      if (!replaces.moved) {
        lines[at] = `- ${line}`;
        writeFileSync(file, lines.join("\n"));
        return { status: "replaced", file: replaces.file, line: replaces.line };
      }
      lines.splice(at, 1);
      writeFileSync(file, lines.join("\n"));
    }
    const long = join(this.dir, long_name),
      file =
        where === "today"
          ? this.today(now)
          : where === "long"
            ? long
            : join(this.dir, "workspaces", noteName(where.workspace) || "_.md");
    for (const f of new Set([file, long])) {
      const at = read(f)
        .split("\n")
        .findIndex(l => clean(l) === line);
      if (at >= 0) return { status: "already", file: relative(this.dir, f), line: at + 1 };
    }
    this.append(file, line);
    return {
      status: replaces ? "replaced" : "added",
      file: relative(this.dir, file),
      line: read(file).split("\n").length - 1,
    };
  }
  /** Drops line `line` of `name`, a file in the memory folder; the text it held. */
  forgetLine(name: string, line: number): string {
    const file = this.resolve(name),
      lines = read(file).split("\n"),
      at = line - 1;
    if (at < 0 || at >= lines.length || !lines[at].trim()) throw Error("NoSuchLine");
    const [gone] = lines.splice(at, 1);
    writeFileSync(file, lines.join("\n"));
    return clean(gone);
  }
  /** A file named relative to the memory folder, which it must stay in. */
  private resolve(name: string): string {
    const file = join(this.dir, name);
    if (!name.endsWith(".md") || !this.inside(file)) throw Error("NotInMemory");
    return file;
  }
  /** MEMORY.md, the workspace notes, then the logs newest first. */
  private ordered(): string[] {
    const files = this.files(),
      long = join(this.dir, long_name);
    return [
      ...files.filter(f => f === long),
      ...files.filter(f => dirname(f) !== this.dir),
      ...files.filter(f => dirname(f) === this.dir && f !== long),
    ];
  }
  /** Drops one line, matched with or without its "- ", newest file first. */
  forget(line: string): boolean {
    return this.drop([line]) > 0;
  }
  /** Drops each written line once, from its own file, only while it reads
   * exactly as written: /forgetmenow. Returns the ones it didn't find. */
  strike(lines: Written[]): Written[] {
    const missed: Written[] = [],
      files = new Map<string, string[]>();
    for (const w of lines) {
      if (!w.line.trim() || !this.inside(w.file)) {
        missed.push(w);
        continue;
      }
      const left = files.get(w.file) ?? read(w.file).split("\n");
      const at = left.findIndex(line => line.trimEnd() === w.line.trimEnd());
      if (at < 0) missed.push(w);
      else left.splice(at, 1);
      files.set(w.file, left);
    }
    for (const [file, left] of files) if (left.join("\n") !== read(file)) writeFileSync(file, left.join("\n"));
    return missed;
  }
  /** Whether `path` is in the memory folder once links are followed, so
   * edits there need no approval. */
  inside(path: string): boolean {
    const root = real(this.dir),
      target = real(path);
    return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
  }
  /** Today's log, by local date. */
  today(now: Date): string {
    return join(this.dir, `${day(now)}.md`);
  }
  /** Every memory file for the viewer: MEMORY.md and today's log even
   * while empty, so lines can be added there, then the workspace notes,
   * then the older logs, newest first. */
  groups(now: Date, workspace: string | null): Group[] {
    const lines = (file: string) =>
        read(file)
          .split("\n")
          .flatMap((raw, at) => (raw.trim() ? [{ at, text: clean(raw) }] : [])),
      yesterday = day(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)),
      today = this.today(now),
      note = workspace === null ? "" : noteName(workspace);
    const out: Group[] = [
      { file: join(this.dir, long_name), title: long_name, loaded: true, lines: lines(join(this.dir, long_name)) },
      { file: today, title: "Today", loaded: true, lines: lines(today) },
    ];
    const notes: Group[] = [],
      logs: Group[] = [];
    for (const file of this.files()) {
      const name = basename(file);
      if (file === today || name === long_name) continue;
      if (dirname(file) !== this.dir)
        notes.push({ file, title: `Workspace ${name.slice(0, -3)}`, loaded: name === note, lines: lines(file) });
      else if (daily.test(name)) {
        const date = name.slice(0, -3),
          title = date === yesterday ? "Yesterday" : date;
        logs.push({ file, title, loaded: date === yesterday, lines: lines(file) });
      }
    }
    return [...out, ...notes, ...logs];
  }
  /** Replaces line `at` of `file` with `text`, or drops it when `text` is
   * null, only while it still reads `was`; false when it changed meanwhile. */
  edit(file: string, at: number, was: string, text: string | null): boolean {
    if (!this.inside(file)) return false;
    const lines = read(file).split("\n");
    if (at >= lines.length || clean(lines[at]) !== was) return false;
    const line = text === null ? "" : clean(text);
    if (text !== null && !line) return false;
    if (text === null) lines.splice(at, 1);
    else lines[at] = `${/^\s*[-*] /.test(lines[at]) || !lines[at].trim() ? "- " : ""}${line}`;
    writeFileSync(file, lines.join("\n"));
    return true;
  }
  /** Appends `- text` to `file`, a memory file; the line as written, "" for nothing. */
  append(file: string, text: string): Written {
    const line = clean(text);
    if (!line || !this.inside(file)) return { file, line: "" };
    mkdirSync(dirname(file), { recursive: true });
    const before = read(file);
    appendFileSync(file, `${before && !before.endsWith("\n") ? "\n" : ""}- ${line}\n`);
    return { file, line: `- ${line}` };
  }

  /** Every memory file, newest first. */
  private files(): string[] {
    const found: { path: string; time: number }[] = [];
    const scan = (dir: string) => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (!name.endsWith(".md")) continue;
        const path = join(dir, name),
          date = dir === this.dir ? daily.exec(name) : null;
        let time: number;
        if (date) time = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]) + 1).getTime() - 1;
        else
          try {
            const stat = statSync(path);
            if (!stat.isFile()) continue;
            time = stat.mtimeMs;
          } catch {
            continue;
          }
        found.push({ path, time });
      }
    };
    scan(this.dir);
    scan(join(this.dir, "workspaces"));
    return found.sort((a, b) => b.time - a.time || (a.path < b.path ? 1 : a.path > b.path ? -1 : 0)).map(f => f.path);
  }
  /** Removes each wanted line once, matched with or without its "- ", newest
   * file first; returns how many went. */
  private drop(lines: string[]): number {
    const wanted = new Map<string, number>();
    for (const line of lines) {
      const text = clean(line);
      if (text) wanted.set(text, (wanted.get(text) ?? 0) + 1);
    }
    let dropped = 0;
    for (const file of this.files()) {
      if (!wanted.size) break;
      const before = read(file).split("\n"),
        after = before.filter(line => {
          const text = clean(line),
            left = wanted.get(text);
          if (!left) return true;
          if (left === 1) wanted.delete(text);
          else wanted.set(text, left - 1);
          dropped++;
          return false;
        });
      if (after.length !== before.length) writeFileSync(file, after.join("\n"));
    }
    return dropped;
  }
}
/** A local date as its log is named: "2026-10-30". */
function day(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}
/** A workspace's note file, without folder separators or a leading dot. */
function noteName(workspace: string): string {
  const name = workspace
    .replace(/[/\\\x00-\x1f\x7f]/g, "-")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, 120);
  return name ? `${name}.md` : "";
}
/** One line as memory keeps it: whitespace collapsed, without its "- ". */
function clean(line: string): string {
  return line
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-*] +/, "");
}
function read(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
/** The last non-blank lines that fit in `cap` bytes; a newest line longer
 * than that is cut to fit. */
function tail(text: string, cap: number): string[] {
  const lines = text.split("\n").filter(line => line.trim()),
    out: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(lines[i]) + 1;
    if (used + size > cap) {
      if (!out.length)
        out.push(
          Buffer.from(lines[i])
            .subarray(0, cap - 1)
            .toString()
            .replace(/\ufffd+$/, ""),
        );
      break;
    }
    out.unshift(lines[i]);
    used += size;
  }
  return out;
}
/** `path` absolute with every link in its existing part resolved. */
function real(path: string): string {
  let head = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...rest);
    } catch {
      const up = dirname(head);
      if (up === head) return resolve(path);
      rest.unshift(basename(head));
      head = up;
    }
  }
}
