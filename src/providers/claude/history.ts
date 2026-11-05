//! Claude Code's past sessions, read from the transcripts under its
//! `projects` directory.
import { existsSync, readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SessionHistory } from "../adapter";
import { timestampMs } from "../common";
import { Cache, cached, copied, directory, readAt, records, typed, type Entry } from "../../launch/history";
import { configDir } from "./index";
function text(v: any): string | null {
  if (v.type !== "user" || v.isMeta || v.toolUseResult) return null;
  const c = v.message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c) || c.some(p => p.type !== "text")) return null;
  return c.map(p => p.text ?? "").join(" ");
}
export function entry(session: string, head: string, tail: string, mid = false, mtime = 0): Entry | null {
  const e: Entry = {
    provider: "claude",
    account: "",
    session,
    title: "",
    first: "",
    last: "",
    cwd: "",
    branch: "",
    updated_at: mtime,
    interrupted: false,
  };
  for (const v of records(head)) {
    if (v.type !== "user") continue;
    if (v.entrypoint === "sdk-cli") return null;
    if (!e.cwd) e.cwd = v.cwd ?? "";
    const t = text(v);
    if (t !== null && typed(t)) {
      e.first = t;
      break;
    }
  }
  let title = "",
    named = "",
    renamed = "";
  const lines = records(tail, mid);
  for (const v of lines) {
    switch (v.type) {
      case "continued-in":
        return null;
      case "ai-title":
        title = v.aiTitle ?? "";
        break;
      case "agent-name":
        named = v.agentName ?? "";
        break;
      case "custom-title":
        renamed = v.customTitle ?? "";
        break;
      case "user": {
        if (v.entrypoint === "sdk-cli") return null;
        if (v.gitBranch) e.branch = v.gitBranch;
        if (!e.cwd) e.cwd = v.cwd ?? "";
        const t = text(v);
        if (t === null) break;
        if (t.replace(/^[ \n\t]+/, "").startsWith("[Request interrupted")) e.interrupted = true;
        else if (typed(t)) {
          e.last = t;
          e.interrupted = false;
        }
        break;
      }
    }
  }
  if (!e.cwd) return null;
  e.title = renamed || named || title;
  // Live sessions touch their transcripts hourly, so the file's time says little.
  for (let i = lines.length - 1; i >= 0; i--) {
    const v = lines[i];
    if (v.type !== "user" && v.type !== "assistant") continue;
    const time = timestampMs(v.timestamp ?? "");
    if (time !== null) {
      e.updated_at = Math.floor(time / 1000);
      break;
    }
  }
  return e;
}
async function read(path: string, s: any): Promise<Entry | null> {
  const head = await readAt(path, 0, Math.min(s.size, 128 * 1024));
  let span = 65536;
  for (;;) {
    const start = Math.max(0, s.size - span),
      tail = await readAt(path, start, s.size - start),
      e = entry(basename(path, ".jsonl"), head, tail, start > 0, Math.floor(s.mtimeMs / 1000));
    if (!e) return null;
    if (!e.last && start > 0 && span < 2 * 1024 * 1024) {
      span *= 2;
      continue;
    }
    e.last ||= e.first;
    e.first ||= e.last;
    return e.first ? copied(e) : null;
  }
}
/** Where `session`'s transcript is in `account`, "" for the default; ""
 * when no project folder holds it. */
export function locate(session: string, account = ""): string {
  if (!/^[0-9A-Za-z-]+$/.test(session)) return "";
  const projects = join(account || configDir(), "projects");
  try {
    for (const project of readdirSync(projects, { withFileTypes: true })) {
      const path = join(projects, project.name, `${session}.jsonl`);
      if (project.isDirectory() && existsSync(path)) return path;
    }
  } catch {}
  return "";
}
/** The sessions of `account`, "" for the default. */
export function open(account = ""): SessionHistory {
  const cache = new Cache(),
    projects = () => join(account || configDir(), "projects"),
    readIn = async (path: string, s: any) => {
      const e = await read(path, s);
      return e && { ...e, account };
    },
    transcripts = async (folder: string) => {
      const found: Entry[] = [];
      for (const f of await readdir(folder, { withFileTypes: true })) {
        if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
        const e = await cached(cache, join(folder, f.name), readIn);
        if (e) found.push(e);
      }
      return found;
    };
  return {
    roots: () => [projects()],
    async list() {
      const sessions: Entry[] = [];
      try {
        for (const project of await readdir(projects(), { withFileTypes: true }))
          if (project.isDirectory()) sessions.push(...(await transcripts(join(projects(), project.name))));
        return { sessions, complete: true };
      } catch (e) {
        return { sessions, complete: (e as any).code === "ENOENT" };
      } finally {
        cache.sweep();
      }
    },
    async changed(paths, store) {
      for (const path of paths) {
        if (path.endsWith(".jsonl")) {
          const e = await cached(cache, path, readIn);
          if (!e) store.remove("claude", basename(path, ".jsonl"));
          else if (await directory(e.cwd)) store.put(e);
        } else
          try {
            for (const e of await transcripts(path)) store.put(e);
          } catch {}
      }
    },
    close() {},
  };
}
