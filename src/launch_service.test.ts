import { afterAll, beforeAll, test, expect, setSystemTime } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { all_grace_ms, service, publish, request, sample, stop } from "./launch_service";
import { Preview, Worker as PreviewWorker, active_every, idle_every, key, type Uses } from "./launch/preview";
import { Runtime } from "./runtime";
import { Workspace } from "./workspace";
import { Text } from "./providers";
import * as protocol from "./protocol";
import * as accounts from "./accounts";
// Previews list the user's accounts; these tests see none.
const saved = { HOME: process.env.HOME, CORGI_ENV_BASE: process.env.CORGI_ENV_BASE },
  home = mkdtempSync(join(tmpdir(), "corgi-launch-service-"));
beforeAll(() => {
  process.env.HOME = home;
  process.env.CORGI_ENV_BASE = home;
  accounts.reset();
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  accounts.reset();
  rmSync(home, { recursive: true, force: true });
});
test("new preview subscribers refresh cached sign-in asynchronously and share pending work", async () => {
  const server: any = { runtime: { getWorkspace: () => ({ cwd: "/tmp" }) } },
    messages: any[] = [],
    client = (): any => ({
      dead: false,
      output: Buffer.alloc(0),
      queue: (v: any) => messages.push(v),
      launch_preview: null,
    }),
    first = client(),
    second = client(),
    s = service(server),
    before = new Preview();
  before.pending = false;
  before.options.codex.signed_in = false;
  s.launch_previews.jobs = [
    {
      cwd: "/tmp",
      preview: before,
      queued: false,
      updated: Date.now(),
      used: 0,
      accessing: false,
      request_access: false,
    },
  ];
  let finish!: () => void,
    reads = 0;
  const reading = new Promise<void>(resolve => (finish = resolve));
  s.launch_previews.run = async job => {
    reads++;
    job.queued = false;
    await reading;
    job.preview = new Preview();
    job.preview.pending = false;
    job.preview.options.codex.signed_in = true;
    job.updated = Date.now();
  };
  try {
    await request(server, first, {
      op: "agent.preview",
      payload: protocol.decode("agent.preview", { workspace: 1, cwd: "/tmp" }),
    });
    expect(reads).toBe(0);
    messages.length = 0;
    const subscribe = {
      op: "agent.subscribe" as const,
      payload: protocol.decode("agent.subscribe", { workspace: 1, cwd: "/tmp" }),
    };
    await request(server, first, subscribe);
    expect(reads).toBe(1);
    expect(messages[0].preview.pending).toBe(true);
    expect(messages[0].preview.options.codex.signed_in).toBe(false);
    await request(server, second, subscribe);
    expect(s.launch_previews.jobs[0].queued).toBe(false);
    const pending = s.launch_previews.pump();
    finish();
    await pending;
    expect(reads).toBe(1);
    messages.length = 0;
    for (const cl of [first, second]) {
      cl.launch_preview!.checked = 0;
      publish(server, cl);
    }
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message.preview.pending).toBe(false);
      expect(message.preview.options.codex.signed_in).toBe(true);
    }
    expect(reads).toBe(1);
  } finally {
    finish();
    await stop(server);
  }
});
test("preview subscriptions schedule stale refreshes and publish completion without another request", () => {
  const server: any = {},
    messages: any[] = [],
    client: any = {
      dead: false,
      output: Buffer.alloc(0),
      queue: (v: any) => messages.push(v),
      launch_preview: null,
    },
    s = service(server),
    before = new Preview();
  before.pending = false;
  before.options.claude.model = new Text("before");
  client.launch_preview = {
    cwd: "/",
    preview: before,
    checked: 0,
    history_asked: false,
    history_epoch: 0n,
    history_sent: 0n,
  };
  s.launch_previews.pump = async () => {};
  s.launch_previews.jobs = [
    {
      cwd: "/",
      preview: Object.assign(new Preview(), before),
      queued: false,
      updated: Date.now() - 60001,
      used: 0,
      accessing: false,
      request_access: false,
    },
  ];
  publish(server, client);
  expect(s.launch_previews.jobs[0].queued).toBe(true);
  expect(client.launch_preview.preview.pending).toBe(true);
  expect(client.launch_preview.preview.options.claude.model.text()).toBe("before");
  messages.length = 0;
  client.launch_preview.checked = 0;
  s.launch_previews.jobs[0].preview = Object.assign(new Preview(), {
    ...s.launch_previews.jobs[0].preview,
    options: {
      ...s.launch_previews.jobs[0].preview.options,
      claude: Object.assign(new Preview().options.claude, { pending: false, model: new Text("partial") }),
    },
  });
  publish(server, client);
  expect(messages[0].preview.pending).toBe(true);
  expect(messages[0].preview.options.claude.model.text()).toBe("partial");
  messages.length = 0;
  client.launch_preview.checked = 0;
  s.launch_previews.jobs[0].updated = Date.now();
  s.launch_previews.jobs[0].queued = false;
  s.launch_previews.jobs[0].preview = new Preview();
  s.launch_previews.jobs[0].preview.pending = false;
  s.launch_previews.jobs[0].preview.options.claude.model = new Text("after");
  publish(server, client);
  expect(messages[0].type).toBe("agent.preview");
  expect(client.launch_preview.preview.pending).toBe(false);
  expect(client.launch_preview.preview.options.claude.model.text()).toBe("after");
  messages.length = 0;
  client.launch_preview.checked = 0;
  publish(server, client);
  expect(messages).toHaveLength(0);
  stop(server);
});
test("restored preview subscriptions restart their workers without a new request", () => {
  const server: any = {},
    messages: any[] = [],
    before = new Preview();
  before.pending = false;
  before.options.claude.model = new Text("before reload");
  const client: any = {
    dead: false,
    output: Buffer.alloc(0),
    queue: (value: any) => messages.push(value),
    launch_preview: {
      cwd: "/tmp",
      preview: before,
      checked: 0,
      history_asked: false,
      history_epoch: 0n,
      history_sent: 0n,
    },
  };
  const pump = PreviewWorker.prototype.pump;
  PreviewWorker.prototype.pump = async () => {};
  try {
    publish(server, client);
    expect(service(server).launch_previews.jobs.length).toBe(1);
    expect(messages[0].type).toBe("agent.preview");
    expect(messages[0].preview.pending).toBe(true);
    expect(messages[0].preview.options.claude.model.text()).toBe("before reload");
  } finally {
    stop(server);
    PreviewWorker.prototype.pump = pump;
  }
});
test("accounts are read often while someone uses a viewer and rarely otherwise", () => {
  const server: any = { clients: [], runtime: new Runtime() },
    asked: number[] = [];
  service(server).launch_previews.sample = every => void asked.push(every);
  try {
    sample(server);
    const viewer = { viewer: true, dead: false, input_at: Date.now() - 6 * 60 * 1000 };
    server.clients.push(viewer);
    sample(server);
    viewer.input_at = Date.now() - 60 * 1000;
    sample(server);
    expect(asked).toEqual([idle_every, idle_every, active_every]);
  } finally {
    stop(server);
    server.runtime.destroy();
  }
});
test("a Manage agents subscriber has every account read while it stays, and a while after", async () => {
  mkdirSync(dirname(accounts.path()), { recursive: true });
  writeFileSync(
    accounts.path(),
    JSON.stringify({ accounts: [{ provider: "claude", dir: join(home, "spare"), name: "spare", managed: false }] }),
  );
  accounts.reset();
  const spare = accounts.known()[0].dir,
    r = new Runtime(),
    server: any = { runtime: r, clients: [] },
    s = service(server),
    seen: Uses[] = [],
    messages: any[] = [],
    client: any = { dead: false, output: Buffer.alloc(0), queue: (v: any) => messages.push(v), launch_preview: null };
  r.workspaces.items = [new Workspace(1, "/tmp")];
  r.account_hidden = [spare];
  s.launch_previews.use = uses => void seen.push(uses);
  s.launch_previews.pump = async () => {};
  server.clients.push(client);
  try {
    sample(server);
    expect(seen.at(-1)?.has(key("claude", spare))).toBe(false);
    await request(server, client, {
      op: "agent.subscribe",
      payload: protocol.decode("agent.subscribe", { workspace: 1, cwd: "/tmp", all: true }),
    });
    expect(seen.at(-1)?.get(key("claude", spare))).toBe("account");
    // Closing Manage agents changes the subscription in place: it reads no
    // sign-in again and keeps its history.
    const subscription = client.launch_preview;
    subscription.history_asked = true;
    subscription.history_epoch = 7n;
    const read_at = [...s.launch_previews.logins.values()].map(login => login.read_at);
    messages.length = 0;
    await request(server, client, {
      op: "agent.subscribe",
      payload: protocol.decode("agent.subscribe", { workspace: 1, cwd: "/tmp", all: false }),
    });
    expect(client.launch_preview).toBe(subscription);
    expect(subscription).toMatchObject({ all: false, history_asked: true, history_epoch: 7n });
    expect([...s.launch_previews.logins.values()].map(login => login.read_at)).toEqual(read_at);
    expect(messages).toEqual([]);
    // Every account stays read a while, so moving through Settings doesn't churn them.
    s.checked_at = 0;
    sample(server);
    expect(seen.at(-1)?.get(key("claude", spare))).toBe("account");
    setSystemTime(new Date(Date.now() + all_grace_ms + 1000));
    s.checked_at = 0;
    sample(server);
    expect(seen.at(-1)?.has(key("claude", spare))).toBe(false);
  } finally {
    setSystemTime();
    r.destroy();
    accounts.reset();
    await stop(server);
  }
});
