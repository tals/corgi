//! `corgi memory`: the Corgi prompt's memory for its model, as commands it
//! runs through its shell, the way OpenClaw gives its agent memory_search
//! and memory_get. They read and write only the memory folder, so the
//! prompt lets them run without asking.
import type { Memory } from "./prompt_memory";

type Ref = { file: string; line: number };
/** Lines `get` prints at most. */
const excerpt_lines = 120;

/** `FILE:LINE`, a line of a memory file, counted from 1. */
function ref(value: string | undefined): Ref {
  const m = /^(.+\.md):(\d+)$/.exec(value ?? "");
  if (!m || !Number(m[2])) throw Error("Usage");
  return { file: m[1], line: Number(m[2]) };
}
function positive(value: string | undefined): number {
  if (!/^\d+$/.test(value ?? "") || !Number(value)) throw Error("Usage");
  return Number(value);
}
/** Runs `corgi memory ARGS` on `memory`; what it prints. */
export function run(memory: Memory, args: string[], now: Date): string {
  const [verb, ...rest] = args,
    words: string[] = [];
  let limit = 8,
    long = false,
    workspace: string | null = null,
    replaces: Ref | null = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--long") long = true;
    else if (a === "--limit") limit = positive(rest[++i]);
    else if (a === "--workspace") workspace = rest[++i] || null;
    else if (a === "--replaces") replaces = ref(rest[++i]);
    else if (a === "--") {
      words.push(...rest.slice(i + 1));
      break;
    } else if (a.startsWith("--")) throw Error("Usage");
    else words.push(a);
  }
  switch (verb) {
    case "search": {
      if (!words.length) throw Error("Usage");
      const hits = memory.search(words.join(" "));
      if (!hits.length) return `No memory line holds: ${words.join(" ")}\n`;
      // Log lines brought back count toward moving them to MEMORY.md.
      const found = hits.slice(0, limit),
        more = hits.length - found.length;
      memory.recall(found, now);
      return (
        found.map(h => `${h.file}:${h.line}  ${h.text}`).join("\n") +
        (more ? `\n(+${more} more; --limit ${hits.length} shows them)` : "") +
        "\n"
      );
    }
    case "get": {
      if (words.length > 1) throw Error("Usage");
      if (!words.length) {
        const files = memory.list(now, workspace),
          width = Math.max(0, ...files.map(f => f.file.length));
        const count = (n: number) => `${String(n).padStart(3)} line${n === 1 ? " " : "s"}`;
        return files.map(f => `${f.file.padEnd(width)}  ${count(f.lines)}  ${f.loaded}`.trimEnd()).join("\n") + "\n";
      }
      const m = /^(.+?\.md)(?::(\d+)(?:-(\d+))?)?$/.exec(words[0]);
      if (!m) throw Error("Usage");
      const from = Number(m[2] ?? 1),
        to = m[3] ? Number(m[3]) : from + excerpt_lines - 1;
      if (!from || to < from) throw Error("Usage");
      const got = memory.excerpt(m[1], from, Math.min(to - from + 1, excerpt_lines)),
        width = String(got.lines.at(-1)?.n ?? 1).length;
      if (!got.lines.length) return `${m[1]} has no line ${from}.\n`;
      return (
        got.lines.map(l => `${String(l.n).padStart(width)}  ${l.text}`).join("\n") +
        "\n" +
        (got.next && !m[3] ? `… more: corgi memory get ${m[1]}:${got.next}\n` : "")
      );
    }
    case "add": {
      if (!words.length || (long && workspace)) throw Error("Usage");
      // Replacing a line with a file named moves it there; without one, it's rewritten in place.
      const done = memory.add(
        words.join(" "),
        long ? "long" : workspace ? { workspace } : "today",
        now,
        replaces && { ...replaces, moved: long || workspace !== null },
      );
      return `${done.status === "already" ? "already in" : done.status} ${done.file}:${done.line}\n`;
    }
    case "forget": {
      if (words.length !== 1) throw Error("Usage");
      const at = ref(words[0]);
      return `forgot ${at.file}:${at.line}: ${memory.forgetLine(at.file, at.line)}\n`;
    }
  }
  throw Error("Usage");
}
