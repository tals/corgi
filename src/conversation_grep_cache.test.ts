import { afterAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { lock, open, refresh, tryLock } from "./conversation_grep_cache";
import * as grep from "./conversation_grep";
import { roots, search, selected, type Options } from "./conversation_grep";
import { adapter } from "./providers";

const originalRead = grep.read;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corgi-grep-index-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const options: Options = {
  workspace: "/project",
  age: 0,
  patterns: ["needle"],
  case: "sensitive",
  fixed: false,
  word: false,
  line: false,
  limit: 0,
  maxCount: 3,
  context: 0,
  asOf: Date.now(),
};
const message = (text: string, role = "user") =>
  JSON.stringify({
    type: "response_item",
    timestamp: new Date().toISOString(),
    payload: { type: "message", role, content: [{ type: "input_text", text }] },
  }) + "\n";
function world(name: string) {
  const root = path.join(dir, name),
    cache = path.join(root, "cache"),
    sessions = path.join(root, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(cache);
  const locations = [{ provider: "codex" as const, root }];
  function source(id: string, cwd = "/project") {
    const file = path.join(sessions, id + ".jsonl");
    fs.writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id, cwd } }) + "\n");
    return file;
  }
  return { root, cache, locations, source };
}

test("cold and warm queries reuse the index, refresh appended records and keep line provenance", async () => {
  const w = world("reuse"),
    file = w.source("one"),
    ticks: number[] = [];
  fs.appendFileSync(file, message("# AGENTS.md instructions\nNever use this as the title"));
  fs.appendFileSync(file, message("Fix Unicode tab labels"));
  fs.appendFileSync(file, message("first needle", "assistant"));
  const unlock = await lock(w.cache);
  try {
    const first = await refresh(
      w.cache,
      options,
      async n => {
        ticks.push(n);
      },
      w.locations,
    );
    const source = first.sources[0],
      textFile = path.join(w.cache, source.file),
      before = fs.statSync(textFile).mtimeMs;
    expect(source.title).toBe("Fix Unicode tab labels");
    expect(ticks.length).toBeGreaterThan(0);
    await Bun.sleep(5);
    const warm = await refresh(w.cache, options, undefined, w.locations);
    expect(warm).toMatchObject({ refreshed: 0, reused: 1 });
    expect(fs.statSync(textFile).mtimeMs).toBe(before);
    const [found] = (await search(w.cache, selected(warm, options), options))[0].hits;
    expect(found).toMatchObject({ text: "first needle", ref: "4", role: "assistant" });
    // The hit's line in the cache file is its whole message.
    expect(JSON.parse(fs.readFileSync(textFile, "utf8").split("\n")[found.line - 1])).toEqual({
      role: "assistant",
      timestamp: expect.any(Number),
      ref: "4",
      text: "first needle",
    });
    fs.appendFileSync(file, message("second needle", "assistant"));
    const appended = await refresh(w.cache, options, undefined, w.locations);
    expect(appended).toMatchObject({ refreshed: 1, reused: 0 });
    const hits = (await search(w.cache, selected(appended, options), options))[0].hits;
    expect(hits.map(h => [h.text, h.ref])).toEqual([
      ["first needle", "4"],
      ["second needle", "5"],
    ]);
    expect(fs.statSync(textFile).mtimeMs).toBeGreaterThan(before);
  } finally {
    unlock();
  }
});

test("a transcript that only grew is read on from where indexing stopped; one rewritten or replaced is read whole", async () => {
  const w = world("grown"),
    file = w.source("one");
  fs.appendFileSync(file, message("Grown title"));
  fs.appendFileSync(file, message("first needle", "assistant"));
  const unlock = await lock(w.cache),
    read = spyOn(grep, "read");
  const hits = async () => {
    const index = await refresh(w.cache, options, undefined, w.locations);
    return (await search(w.cache, selected(index, options), options))[0]?.hits.map(h => [h.text, h.ref]) ?? [];
  };
  try {
    expect(await hits()).toEqual([["first needle", "3"]]);
    expect(read).toHaveBeenCalledTimes(1);
    // A live agent writes on, stopping mid-record, then finishes it.
    const next = message("second needle", "assistant");
    fs.appendFileSync(file, message("more needle") + next.slice(0, 10));
    expect(await hits()).toEqual([
      ["first needle", "3"],
      ["more needle", "4"],
    ]);
    fs.appendFileSync(file, next.slice(10));
    const index = await refresh(w.cache, options, undefined, w.locations);
    expect((await search(w.cache, selected(index, options), options))[0].hits.map(h => [h.text, h.ref])).toEqual([
      ["first needle", "3"],
      ["more needle", "4"],
      ["second needle", "5"],
    ]);
    expect(index.sources[0].title).toBe("Grown title");
    expect(read).toHaveBeenCalledTimes(1);
    // Rewritten shorter: what was read isn't all there, so the whole is read again.
    const lines = fs.readFileSync(file, "utf8").split("\n");
    fs.writeFileSync(file, lines.slice(0, 3).join("\n") + "\n");
    expect(await hits()).toEqual([["first needle", "3"]]);
    expect(read).toHaveBeenCalledTimes(2);
    // Replaced by another file under the name: a new inode is read whole too.
    const swap = file + ".swap";
    fs.writeFileSync(swap, fs.readFileSync(file, "utf8") + message("swapped needle"));
    fs.renameSync(swap, file);
    expect(await hits()).toEqual([
      ["first needle", "3"],
      ["swapped needle", "4"],
    ]);
    expect(read).toHaveBeenCalledTimes(3);
  } finally {
    read.mockRestore();
    unlock();
  }
});

test("a search stopped after indexing but before saving leaves nothing to read on from twice", async () => {
  const w = world("unsaved"),
    file = w.source("one");
  fs.appendFileSync(file, message("first needle"));
  const unlock = await lock(w.cache);
  try {
    await refresh(w.cache, options, undefined, w.locations);
    // The next search stores the grown transcript, then stops before saving the index.
    fs.appendFileSync(file, message("second needle"));
    const stopped = await open(w.cache, options, undefined, w.locations);
    for (const source of stopped.sources) await stopped.update(source);
    fs.appendFileSync(file, message("third needle"));
    const index = await refresh(w.cache, options, undefined, w.locations);
    expect((await search(w.cache, selected(index, options), options))[0].hits.map(h => [h.text, h.ref])).toEqual([
      ["first needle", "2"],
      ["second needle", "3"],
      ["third needle", "4"],
    ]);
  } finally {
    unlock();
  }
});

test("a conversation indexed before anyone spoke is named by the first to speak once it's read on", async () => {
  const w = world("unnamed"),
    file = w.source("one");
  fs.appendFileSync(file, message("needle warming up", "assistant"));
  const unlock = await lock(w.cache),
    read = spyOn(grep, "read");
  try {
    let index = await refresh(w.cache, options, undefined, w.locations);
    await search(w.cache, selected(index, options), options);
    expect(index.sources[0].title).toBe("");
    fs.appendFileSync(file, message("Name it later") + message("needle again", "assistant"));
    index = await refresh(w.cache, options, undefined, w.locations);
    await search(w.cache, selected(index, options), options);
    expect(index.sources[0].title).toBe("Name it later");
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    read.mockRestore();
    unlock();
  }
});

test("a pattern that looks for nothing around it still finds a message's later lines", async () => {
  const w = world("lookaround"),
    file = w.source("one");
  fs.appendFileSync(file, message("other\nneedle\nother"));
  const unlock = await lock(w.cache);
  try {
    for (const pattern of ["(?<!.)needle", "(?=(.*))\\1(?<=needle)"]) {
      const query = { ...options, patterns: [pattern] },
        index = await refresh(w.cache, query, undefined, w.locations);
      expect((await search(w.cache, selected(index, query), query))[0]?.hits.map(h => h.text)).toEqual(["needle"]);
    }
  } finally {
    unlock();
  }
});

test("a place an older writer left behind its stamp isn't read on from", async () => {
  const w = world("mixed"),
    file = w.source("one");
  fs.appendFileSync(file, message("first needle"));
  const unlock = await lock(w.cache),
    index = path.join(w.cache, "index.json");
  try {
    await refresh(w.cache, options, undefined, w.locations);
    const stale = JSON.parse(fs.readFileSync(index, "utf8")).sources[0].indexed_end;
    // An older Corgi indexes the grown transcript whole, keeping the field it doesn't know.
    fs.appendFileSync(file, message("second needle"));
    await refresh(w.cache, options, undefined, w.locations);
    const manifest = JSON.parse(fs.readFileSync(index, "utf8"));
    manifest.sources[0].indexed_end = stale;
    fs.writeFileSync(index, JSON.stringify(manifest));
    fs.appendFileSync(file, message("third needle"));
    const read = spyOn(grep, "read");
    try {
      const grown = await refresh(w.cache, options, undefined, w.locations);
      expect(read).toHaveBeenCalledTimes(1);
      expect((await search(w.cache, selected(grown, options), options))[0].hits.map(h => h.text)).toEqual([
        "first needle",
        "second needle",
        "third needle",
      ]);
    } finally {
      read.mockRestore();
    }
  } finally {
    unlock();
  }
});

test("scope skips other content, tools are lazy, and a partial last record becomes searchable", async () => {
  const w = world("scope"),
    file = w.source("one"),
    other = w.source("other", "/project-other");
  fs.appendFileSync(file, message("Branch recovery"));
  const tool =
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "git switch needle-branch" }),
      },
    }) + "\n";
  fs.appendFileSync(file, tool);
  const tail = message("needle-final", "assistant");
  fs.appendFileSync(file, tail.slice(0, -2));
  fs.appendFileSync(other, message("unrelated needle"));
  const plain = await refresh(w.cache, options, undefined, w.locations);
  expect(plain.sources.find(s => s.session === "other")?.indexed_stamp).toBeUndefined();
  expect(await search(w.cache, selected(plain, options), options)).toEqual([]);
  const tools = { ...options, tools: true };
  const withTools = await refresh(w.cache, tools, undefined, w.locations);
  expect(withTools).toMatchObject({ refreshed: 1, reused: 0 });
  const phases: string[] = [];
  const reused = await refresh(
    w.cache,
    tools,
    async (_scanned, _total, phase) => {
      phases.push(phase);
    },
    w.locations,
  );
  expect(reused).toMatchObject({ refreshed: 0, reused: 1 });
  expect(phases).not.toContain("indexing");
  expect((await search(w.cache, selected(withTools, tools), tools))[0].hits[0]).toMatchObject({
    lane: "tools",
    role: "tool",
  });
  fs.appendFileSync(file, tail.slice(-2));
  const completed = await refresh(w.cache, tools, undefined, w.locations);
  expect((await search(w.cache, selected(completed, tools), tools))[0].hits.some(h => h.text === "needle-final")).toBe(
    true,
  );
});

test("compressed archives are found, taken as written once, and leave when removed, without SQLite", async () => {
  const w = world("archive"),
    file = w.source("one");
  fs.appendFileSync(file, message("Archived needle"));
  const archived = path.join(w.root, "archived_sessions");
  fs.mkdirSync(archived);
  const compressed = path.join(archived, "one.jsonl.zst");
  fs.writeFileSync(compressed, Bun.zstdCompressSync(fs.readFileSync(file)));
  fs.unlinkSync(file);
  const first = await refresh(w.cache, options, undefined, w.locations);
  expect(first.sources).toHaveLength(1);
  expect((await search(w.cache, selected(first, options), options))[0].source.title).toBe("Archived needle");
  fs.writeFileSync(
    compressed,
    Bun.zstdCompressSync(
      JSON.stringify({ type: "session_meta", payload: { id: "two", cwd: "/project" } }) +
        "\n" +
        message("Replacement needle"),
    ),
  );
  // An archive is written once: one already seen isn't checked again, even swapped.
  expect((await refresh(w.cache, options, undefined, w.locations)).sources.map(s => s.session)).toEqual(["one"]);
  // A new one is found.
  const another = path.join(archived, "two.jsonl.zst");
  fs.renameSync(compressed, another);
  expect((await refresh(w.cache, options, undefined, w.locations)).sources.map(s => s.session)).toEqual(["two"]);
  expect(fs.existsSync(path.join(w.cache, first.sources[0].file))).toBe(false);
  fs.unlinkSync(another);
  expect((await refresh(w.cache, options, undefined, w.locations)).sources).toEqual([]);
});

test("an archive that couldn't be read is looked at again once it changes", async () => {
  const w = world("broken-archive"),
    archived = path.join(w.root, "archived_sessions");
  fs.mkdirSync(archived);
  const compressed = path.join(archived, "one.jsonl.zst");
  // Caught half written.
  fs.writeFileSync(compressed, "not zstd yet");
  const first = await refresh(w.cache, options, undefined, w.locations);
  expect(first.sources).toEqual([]);
  expect(first.ignored).toEqual([expect.objectContaining({ source: compressed, failed: true })]);
  // Unchanged, it stays left out.
  expect((await refresh(w.cache, options, undefined, w.locations)).sources).toEqual([]);
  fs.writeFileSync(
    compressed,
    Bun.zstdCompressSync(
      JSON.stringify({ type: "session_meta", payload: { id: "one", cwd: "/project" } }) + "\n" + message("Done needle"),
    ),
  );
  expect((await refresh(w.cache, options, undefined, w.locations)).sources.map(s => s.session)).toEqual(["one"]);
});

test("a transcript that can't be read is skipped with a warning until it changes, and the rest still search", async () => {
  const w = world("unreadable"),
    good = w.source("good"),
    gone = w.source("gone");
  fs.appendFileSync(good, message("Good needle"));
  fs.appendFileSync(gone, message("Lost needle"));
  // Deleted between discovery and its read.
  const read = spyOn(grep, "read");
  read.mockImplementation(async (source, ...rest) => {
    if (source.session === "gone") throw Object.assign(Error("ENOENT: no such file"), { code: "ENOENT" });
    return originalRead(source, ...rest);
  });
  try {
    const first = await refresh(w.cache, options, undefined, w.locations);
    expect(first.warnings.some(line => line.startsWith(`Unreadable transcript skipped: ${gone}`))).toBe(true);
    expect(first.sources.map(s => s.session)).toEqual(["good"]);
    expect((await search(w.cache, selected(first, options), options)).map(r => r.source.session)).toEqual(["good"]);
    expect(await refresh(w.cache, options, undefined, w.locations)).toMatchObject({ refreshed: 0, reused: 1 });
  } finally {
    read.mockRestore();
  }
});

test("a transcript that won't decode is skipped until it changes, and the rest of its account still counts", async () => {
  const w = world("corrupt"),
    good = w.source("good");
  fs.appendFileSync(good, message("good needle"));
  const archived = path.join(w.root, "archived_sessions");
  fs.mkdirSync(archived);
  const broken = path.join(archived, "broken.jsonl.zst");
  fs.writeFileSync(broken, Buffer.from(Array.from({ length: 200 }, (_, i) => (i * 37) % 256)));
  const first = await refresh(w.cache, options, undefined, w.locations);
  expect(first.sources.map(s => s.session)).toEqual(["good"]);
  expect(first.warnings.filter(line => line.startsWith(`Unreadable transcript skipped: ${broken}`))).toHaveLength(1);
  const second = await refresh(w.cache, options, undefined, w.locations);
  expect(second.sources.map(s => s.session)).toEqual(["good"]);
  expect(second.warnings).toEqual([]);
});

test("a folder its provider fails to read keeps its conversations and their cache files", async () => {
  const w = world("failing"),
    file = w.source("one");
  fs.appendFileSync(file, message("kept needle"));
  const first = await refresh(w.cache, options, undefined, w.locations);
  const cached = path.join(w.cache, first.sources[0].file);
  const search = await adapter("codex").search!();
  const discover = spyOn(search, "discover").mockImplementation(async () => {
    throw Error("EIO: i/o error");
  });
  try {
    const failed = await refresh(w.cache, options, undefined, w.locations);
    expect(failed.sources.map(s => s.session)).toEqual(["one"]);
    expect(failed.warnings[0]).toContain("codex conversations in");
    expect(fs.existsSync(cached)).toBe(true);
  } finally {
    discover.mockRestore();
  }
});

test("a search indexes changed transcripts as it reaches them, newest first, and stops at its limit", async () => {
  const w = world("stream"),
    older = w.source("older"),
    newer = w.source("newer");
  fs.appendFileSync(older, message("older needle"));
  fs.appendFileSync(newer, message("newer needle"));
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(older, past, past);
  const events: string[] = [];
  const watched = (session: Awaited<ReturnType<typeof open>>, limit: number) =>
    search(w.cache, session.sources, {
      ...options,
      limit,
      open: async source => {
        events.push(`open ${source.session}`);
        return session.messages(source);
      },
      found: async match => {
        events.push(`found ${match.source.session}`);
        return true;
      },
    });
  const first = await open(w.cache, options, undefined, w.locations);
  expect(first.sources.map(s => s.session)).toEqual(["newer", "older"]);
  expect((await watched(first, 1)).map(m => m.hits[0].text)).toEqual(["newer needle"]);
  first.save();
  // The newest match is reported before anything older is read.
  expect(events).toEqual(["open newer", "found newer"]);
  const second = await open(w.cache, options, undefined, w.locations);
  expect(second.manifest.reused).toBe(1);
  expect(second.sources.find(s => s.session === "older")?.indexed_stamp).toBeUndefined();
  events.length = 0;
  expect((await watched(second, 0)).map(m => m.hits[0].text)).toEqual(["newer needle", "older needle"]);
  second.save();
  expect(events).toEqual(["open newer", "found newer", "open older", "found older"]);
  expect(await refresh(w.cache, options, undefined, w.locations)).toMatchObject({ refreshed: 0, reused: 2 });
});

test("a changed transcript is left out once indexing shows its last message is older than --max-age", async () => {
  const w = world("age"),
    file = w.source("stale");
  fs.appendFileSync(
    file,
    JSON.stringify({
      type: "response_item",
      timestamp: new Date(Date.now() - 10 * 86400000).toISOString(),
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "old needle" }] },
    }) + "\n",
  );
  // Written just now, so its file time puts it in scope until it's read.
  const recent = { ...options, age: 86400000, asOf: Date.now() };
  const session = await open(w.cache, recent, undefined, w.locations);
  expect(session.sources).toHaveLength(1);
  expect(await search(w.cache, session.sources, { ...recent, open: session.messages })).toEqual([]);
  session.save();
  expect(fs.existsSync(path.join(w.cache, session.sources[0].file))).toBe(true);
  expect((await open(w.cache, recent, undefined, w.locations)).sources).toEqual([]);
});

test("a search that finds the index locked reads changed transcripts itself and writes nothing", async () => {
  const w = world("readonly"),
    file = w.source("one");
  fs.appendFileSync(file, message("indexed needle"));
  await refresh(w.cache, options, undefined, w.locations);
  const index = fs.readFileSync(path.join(w.cache, "index.json"), "utf8");
  fs.appendFileSync(file, message("unindexed needle", "assistant"));
  const holder = await tryLock(w.cache);
  expect(holder).not.toBeNull();
  try {
    expect(await tryLock(w.cache)).toBeNull();
    const session = await open(w.cache, options, undefined, w.locations, true);
    const [match] = await search(w.cache, session.sources, { ...options, open: session.messages });
    expect(match.hits.map(h => h.text)).toEqual(["indexed needle", "unindexed needle"]);
    session.save();
    expect(fs.readFileSync(path.join(w.cache, "index.json"), "utf8")).toBe(index);
    expect(fs.readFileSync(path.join(w.cache, session.sources[0].file), "utf8")).not.toContain("unindexed");
  } finally {
    holder!();
  }
  const release = await tryLock(w.cache);
  expect(release).not.toBeNull();
  release!();
});

test("concurrent searches wait for the index lock and reuse it after release", async () => {
  const w = world("lock"),
    release = await lock(w.cache);
  let acquired = false;
  const pending = lock(w.cache).then(release => {
    acquired = true;
    return release;
  });
  await Bun.sleep(80);
  expect(acquired).toBe(false);
  release();
  const secondRelease = await pending;
  expect(acquired).toBe(true);
  secondRelease();
});

test("a search covers the workspace's folder and its other folders, nothing beside them", () => {
  const at = (cwd: string) => ({ cwd, updated_at: 1, key: cwd, provider: "codex", session: cwd }) as any;
  const manifest = { sources: ["/repo", "/repo/sub", "/repo-fix", "/repo-fixes", "/other"].map(at) } as any;
  const chosen = selected(manifest, { ...options, workspace: "/repo", folders: ["/repo-fix"] });
  expect(chosen.map(s => s.cwd).sort()).toEqual(["/repo", "/repo-fix", "/repo/sub"]);
});

test("an account's environment adds its folder to the default ones, and a listed folder keeps its provider", async () => {
  const home = path.join(dir, "roots");
  for (const d of [".claude", ".codex", "claude-work", "omp-work", "state/corgi"])
    fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.writeFileSync(
    path.join(home, "state/corgi/accounts.json"),
    JSON.stringify({ accounts: [{ provider: "omp", dir: path.join(home, "omp-work") }] }),
  );
  const env = {
      XDG_STATE_HOME: path.join(home, "state"),
      CLAUDE_CONFIG_DIR: path.join(home, "claude-work"),
      PI_CODING_AGENT_DIR: path.join(home, "omp-work"),
    },
    real = fs.realpathSync(home);
  expect((await roots(env, home)).map(r => [r.provider, path.relative(real, r.root)])).toEqual([
    ["codex", ".codex"],
    ["claude", ".claude"],
    ["omp", "omp-work"],
    ["claude", "claude-work"],
  ]);
});

test("a conversation decoded by an older version is indexed again when a search reaches it", async () => {
  const w = world("decoding"),
    file = w.source("one");
  fs.appendFileSync(file, message("decoded needle"));
  const first = await refresh(w.cache, { ...options, tools: true }, undefined, w.locations);
  expect(first.sources[0]).toMatchObject({ indexed_version: "1.1", tools_version: "1.1" });
  const index = path.join(w.cache, "index.json"),
    saved = JSON.parse(fs.readFileSync(index, "utf8"));
  Object.assign(saved.sources[0], { indexed_version: "1.0", tools_version: "1.0" });
  fs.writeFileSync(index, JSON.stringify(saved));
  expect(await refresh(w.cache, options, undefined, w.locations)).toMatchObject({ refreshed: 1 });
  // Its tool calls were written by the older version too.
  const tools = { ...options, tools: true };
  expect(await refresh(w.cache, tools, undefined, w.locations)).toMatchObject({ refreshed: 1 });
  expect(await refresh(w.cache, tools, undefined, w.locations)).toMatchObject({ refreshed: 0 });
});

test("a search repairs cache files that are gone, cut short or don't parse, and an index it can't read", async () => {
  const w = world("heal"),
    names = ["gone", "empty", "garbled", "kept"];
  for (const name of names) fs.appendFileSync(w.source(name), message(`${name} needle`) + message("more", "assistant"));
  const index = path.join(w.cache, "index.json");
  const found = async (readOnly = false) => {
    const session = await open(w.cache, options, undefined, w.locations, readOnly);
    const matches = await search(w.cache, session.sources, { ...options, open: session.messages });
    session.save();
    return { hits: matches.map(m => m.hits[0].text).sort(), manifest: session.manifest };
  };
  const all = names.map(name => `${name} needle`).sort();
  const first = await found();
  expect(first.hits).toEqual(all);
  const file = (name: string) => path.join(w.cache, first.manifest.sources.find(s => s.session === name)!.file);
  const kept = fs.statSync(file("kept")).mtimeMs;
  const damage = () => {
    fs.rmSync(file("gone"));
    fs.writeFileSync(file("empty"), "");
    fs.writeFileSync(file("garbled"), '{"role":"user","text":"gar');
  };
  // Without the lock, the transcripts are read for this search and nothing is written.
  damage();
  expect((await found(true)).hits).toEqual(all);
  expect(fs.existsSync(file("gone"))).toBe(false);
  // With it, they're indexed again, and only they are.
  const healed = await found();
  expect(healed.hits).toEqual(all);
  expect(healed.manifest.refreshed).toBe(3);
  expect(fs.statSync(file("kept")).mtimeMs).toBe(kept);
  expect(await found()).toMatchObject({ hits: all, manifest: { refreshed: 0 } });
  // An index that's empty, cut short or not an index is indexed afresh.
  const good = fs.readFileSync(index, "utf8");
  for (const bad of ["", good.slice(0, good.length / 2), JSON.stringify({ index_version: 1, sources: "none" })]) {
    fs.writeFileSync(index, bad);
    expect(await found()).toMatchObject({ hits: all, manifest: { refreshed: 4 } });
    expect(JSON.parse(fs.readFileSync(index, "utf8")).sources.length).toBe(4);
  }
});
