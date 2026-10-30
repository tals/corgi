import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Local } from "./identity";
import { Text } from "../common";
import { Worker, snapshot } from "./observer";

const id = "01901234-1234-1234-1234-123456789abc";
const request = (prefix = id) => ({
  pane: 1,
  pid: 42,
  actor: 0,
  prefix: new Text(prefix),
  generation: 1n,
  title_revision: 1n,
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "corgi-codex-identity-"));
  await mkdir(path.join(root, "sessions", "2026", "10", "30"), { recursive: true });
  afterEach(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    async write(session = id, header = session) {
      const file = path.join(root, "sessions", "2026", "10", "30", `rollout-date-${session}.jsonl`);
      await Bun.write(file, JSON.stringify({ type: "session_meta", payload: { id: header, cwd: "/repo" } }) + "\n");
      return file;
    },
  };
}
test("local identity verifies the rollout header and resolves an unambiguous title prefix", async () => {
  const f = await fixture();
  const file = await f.write();
  for (const prefix of [id, id.slice(0, 29)]) {
    const out = await new Local(f.root).read(request(prefix));
    expect(out?.session).toBe(id);
    expect(out?.transcript.text()).toBe(file);
    expect(out?.cwd.text()).toBe("/repo");
    expect(out?.lifecycle).toBe(false);
  }
  await f.write("01901234-1234-1234-1234-123456789def");
  expect(await new Local(f.root).read(request(id.slice(0, 29)))).toBeNull();
  await f.write(id, "01911234-1234-1234-1234-123456789abc");
  expect(await new Local(f.root).read(request())).toBeNull();
});
test("a missing shared socket still yields a locally verified session", async () => {
  const f = await fixture();
  await f.write();
  const worker = new Worker(f.root);
  worker.requests = [request()];
  await worker.run();
  expect(worker.take().map(s => [s.session, s.lifecycle])).toEqual([[id, false]]);
  expect(worker.takeMissed()).toEqual([]);
  worker.stop();
});
test("an unloaded thread supplies metadata without querying stale turn state", async () => {
  const methods: string[] = [];
  const client = {
    async call(method: string) {
      methods.push(method);
      return { result: { thread: { id, status: { type: "notLoaded" }, path: "/rollout.jsonl", cwd: "/repo" } } };
    },
  };
  const out = await snapshot(client as any, request(), id);
  expect(out.lifecycle).toBe(false);
  expect(out.state).toBe("unknown");
  expect(out.transcript.text()).toBe("/rollout.jsonl");
  expect(methods).toEqual(["thread/read"]);
});
