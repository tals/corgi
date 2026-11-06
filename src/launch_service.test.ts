import { afterAll, beforeAll, test, expect, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { service, publish, request, sample, stop, due, agentRan, discover } from "./launch_service";
import { Entry } from "./launch/command";
import { Preview, Worker as PreviewWorker, active_every, idle_every } from "./launch/preview";
import { Text, byProvider } from "./providers";
import * as protocol from "./protocol";
import * as accounts from "./accounts";
import * as discovery from "./discovery";
import * as integration from "./integration";
import * as os from "./os";
/** A runtime's launcher list with nothing taken out. */
const nothingRemoved = () => ({
  agent_hidden: byProvider(() => false),
  account_hidden: [] as string[],
  agent_commands: [] as Entry[],
});
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
test("cached previews neither create jobs nor refresh old ones", async () => {
  const server: any = { runtime: { ...nothingRemoved(), getWorkspace: () => ({ cwd: "/tmp" }) } },
    messages: any[] = [],
    client: any = { queue: (value: any) => messages.push(value) },
    s = service(server),
    pump = spyOn(s.launch_previews, "pump"),
    follow = spyOn(s, "follow"),
    snapshot = spyOn(s.launch_previews, "cached"),
    cached = (cwd = "") =>
      request(server, client, {
        op: "agent.preview.cached",
        payload: protocol.decode("agent.preview.cached", { workspace: 1, cwd }),
      });
  try {
    await cached();
    expect(messages[0].preview.pending).toBe(false);
    expect(s.launch_previews.jobs).toHaveLength(0);
    const before = new Preview().with({ pending: false }),
      job = {
        cwd: "/tmp",
        preview: before,
        queued: false,
        updated: 1,
        used: 2,
        accessing: false,
        request_access: false,
      };
    s.launch_previews.jobs.push(job);
    await cached();
    expect(messages[1].preview).toEqual(messages[0].preview);
    expect(snapshot).toHaveBeenLastCalledWith("/tmp");
    await cached("/tmp/other");
    expect(snapshot).toHaveBeenLastCalledWith("/tmp/other");
    expect(job).toMatchObject({ queued: false, updated: 1, used: 2 });
    expect(pump).not.toHaveBeenCalled();
    expect(follow).not.toHaveBeenCalled();
  } finally {
    pump.mockRestore();
    follow.mockRestore();
    snapshot.mockRestore();
    await stop(server);
  }
});

test("new preview subscribers refresh sign-in after a pending pass", async () => {
  const server: any = { runtime: { ...nothingRemoved(), getWorkspace: () => ({ cwd: "/tmp" }) } },
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
    expect(s.launch_previews.jobs[0].queued).toBe(true);
    const pending = s.launch_previews.pump();
    finish();
    await pending;
    expect(reads).toBe(2);
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
    expect(reads).toBe(2);
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
  const server: any = { clients: [], runtime: nothingRemoved() },
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
test("a saved command keeps its provider's default read once its row is taken out", () => {
  const command = (source: string, provider: "codex" | "pi", default_account: boolean, hidden = false) => {
    const e = new Entry();
    e.set(source);
    e.hidden = hidden;
    Object.assign(e.semantics, { provider, default_account });
    return e;
  };
  const runtime = {
      ...nothingRemoved(),
      agent_hidden: byProvider(p => p === "codex" || p === "pi"),
      agent_commands: [
        command("codex --search", "codex", true),
        command("CODEX_HOME=/elsewhere codex", "codex", false),
        command("pi --fast", "pi", true, true),
        new Entry(),
      ],
    },
    server: any = { clients: [], runtime },
    s = service(server);
  s.launch_previews.sample = () => {};
  try {
    sample(server);
    expect(s.launch_previews.removed.commands).toEqual([{ provider: "codex", account: "" }]);
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

test("a pending preview the worker hasn't replaced skips serialization", async () => {
  const server: any = {},
    messages: any[] = [],
    s = service(server);
  const sent = new Preview().with({ pending: false }),
    pending = new Preview().with({ pending: true });
  const client: any = {
    dead: false,
    output: Buffer.alloc(0),
    queue: (value: any) => messages.push(value),
    launch_preview: {
      cwd: "/tmp",
      preview: sent,
      checked: 0,
      history_asked: false,
      history_epoch: 0n,
      history_sent: 0n,
    },
  };
  s.launch_previews.preview = () => pending;
  const check = () => {
    client.launch_preview.checked = 0;
    publish(server, client);
  };
  try {
    check();
    expect(client.launch_preview.preview).not.toBe(pending);
    const serialize = spyOn(client.launch_preview.preview.options.codex, "toJSON");
    try {
      check();
      expect(serialize).not.toHaveBeenCalled();
    } finally {
      serialize.mockRestore();
    }
  } finally {
    await stop(server);
  }
});

test("a subscription is due only while the worker holds a preview it wasn't sent", async () => {
  const server: any = {},
    messages: any[] = [],
    s = service(server);
  s.launch_previews.pump = async () => {};
  const sent = new Preview().with({ pending: false }),
    client: any = {
      dead: false,
      output: Buffer.alloc(0),
      queue: (value: any) => messages.push(value),
      launch_preview: {
        cwd: "/tmp",
        preview: sent,
        checked: 0,
        history_asked: false,
        history_epoch: 0n,
        history_sent: 0n,
      },
    },
    job = { cwd: "/tmp", preview: sent, updated: 0, used: 0, queued: false, accessing: false, request_access: false };
  s.launch_previews.jobs = [job];
  s.launch_previews.preview = () => job.preview;
  try {
    expect(due(server, client)).toBe(false);
    job.preview = sent.with({ names: { ...sent.names, codex: "work" } });
    expect(due(server, client)).toBe(true);
    publish(server, client);
    expect(messages).toHaveLength(1);
    expect(due(server, client)).toBe(false);
    expect(due(server, { launch_preview: null } as any)).toBe(false);
  } finally {
    await stop(server);
  }
});

test("install-on-use processes rescan once even when the installed version is unsupported", async () => {
  const server: any = {},
    cwd = spyOn(os, "processCwd").mockReturnValue("/workspace/local"),
    executable = spyOn(os, "processPath").mockReturnValue("/installed/bin/pi"),
    onDemand = spyOn(discovery, "onDemand").mockReturnValue(true),
    installed = spyOn(discovery, "installed").mockReturnValue(false),
    prepare = spyOn(integration, "prepare").mockResolvedValue(),
    rescan = spyOn(discovery, "rescan").mockResolvedValue();
  try {
    const settle = () => new Promise(resolve => setImmediate(resolve));
    // Every hook a running agent sends asks; only the first from each process finds again.
    for (let i = 0; i < 3; i++) agentRan(server, "pi", 42);
    await settle();
    agentRan(server, "pi", 42);
    await settle();
    expect(rescan.mock.calls).toEqual([[["pi"], "/workspace/local"]]);
    expect(onDemand).toHaveBeenCalledWith("pi", "/workspace/local");
    agentRan(server, "pi", 43);
    await settle();
    expect(rescan).toHaveBeenCalledTimes(2);
    // Once it's found, nothing asks.
    onDemand.mockReturnValue(false);
    agentRan(server, "pi", 44);
    await settle();
    expect(rescan).toHaveBeenCalledTimes(2);
  } finally {
    cwd.mockRestore();
    executable.mockRestore();
    onDemand.mockRestore();
    installed.mockRestore();
    prepare.mockRestore();
    rescan.mockRestore();
    await stop(server);
  }
});

for (const previewFound of [false, true])
  test(`mise handing off the same PID sets up the installed agent (preview found it: ${previewFound})`, async () => {
    const server: any = {},
      cwd = spyOn(os, "processCwd").mockReturnValue("/workspace/local"),
      executable = spyOn(os, "processPath").mockReturnValue("/bin/mise"),
      onDemand = spyOn(discovery, "onDemand").mockReturnValue(true),
      installed = spyOn(discovery, "installed").mockReturnValue(false),
      known = spyOn(accounts, "known").mockReturnValue([
        { provider: "codex", dir: "/accounts/work", name: "work", managed: false },
      ]),
      prepare = spyOn(integration, "prepare").mockResolvedValue(),
      rescan = spyOn(discovery, "rescan").mockImplementation(async () => {
        installed.mockReturnValue(true);
      }),
      settle = () => new Promise(resolve => setImmediate(resolve));
    try {
      for (let i = 0; i < 3; i++) agentRan(server, "codex", 42);
      await settle();
      expect(rescan).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      // The preview may discover the executable while mise still owns the PID.
      installed.mockReturnValue(previewFound);
      onDemand.mockReturnValue(!previewFound);
      agentRan(server, "codex", 42);
      await settle();
      expect(rescan).not.toHaveBeenCalled();
      executable.mockReturnValue("/installed/bin/codex");
      for (let i = 0; i < 3; i++) agentRan(server, "codex", 42);
      await settle();
      agentRan(server, "codex", 42);
      await settle();
      expect(rescan.mock.calls).toEqual([[["codex"], "/workspace/local"]]);
      expect(prepare.mock.calls).toEqual([
        ["codex", "", false, "/workspace/local"],
        ["codex", "/accounts/work", false, "/workspace/local"],
      ]);
    } finally {
      cwd.mockRestore();
      executable.mockRestore();
      onDemand.mockRestore();
      installed.mockRestore();
      known.mockRestore();
      prepare.mockRestore();
      rescan.mockRestore();
      await stop(server);
    }
  });

test("Find agents rescans the requested workspace rather than the daemon directory", async () => {
  const server: any = {},
    installed = spyOn(discovery, "installed").mockReturnValue(false),
    rescan = spyOn(discovery, "rescan").mockResolvedValue();
  try {
    await discover(server, ["pi"], "/workspace/local");
    expect(rescan.mock.calls).toEqual([[["pi"], "/workspace/local"]]);
    expect(installed.mock.calls).toEqual([["pi", "/workspace/local"]]);
  } finally {
    installed.mockRestore();
    rescan.mockRestore();
    await stop(server);
  }
});
