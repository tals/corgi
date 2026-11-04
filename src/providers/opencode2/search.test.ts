import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { refresh } from "../../conversation_grep_cache";
import { search, selected, type Options } from "../../conversation_grep";
import type { Context, Found } from "../search";
import { conversations } from "./search";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corgi-opencode-search-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
// The columns corgi grep reads, named as OpenCode's schema names them.
const schema = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE session_v2 (id text PRIMARY KEY, parent_id text, directory text NOT NULL, title text,
    time_created integer NOT NULL, time_updated integer NOT NULL);
  CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL,
    seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
  CREATE TABLE session_part (message_id text NOT NULL, session_id text NOT NULL, ordinal integer NOT NULL,
    type text NOT NULL, call_id text, time_created integer NOT NULL, time_updated integer NOT NULL,
    data text NOT NULL, PRIMARY KEY (message_id, ordinal));`;
function store(name: string, tables = schema) {
  const folder = path.join(dir, name);
  fs.mkdirSync(folder);
  const db = new Database(path.join(folder, "opencode.db"), { create: true });
  db.exec(tables);
  let seq = 0;
  return {
    folder,
    db,
    session(id: string, directory: string, extra: { parent?: string; title?: string; updated?: number } = {}) {
      db.query("INSERT INTO session_v2 VALUES (?, ?, ?, ?, 1, ?)").run(
        id,
        extra.parent ?? null,
        directory,
        extra.title ?? null,
        extra.updated ?? 1000,
      );
    },
    message(session: string, id: string, type: string, data: object, time = 1000) {
      db.query("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        id,
        session,
        type,
        ++seq,
        time,
        time,
        JSON.stringify(data),
      );
    },
    part(session: string, message: string, ordinal: number, data: { type: string }, updated = 1000) {
      db.query("INSERT INTO session_part VALUES (?, ?, ?, ?, NULL, 1, ?, ?)").run(
        message,
        session,
        ordinal,
        data.type,
        updated,
        JSON.stringify(data),
      );
    },
  };
}
function context() {
  const warnings: string[] = [];
  const value: Context = {
    known: () => undefined,
    skipped: () => false,
    exclude() {},
    warn: text => void warnings.push(text),
    claim: () => true,
    checking() {},
    async checked() {},
  };
  return { warnings, value };
}
const discover = async (folder: string) => conversations.discover(folder, context().value);
const tool = (id: string, name: string, state: object) => ({ type: "tool", id, name, state, time: { created: 2000 } });

test("lists top-level sessions with their folder and title, not subagents' or folderless ones", async () => {
  const s = store("list");
  s.session("ses_app", "/work/app", { title: "Fix tabs", updated: 5000 });
  s.session("ses_child", "/work/app", { parent: "ses_app" });
  s.session("ses_legacy", "");
  const found = await discover(s.folder);
  expect(found).toMatchObject([{ session: "ses_app", cwd: "/work/app", title: "Fix tabs", updated_at: 5000 }]);
  expect(found[0].source).toBe(path.join(s.folder, "opencode.db") + "#ses_app");
});

test("reads typed text, assistant text from parts or inline content, and tools with their outcome", async () => {
  const s = store("read");
  s.session("ses_1", "/work");
  s.message("ses_1", "msg_1", "user", { text: "Fix the tab labels" });
  s.message("ses_1", "msg_2", "assistant", {
    content: [
      { type: "reasoning", text: "private" },
      { type: "text", text: "Looking now" },
    ],
  });
  // Newer OpenCode keeps content in parts, which replace the row's own.
  s.message("ses_1", "msg_3", "assistant", { content: [{ type: "text", text: "stale inline" }] });
  s.part("ses_1", "msg_3", 0, { type: "text", text: "Fixed in tabs.ts" } as { type: string });
  s.part(
    "ses_1",
    "msg_3",
    1,
    tool("call_ok", "shell", {
      status: "completed",
      input: { command: "bun test" },
      content: [{ type: "text", text: "12 pass" }],
      metadata: { exit: 0, truncated: false },
    }),
  );
  s.part(
    "ses_1",
    "msg_3",
    2,
    tool("call_denied", "write", {
      status: "error",
      input: { path: "/etc/x" },
      error: { type: "x", message: "denied" },
    }),
  );
  s.part(
    "ses_1",
    "msg_3",
    3,
    tool("call_long", "shell", { status: "running", input: { command: "dev" }, metadata: {} }),
  );
  s.message("ses_1", "msg_4", "shell", {
    shellID: "sh_1",
    command: "git status",
    status: "exited",
    exit: 128,
    output: { output: "fatal: not a git repository", cursor: 0, size: 0, truncated: false },
    time: { created: 3000, completed: 3100 },
  });
  s.message("ses_1", "msg_5", "synthetic", { text: "a summary OpenCode wrote" });
  const [found] = await discover(s.folder);
  const read = await conversations.read(found, true);
  expect(read.messages.map(m => [m.role, m.text, m.ref])).toEqual([
    ["user", "Fix the tab labels", "msg_1"],
    ["assistant", "Looking now", "msg_2"],
    ["assistant", "Fixed in tabs.ts", "msg_3"],
  ]);
  expect(read.tools!.map(t => [t.text, t.tool!.kind, t.tool!.status, t.tool!.exit_code])).toEqual([
    ["shell\ncommand: bun test", "call", "success", 0],
    ["12 pass", "result", "success", 0],
    ["write\npath: /etc/x", "call", "error", null],
    ["denied", "result", "error", null],
    ["shell\ncommand: dev", "call", "running", null],
    ["user-shell\ncommand: git status", "call", "error", 128],
    ["fatal: not a git repository", "result", "error", 128],
  ]);
  expect(read.tools![0].tool).toMatchObject({ call_ref: "msg_3", result_ref: "msg_3" });
});

test("a session's stamp follows its row and how many messages and parts it has", async () => {
  const s = store("stamp");
  s.session("ses_1", "/work");
  s.message("ses_1", "msg_1", "assistant", { content: [] });
  s.part("ses_1", "msg_1", 0, { type: "text", text: "streaming" } as { type: string });
  const stamp = async () => (await discover(s.folder))[0].stamp;
  const first = await stamp();
  expect(await stamp()).toBe(first);
  // Text streaming into a part waits for the step's end, when OpenCode touches the session.
  s.db
    .query("UPDATE session_part SET time_updated = 2000, data = ? WHERE message_id = 'msg_1'")
    .run(JSON.stringify({ type: "text", text: "streamed in full" }));
  expect(await stamp()).toBe(first);
  s.db.query("UPDATE session_v2 SET time_updated = 2000 WHERE id = 'ses_1'").run();
  const ended = await stamp();
  expect(ended).not.toBe(first);
  s.part("ses_1", "msg_1", 1, { type: "text", text: "more" } as { type: string });
  const parted = await stamp();
  expect(parted).not.toBe(ended);
  s.message("ses_1", "msg_2", "user", { text: "thanks" });
  expect(await stamp()).not.toBe(parted);
});

test("a call ID used twice keeps each call's own outcome", async () => {
  const s = store("reused");
  s.session("ses_1", "/work");
  for (const [message, code] of [
    ["msg_1", 0],
    ["msg_2", 1],
  ] as const) {
    s.message("ses_1", message, "assistant", { content: [] });
    s.part(
      "ses_1",
      message,
      0,
      tool("call_0", "shell", {
        status: "completed",
        input: { command: `exit ${code}` },
        content: [{ type: "text", text: "." }],
        metadata: { exit: code },
      }),
    );
  }
  const [found] = await discover(s.folder);
  const calls = (await conversations.read(found, true)).tools!.filter(t => t.tool!.kind === "call");
  expect(calls.map(t => [t.tool!.status, t.tool!.exit_code, t.tool!.result_ref])).toEqual([
    ["success", 0, "msg_1"],
    ["error", 1, "msg_2"],
  ]);
});

test("a store from before session parts reads inline content; one without sessions finds none and says so", async () => {
  const older = store("older", schema.slice(0, schema.indexOf("CREATE TABLE session_part")));
  older.session("ses_1", "/work");
  older.message("ses_1", "msg_1", "assistant", { content: [{ type: "text", text: "inline only" }] });
  const [found] = await discover(older.folder);
  expect((await conversations.read(found, false)).messages.map(m => m.text)).toEqual(["inline only"]);
  const empty = store("empty", "CREATE TABLE credential (id text PRIMARY KEY);");
  const { warnings, value } = context();
  expect(await conversations.discover(empty.folder, value)).toEqual([]);
  expect(warnings[0]).toStartWith("OpenCode database has no sessions");
});

test("the index searches OpenCode sessions and refreshes the one that changed", async () => {
  const s = store("index"),
    cache = path.join(dir, "index-cache"),
    locations = [{ provider: "opencode2" as const, root: s.folder }];
  fs.mkdirSync(cache);
  s.session("ses_1", "/work/app");
  s.message("ses_1", "msg_1", "user", { text: "where is the needle" });
  s.session("ses_2", "/work/app");
  s.message("ses_2", "msg_1b", "user", { text: "unrelated" });
  const options: Options = {
    workspace: "/work",
    age: 0,
    patterns: ["needle"],
    flags: [],
    limit: 0,
    maxCount: 3,
    context: 0,
    asOf: Date.now(),
  };
  const first = await refresh(cache, options, undefined, locations);
  expect(first).toMatchObject({ refreshed: 2 });
  const hits = async (manifest: typeof first) =>
    (await search(cache, selected(manifest, options), options)).flatMap(m => m.hits.map(h => h.text));
  expect(await hits(first)).toEqual(["where is the needle"]);
  s.message("ses_1", "msg_2", "assistant", { content: [{ type: "text", text: "the needle is here" }] }, 2000);
  const second = await refresh(cache, options, undefined, locations);
  expect(second).toMatchObject({ refreshed: 1, reused: 1 });
  expect(await hits(second)).toEqual(["where is the needle", "the needle is here"]);
  expect(await refresh(cache, options, undefined, locations)).toMatchObject({ refreshed: 0, reused: 2 });
});
