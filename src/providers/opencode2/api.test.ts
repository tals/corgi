import { Quit } from "../../subprocess";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, eventSession, sse, windows } from "./api";
import * as server from "./server";
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
});
/** A service.json in a private state directory, as the service writes it. */
function advertise(url: string, password: string) {
  const root = mkdtempSync(join(tmpdir(), "corgi-opencode-api-")),
    previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  mkdirSync(join(root, "opencode"));
  const write = (url: string, password: string) =>
    writeFileSync(join(root, "opencode", "service.json"), JSON.stringify({ url, password }));
  write(url, password);
  cleanup.push(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return write;
}
/** Sets `name` until the test ends. */
function env(name: string, value: string) {
  const previous = process.env[name];
  process.env[name] = value;
  cleanup.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}
/** OpenCode's database, with a stored login or without, and an `opencode`
 * that notes each run and serves nothing. */
function installed(login: boolean) {
  const root = mkdtempSync(join(tmpdir(), "corgi-opencode-data-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "opencode"));
  const db = new Database(join(root, "opencode", "opencode.db"));
  db.run("CREATE TABLE credential (id TEXT PRIMARY KEY)");
  if (login) db.run("INSERT INTO credential VALUES ('cred_1')");
  db.close();
  env("XDG_DATA_HOME", root);
  const runs = join(root, "runs");
  writeFileSync(join(root, "opencode-cli"), `#!/bin/sh\necho "$*" >> '${runs}'\n`, { mode: 0o755 });
  env("CORGI_OPENCODE2_BIN", join(root, "opencode-cli"));
  cleanup.push(() => server.close());
  return () => (existsSync(runs) ? readFileSync(runs, "utf8") : "");
}
function serve(password: string, fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({
    port: 0,
    fetch: request =>
      request.headers.get("authorization") === "Basic " + Buffer.from("opencode:" + password).toString("base64")
        ? fetch(request)
        : new Response("", { status: 401 }),
  });
  cleanup.push(() => server.stop(true));
  return server;
}
async function* chunks(...parts: string[]) {
  for (const part of parts) yield new TextEncoder().encode(part);
}
test("event streams split into each event's data across chunk boundaries", async () => {
  const seen: string[] = [];
  for await (const data of sse(
    chunks(': heartbeat\n\ndata: {"a":', "1}\r\n\r\nevent: x\ndata: one\ndata: two\n", "\n", "data: {}\n\n"),
  ))
    seen.push(data);
  expect(seen).toEqual(['{"a":1}', "one\ntwo", "{}"]);
});
test("events name their session, including forms", () => {
  expect(eventSession({ type: "session.tool.called", data: { sessionID: "ses_a" } })).toBe("ses_a");
  expect(eventSession({ type: "form.created", data: { form: { id: "frm_1", sessionID: "ses_b" } } })).toBe("ses_b");
  expect(eventSession({ type: "server.connected", data: {} })).toBe("");
});
test("the catalog's context windows are indexed by provider and model", () => {
  expect(
    windows({
      data: [
        {
          providerID: "openai",
          id: "gpt-5.5",
          limit: { context: 200000, output: 32000 },
        },
        { providerID: "openai", id: "gpt-6", limit: {} },
        { providerID: "openai", id: "unnamed" },
        { providerID: "openai", limit: { context: "big" } },
      ],
    }),
  ).toEqual(new Map([["openai/gpt-5.5", 200000n]]));
});
test("requests reach the advertised service with its password", async () => {
  const server = serve("secret", async request =>
    Response.json({ method: request.method, path: new URL(request.url).pathname, body: await request.json() }),
  );
  advertise(`http://127.0.0.1:${server.port}`, "secret");
  const api = new API("/nonexistent/opencode", "/tmp");
  expect(await api.call("PATCH", "/api/session/ses_a", { title: "Name" })).toEqual({
    method: "PATCH",
    path: "/api/session/ses_a",
    body: { title: "Name" },
  });
});
test("replies past the old pipe size arrive whole", async () => {
  const big = { data: [{ text: "x".repeat(900 * 1024) }] },
    server = serve("secret", () => Response.json(big));
  advertise(`http://127.0.0.1:${server.port}`, "secret");
  expect(await new API("/nonexistent/opencode").call("GET", "/api/session/ses_a/context")).toEqual(big);
});
test("a restarted service is found again at its new address", async () => {
  const old = serve("old", () => Response.json({ from: "old" })),
    write = advertise(`http://127.0.0.1:${old.port}`, "old"),
    api = new API("/nonexistent/opencode");
  expect(await api.call("GET", "/api/session/active")).toEqual({ from: "old" });
  old.stop(true);
  const restarted = serve("new", () => Response.json({ from: "new" }));
  write(`http://127.0.0.1:${restarted.port}`, "new");
  expect(await api.call("GET", "/api/session/active")).toEqual({ from: "new" });
});
test("the event stream reconnects after it drops", async () => {
  let connections = 0;
  const server = serve("secret", () => {
    connections++;
    const n = connections;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: {"type":"test","data":{"sessionID":"ses_${n}"}}\n\n`));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  advertise(`http://127.0.0.1:${server.port}`, "secret");
  const abort = new AbortController(),
    seen: string[] = [];
  let connected = 0,
    lost = 0;
  const done = new API("/nonexistent/opencode").follow(abort.signal, {
    connected: () => connected++,
    event: event => {
      seen.push(eventSession(event));
      if (seen.length === 2) abort.abort();
    },
    lost: () => lost++,
  });
  await done;
  expect(seen).toEqual(["ses_1", "ses_2"]);
  expect(connected).toBe(2);
  expect(lost).toBe(1);
});
test("reads that mustn't start the service use the running one, and give up when it goes", async () => {
  const service = serve("secret", () => Response.json({ data: [] }));
  advertise(`http://127.0.0.1:${service.port}`, "secret");
  const runs = installed(true);
  expect(
    await API.peek("/tmp", async api => {
      const reply = await api.call("GET", "/api/credential");
      service.stop(true);
      await expect(api.call("GET", "/api/credential")).rejects.toThrow("OpenCodeServiceUnavailable");
      return reply;
    }),
  ).toEqual({ data: [] });
  expect(runs()).toBe("");
});
test("without a running service or a login, reads find nothing and start nothing", async () => {
  const stopped = serve("secret", () => Response.json({}));
  advertise(`http://127.0.0.1:${stopped.port}`, "secret");
  stopped.stop(true);
  const runs = installed(false);
  expect(await API.peek("/tmp", async () => "read")).toBeNull();
  rmSync(join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db"));
  expect(await API.peek("/tmp", async () => "read")).toBeNull();
  expect(runs()).toBe("");
});
test("with a login, reads borrow a private server unless told not to", async () => {
  advertise("http://127.0.0.1:1", "secret");
  const runs = installed(true);
  expect(await API.peek("/tmp", async () => "read", false)).toBeNull();
  expect(runs()).toBe("");
  await expect(API.peek("/tmp", async () => "read")).rejects.toThrow("OpenCodeServiceUnavailable");
  expect(runs()).toBe("serve --stdio --port 0\n");
});

test("a user startup streams installation past ten seconds before starting the API deadline", async () => {
  const http = serve("secret", () => Response.json({ data: { ready: true } })),
    url = `http://127.0.0.1:${http.port}`;
  advertise(url, "secret");
  const state = process.env.XDG_STATE_HOME!,
    file = join(state, "opencode/service.json"),
    helper = join(state, "opencode-cli"),
    messages: string[] = [],
    phases: string[] = [];
  rmSync(file);
  writeFileSync(
    helper,
    `#!/bin/sh\necho 'mise opencode@2 downloading' >&2\nsleep 10.2\nprintf '%s' '${JSON.stringify({ url, password: "secret" })}' > '${file}'\n`,
    { mode: 0o755 },
  );
  const api = new API(helper, state, true, {
    quit: new Quit(),
    update: phase => phases.push(phase),
    output: bytes => messages.push(bytes.toString()),
  });
  const started = Date.now(),
    result = await api.call("GET", "/api/info", undefined, undefined, 1000);
  expect(Date.now() - started).toBeGreaterThan(10000);
  expect(result).toEqual({ data: { ready: true } });
  expect(messages.join("")).toContain("mise opencode@2 downloading");
  expect(phases).toEqual(["service", "session"]);
}, 15000);

test("a user can cancel an unbounded service startup", async () => {
  advertise("http://127.0.0.1:1", "secret");
  const state = process.env.XDG_STATE_HOME!,
    helper = join(state, "opencode-cli"),
    quit = new Quit();
  rmSync(join(state, "opencode/service.json"));
  writeFileSync(helper, "#!/bin/sh\necho starting >&2\nsleep 20 & wait\n", { mode: 0o755 });
  const api = new API(helper, state, true, {
    quit,
    update: () => {},
    output: () => quit.signal(),
  });
  await expect(api.call("GET", "/api/info")).rejects.toThrow("Cancelled");
});
