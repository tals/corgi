import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tryLock } from "./conversation_grep_cache";
import { expandShort, workspaceScope } from "./grep_command";

// `corgi grep` end to end, over transcripts in a home of its own.
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "corgi-grep-cli-")));
const home = path.join(dir, "home");
const sessions = path.join(home, ".codex", "sessions");
const cache = path.join(dir, "cache", "corgi", "conversation-grep-v2");
const workspace = path.join(dir, "workspace");
const link = path.join(dir, "link");
const main = path.join(import.meta.dir, "main.ts");
const command = "env CORGI_NATIVE_ROOT=/work/native bun test src/render.test.ts";
const env = {
  PATH: process.env.PATH ?? "",
  HOME: home,
  XDG_CACHE_HOME: path.join(dir, "cache"),
  XDG_STATE_HOME: path.join(dir, "state"),
  // No Corgi runs here, whatever runs on this machine.
  CORGI_SOCKET: path.join(dir, "no-corgi.sock"),
  ...(process.env.CORGI_NATIVE_ROOT ? { CORGI_NATIVE_ROOT: process.env.CORGI_NATIVE_ROOT } : {}),
};
async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, main, "grep", ...args], { stdout: "pipe", stderr: "pipe", env });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}
const search = (...args: string[]) => run(["--workspace", "/work", ...args]);
const meta = (id: string, cwd: string) => ({ type: "session_meta", payload: { id, cwd } });
function transcript(name: string, records: object[], compressed = false) {
  const text = records.map(r => JSON.stringify(r) + "\n").join("");
  fs.writeFileSync(path.join(sessions, name), compressed ? Bun.zstdCompressSync(text) : text);
}
beforeAll(() => {
  fs.mkdirSync(sessions, { recursive: true });
  const records = [
    {
      type: "response_item",
      timestamp: new Date().toISOString(),
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "before\nneedle\nafter\ngap\nsecond needle\ntail" }],
      },
    },
    {
      type: "response_item",
      payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ cmd: command }) },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        output: "verified\n" + "x".repeat(200000) + " https://github.com/example/project/pull/42\nnext",
      },
    },
  ];
  transcript("test.jsonl.zst", [meta("test-session", "/work/project"), ...records], true);
  fs.mkdirSync(workspace);
  fs.symlinkSync(workspace, link);
  transcript("old.jsonl", [
    meta("old-session", workspace),
    {
      type: "response_item",
      timestamp: new Date(Date.now() - 60 * 86400000).toISOString(),
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "ancient request" }] },
    },
  ]);
  for (let i = 0; i < 20; i++) transcript(`crowded-${i}.jsonl.zst`, [meta(`crowded-${i}`, "/crowd"), ...records], true);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

test("help and skill need no index", async () => {
  for (const args of [["--help"], ["--skill"], ["help"]]) {
    const r = await run(args);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--workspace");
  }
  expect(fs.existsSync(cache)).toBe(false);
});
test("short flags preserve values and regex", () => {
  expect(expandShort(["-iC2", "-e", "-C5", "--session=codex:test", "--", "-iC7"])).toEqual([
    "-i",
    "-C",
    "2",
    "-e",
    "-C5",
    "--session",
    "codex:test",
    "--",
    "-iC7",
  ]);
  expect(expandShort(["-ie", "-x"])).toEqual(["-i", "-e", "-x"]);
});
test("canonical line context is asymmetric and max-count retains trailing context", async () => {
  const r = await search("-B1", "-A2", "-m1", "needle");
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("1-assistant-before\n1.2:assistant:needle\n1.3-assistant-after\n1.4-assistant-gap");
  expect(r.stdout).not.toContain("1.5:assistant");
  expect(r.stderr).toContain("may have more matches");
});
test("tool-only exact command is opt-in, including compressed source", async () => {
  expect((await search("-F", command)).code).toBe(1);
  const r = await search("--tools", "--session", "codex:test-session", "-Fo", command);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("T1.2:tool:[call shell status=unrecorded] " + command);
  expect((await search("--tools", "--session", "codex:absent", "-F", command)).code).toBe(1);
});
test("each header names the cache file, whose line N is the message of hit N", async () => {
  const r = await search("second needle");
  expect(r.stdout).toContain("codex:test-session  ");
  const file = /  project  (\S+\.jsonl)\n1\.5:assistant:second needle/.exec(r.stdout)?.[1];
  expect(path.dirname(file!)).toBe(cache);
  const message = JSON.parse(fs.readFileSync(file!, "utf8").split("\n")[0]);
  expect(message).toMatchObject({ role: "assistant", ref: "2" });
  expect(message.text.split("\n")[4]).toBe("second needle");
});
test("JSON preserves source provenance and output cap remains valid JSONL", async () => {
  const r = await search("--tools", "--json", "https://github", "--max-output", "2000");
  expect(r.code).toBe(0);
  expect(r.stdout.length).toBeLessThanOrEqual(2000);
  const v = JSON.parse(r.stdout);
  expect(v.source.provider).toBe("codex");
  expect(v.source.source).toEndWith(".jsonl.zst");
  expect(v.hits[0].ref).toBe("4");
  expect(v.hits[0].lane).toBe("tools");
  expect(v.hits[0].text).toContain("https://github.com/example/project/pull/42");
  expect(v.hits[0].clipped).toBe(true);
});
test("only-matching returns an exact URL from a huge line within a small response", async () => {
  const r = await search("--tools", "-o", "https://\\S+");
  const [, ...hits] = r.stdout.split("\n");
  expect(hits.join("\n")).toContain("https://github.com/example/project/pull/42");
  expect(Buffer.byteLength(hits.join("\n"))).toBeLessThan(120);
});
test("a returned session is found at any age", async () => {
  expect((await run(["--workspace", workspace, "ancient"])).code).toBe(1);
  const r = await run(["--workspace", workspace, "--session", "codex:old-session", "ancient"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("1:user:ancient request");
});
test("a linked workspace finds conversations recorded in its real directory", async () => {
  expect((await run(["--workspace", link, "--max-age", "all", "ancient"])).code).toBe(0);
});
test("a reader that closes early, like head, ends the search without an error", async () => {
  const args = ["grep", "--workspace", "/crowd", "--tools", "--full-lines", "--max-output", "0", "--limit", "0"];
  const child = Bun.spawn(
    ["bash", "-c", 'set -o pipefail; "$@" | head -c 1 >/dev/null', "grep", process.execPath, main, ...args, "x{1000}"],
    { stdout: "ignore", stderr: "pipe", env },
  );
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  expect(stderr).not.toContain("EPIPE");
  expect(code).toBe(0);
});
test("invalid regex errors even when scope selects nothing; an unknown provider errors", async () => {
  expect((await search("--session", "absent", "[")).code).toBe(2);
  const r = await search("--provider", "nope", "needle");
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("Unknown provider nope; use codex, claude, pi, opencode2, omp");
});

test("a search that finds the index locked reads changes itself and names no cache file for them", async () => {
  const say = (text: string) => ({
    type: "response_item",
    timestamp: new Date().toISOString(),
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  });
  transcript("locked.jsonl", [meta("locked-session", "/locked"), say("first locked needle")]);
  const indexed = await run(["--workspace", "/locked", "--json", "locked needle"]);
  expect(JSON.parse(indexed.stdout).source.cache).toStartWith(cache);
  fs.appendFileSync(path.join(sessions, "locked.jsonl"), JSON.stringify(say("second locked needle")) + "\n");
  const holder = await tryLock(cache);
  try {
    const text = await run(["--workspace", "/locked", "locked needle"]);
    expect(text.stdout).toContain("2:assistant:second locked needle");
    expect(text.stdout).not.toContain(cache);
    const json = await run(["--workspace", "/locked", "--json", "locked needle"]);
    expect(
      json.stdout
        .trim()
        .split("\n")
        .map(line => JSON.parse(line).source.cache),
    ).toEqual([undefined, undefined]);
  } finally {
    holder!();
  }
});
test("without --workspace outside Corgi, it says to name one", async () => {
  const r = await run(["needle"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("Corgi isn't running to say which workspace this is");
});

describe("--workspace", () => {
  const app = path.join(dir, "ws-app"),
    web = path.join(dir, "ws-web"),
    here = path.join(dir, "ws-here"),
    sibling = path.join(dir, "ws-app-fix");
  beforeAll(() => {
    for (const d of [app, web, here, sibling, path.join(here, "app"), path.join(here, "ws-web"), path.join(web, "src")])
      fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(here, "corgi"), "#!/bin/sh\n");
  });
  type Workspace = { id: number; name: string; cwd: string; worktrees?: string[] };
  const corgi = (workspaces: Workspace[]) => workspaces.map(w => ({ worktrees: [], ...w }));
  const both = corgi([
    { id: 1, name: "app", cwd: app },
    { id: 2, name: "web", cwd: web },
  ]);
  const root = (...args: Parameters<typeof workspaceScope>) => workspaceScope(...args).root;

  test("names a Corgi workspace by name or ID, a directory, or every one", () => {
    expect(root("web", both, dir)).toBe(web);
    expect(root("WEB", both, dir)).toBe(web);
    expect(root("1", both, dir)).toBe(app);
    expect(root("*", null)).toBe("*");
    expect(root("ws-web", null, dir)).toBe(web);
    // A path need not exist: a removed worktree's conversations stay searchable.
    expect(root("./gone", null, dir)).toBe(path.join(dir, "gone"));
  });
  test("defaults to the innermost workspace holding the current directory", () => {
    expect(root(undefined, both, app)).toBe(app);
    const nested = corgi([...both, { id: 8, name: "everything", cwd: dir }]);
    expect(root(undefined, nested, path.join(web, "src"))).toBe(web);
    expect(root(undefined, nested, here)).toBe(dir);
    expect(() => root(undefined, both, here)).toThrow(`No Corgi workspace holds ${here}`);
    expect(() => root(undefined, null, app)).toThrow("Corgi isn't running");
  });
  test("a workspace brings its worktrees outside its folder, and is the default inside one", () => {
    const repo = corgi([
      { id: 1, name: "app", cwd: app, worktrees: [app, sibling, path.join(app, ".worktrees/x")] },
      both[1],
    ]);
    expect(workspaceScope("app", repo, dir)).toEqual({ root: app, folders: [sibling] });
    expect(workspaceScope(undefined, repo, sibling)).toEqual({ root: app, folders: [sibling] });
    // The main checkout holds a workspace that is its subfolder; it would widen the search to the whole repo.
    const sub = corgi([{ id: 9, name: "src", cwd: path.join(web, "src"), worktrees: [web, sibling] }]);
    expect(workspaceScope("src", sub, dir)).toEqual({ root: path.join(web, "src"), folders: [sibling] });
    const shared = corgi([...repo, { id: 10, name: "other", cwd: here, worktrees: [sibling] }]);
    expect(() => workspaceScope(undefined, shared, sibling)).toThrow(`${sibling} is in more than one workspace`);
  });
  test("rejects a name that could mean two directories, not one that means the same one twice", () => {
    const twins = corgi([...both, { id: 3, name: "app", cwd: web }]);
    expect(() => root("app", twins, dir)).toThrow(
      `--workspace app is ambiguous: workspace 1 "app" (${app}), workspace 3 "app" (${web}); pass a workspace ID or a path`,
    );
    expect(() => root("app", both, here)).toThrow("directory " + path.join(here, "app"));
    expect(() => root("2", corgi([...both, { id: 4, name: "2", cwd: app }]), dir)).toThrow("ambiguous");
    expect(root("ws-web", corgi([{ id: 5, name: "ws-web", cwd: path.join(here, "ws-web") }]), here)).toBe(
      path.join(here, "ws-web"),
    );
    expect(root("app", corgi([...both, { id: 6, name: "app", cwd: app }]), dir)).toBe(app);
    expect(() => root("web", corgi([...both, { id: 7, name: "Web", cwd: app }]), dir)).toThrow("ambiguous");
  });
  test("a word naming neither a workspace nor a directory here fails, a file included", () => {
    expect(() => root("corgi", both, here)).toThrow(
      `No workspace or directory named corgi; workspaces: workspace 1 "app" (${app}), workspace 2 "web" (${web})`,
    );
    expect(() => root("corgi", null, here)).toThrow("Corgi isn't running, so only directories resolve");
  });
});
