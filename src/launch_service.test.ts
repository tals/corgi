import { afterAll, beforeAll, test, expect, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { service, publish, request, sample, stop } from "./launch_service";
import { Preview, Worker as PreviewWorker, active_every, idle_every } from "./launch/preview";
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
  const server: any = { clients: [] },
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
  }
});

test("unchanged preview identities skip serialization and equal replacements become the new baseline", async () => {
  const server: any = {},
    messages: any[] = [],
    s = service(server);
  let preview = new Preview().with({ pending: false });
  const client: any = {
    dead: false,
    output: Buffer.alloc(0),
    queue: (value: any) => messages.push(value),
    launch_preview: { cwd: "/tmp", preview, checked: 0, history_asked: false, history_epoch: 0n, history_sent: 0n },
  };
  s.launch_previews.preview = () => preview;
  const serialize = spyOn(preview.options.codex, "toJSON"),
    check = () => {
      client.launch_preview.checked = 0;
      publish(server, client);
    };
  try {
    check();
    expect(serialize).not.toHaveBeenCalled();
    preview = preview.with({});
    check();
    expect(serialize).toHaveBeenCalled();
    expect(messages).toHaveLength(0);
    expect(client.launch_preview.preview).toBe(preview);
    const calls = serialize.mock.calls.length;
    check();
    expect(serialize.mock.calls).toHaveLength(calls);
    const previous = preview;
    preview = preview.with({ names: { ...preview.names, codex: "work" } });
    check();
    expect(messages).toHaveLength(1);
    expect(messages[0].preview.names.codex).toBe("work");
    expect(previous.names.codex).toBe("");
  } finally {
    serialize.mockRestore();
    await stop(server);
  }
});
