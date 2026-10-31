import { expect, test, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, modelRef, tokens } from "./api";
import { adapter } from "./index";
import { open } from "./launcher";
import { prepare } from "./launch";
import { entry } from "./history";
import { Engine } from "./worker";
import { snapshot } from "./observer";
import { Text } from "../common";
import { Info, Text as AccountText, Window } from "../../usage/account";
import type { Event } from "../adapter";
import { Session } from "../../headless";
import { Registry } from "../../conversations";
import { Stdio } from "../stdio";
import { OpenCode2 } from "./headless";
import * as catalog from "./catalog";
import { Quit } from "../../subprocess";
const id = "ses_test123",
  usage = { input: 10, output: 5, reasoning: 3, cache: { read: 7, write: 2 } };
const info = {
  id,
  location: { directory: "/tmp" },
  time: { updated: 1000 },
  title: "Test",
  tokens: usage,
  model: { providerID: "openai", id: "gpt-5.5" },
};
function preference(recent: unknown[], variant: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "corgi-opencode-")),
    previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  mkdirSync(join(root, "opencode"));
  writeFileSync(join(root, "opencode", "model.json"), JSON.stringify({ recent, variant }));
  return () => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  };
}
function jwt(claims: unknown) {
  return "e30." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".signature";
}
test("OpenCode discovery rejects v1 and preserves launch choices", () => {
  expect(adapter.version!("opencode v2.1.2\n")).toBe(true);
  expect(adapter.version!("1.2.3\n")).toBe(false);
  expect(adapter.launch.resume(id)).toEqual(["--session", id]);
  expect(adapter.launch.fork({ session: "bad/session", transcript: "", cwd: "/tmp" }, null)).toBeNull();
  expect(adapter.launch.start({ permissions: "bypass", model: "openai/gpt-5.5#high", args: [] })).toEqual([
    "--auto",
    "--model",
    "openai/gpt-5.5#high",
  ]);
  expect(modelRef("openai/gpt-5.5#high")).toEqual({ providerID: "openai", id: "gpt-5.5", variant: "high" });
  expect(() => modelRef("gpt-5.5")).toThrow("InvalidOpenCodeModel");
});
test("tokens include cached input and reasoning without double counting", () => {
  expect(tokens(usage)).toMatchObject({ input: 19n, cached_input: 7n, output: 8n });
});
test("launcher accepts an absent default model", async () => {
  const peek = spyOn(API, "peek").mockImplementation((_cwd, read) => read(new API("unused"))),
    call = spyOn(API.prototype, "call").mockResolvedValue({ data: null });
  try {
    const launcher = await adapter.launcher!(""),
      quit = new Quit();
    expect(await launcher.model("/tmp", quit)).toMatchObject({ model: "" });
    call.mockResolvedValue({ data: info.model });
    expect(await launcher.model("/tmp", quit)).toMatchObject({ model: "openai/gpt-5.5" });
    launcher.close();
  } finally {
    peek.mockRestore();
    call.mockRestore();
  }
});
test("launcher names the model its TUI last selected and marks a free plan", async () => {
  const restore = preference([{ providerID: "opencode", modelID: "deepseek-v4.1-flash-free" }], {
      "opencode/deepseek-v4.1-flash-free": "high",
    }),
    catalog = {
      id: "deepseek-v4.1-flash-free",
      providerID: "opencode",
      name: "DeepSeek V4.1 Flash Free",
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    },
    peek = spyOn(API, "peek").mockImplementation((_cwd, read) => read(new API("unused"))),
    call = spyOn(API.prototype, "call").mockImplementation(async (_method, path) => {
      if (path.startsWith("/api/model?")) return { data: [catalog] };
      if (path === "/api/model/default") return { data: catalog };
      return { data: [] };
    });
  try {
    const launcher = await adapter.launcher!(""),
      quit = new Quit();
    expect(await launcher.model("/tmp", quit)).toEqual({
      model: "opencode/deepseek-v4.1-flash-free#high",
      model_name: "DeepSeek V4.1 Flash Free",
      source: "OpenCode's selected model",
    });
    const info = await launcher.account(quit, 600);
    expect(info.account.text()).toBe("OpenCode");
    expect(info.plan.text()).toBe("Free");
    expect(info.limits).toBe("none");
    launcher.close();
  } finally {
    peek.mockRestore();
    call.mockRestore();
    restore();
  }
});
test("launcher shows the shared ChatGPT account for an OpenAI model", async () => {
  const restore = preference([{ providerID: "openai", modelID: "gpt-6.1-sol" }]),
    catalog = { id: "gpt-6.1-sol", providerID: "openai", name: "GPT-6.1 Sol", cost: [] },
    shared = new Info(),
    peek = spyOn(API, "peek").mockImplementation((_cwd, read) => read(new API("unused"))),
    call = spyOn(API.prototype, "call").mockImplementation(async (_method, path) => {
      if (path.startsWith("/api/model?")) return { data: [catalog] };
      if (path === "/api/model/default") return { data: catalog };
      if (path === "/api/credential")
        return {
          data: [
            {
              integrationID: "openai",
              label: "OpenAI",
              active: true,
              value: { type: "oauth", methodID: "chatgpt-token-sharing", access: "" },
            },
          ],
        };
      if (path === "/api/provider") return { data: [{ id: "openai", name: "OpenAI" }] };
      return { data: [] };
    });
  shared.signed_in = true;
  shared.account = new AccountText("toasty.tal@gmail.com");
  shared.plan = new AccountText("Pro 500");
  shared.limits = {
    windows: [
      new Window({ minutes: 300, used: 12, reset_at: 1800000000 }),
      new Window({ minutes: 10080, used: 49, reset_at: 1800500000 }),
    ],
  };
  try {
    const launcher = open("", async () => shared),
      info = await launcher.account(new Quit(), 600);
    expect(info.account.text()).toBe("toasty.tal@gmail.com");
    expect(info.plan.text()).toBe("Pro 500");
    expect(info.limits).toMatchObject({
      windows: [
        { used: 12, minutes: 300 },
        { used: 49, minutes: 10080 },
      ],
    });
    launcher.close();
  } finally {
    peek.mockRestore();
    call.mockRestore();
    restore();
  }
});
test("launcher uses browser OAuth's own account even with a provider alias and a different Codex login", async () => {
  const restore = preference([{ providerID: "my-openai", modelID: "gpt-5.5" }]),
    catalog = { id: "gpt-5.5", providerID: "my-openai", name: "GPT-5.5", cost: [] },
    credential = {
      type: "oauth",
      methodID: "chatgpt-browser",
      access: jwt({
        email: "fallback@example.com",
        "https://api.openai.com/auth": { chatgpt_plan_type: "pro" },
      }),
    },
    peek = spyOn(API, "peek").mockImplementation((_cwd, read) => read(new API("unused"))),
    call = spyOn(API.prototype, "call").mockImplementation(async (_method, path) => {
      if (path.startsWith("/api/model?")) return { data: [catalog] };
      if (path === "/api/model/default") return { data: catalog };
      if (path === "/api/credential")
        return { data: [{ integrationID: "openai", label: "OAuth", active: true, value: credential }] };
      if (path === "/api/provider") return { data: [{ id: "my-openai", integrationID: "openai", name: "OpenAI" }] };
      return { data: [] };
    });
  let lookups = 0;
  try {
    const launcher = open("", async () => {
        lookups++;
        return Object.assign(new Info(), { signed_in: true, account: new AccountText("different@example.com") });
      }),
      info = await launcher.account(new Quit(), 600);
    expect(info.account.text()).toBe("fallback@example.com");
    expect(info.plan.text()).toBe("Pro 200");
    expect(lookups).toBe(0);
    launcher.close();
  } finally {
    peek.mockRestore();
    call.mockRestore();
    restore();
  }
});
test("private inference denies tools and reports usage before completing its JSON answer", async () => {
  const calls: unknown[][] = [],
    events: Event[] = [],
    mock = spyOn(API.prototype, "call").mockImplementation(async (...args) => {
      calls.push(args);
      const [method, path] = args;
      if ((method === "POST" && path === "/api/session") || path === `/api/session/${id}`) return { data: info };
      if (path.endsWith("/context"))
        return {
          data: [
            { id: "msg_u", type: "user", text: "Summarize" },
            {
              id: "msg_a",
              type: "assistant",
              time: { completed: 1 },
              tokens: usage,
              content: [{ type: "text", text: '{"summary":"Done"}' }],
            },
            { id: "msg_i", type: "idle", outcome: "succeeded" },
          ],
        };
      return { data: [] };
    });
  try {
    const engine = new Engine(new API("unused", "/tmp"), e => events.push(e), {
      instructions: "Be concise",
      model: "openai/gpt-5.5",
      schema: '{"type":"object"}',
    });
    await engine.start();
    await engine.send({ kind: "prompt", text: "Summarize" });
    await engine.poll();
    expect(calls[0]).toEqual([
      "POST",
      "/api/session",
      {
        location: { directory: "/tmp" },
        title: "Corgi inference",
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
        model: { providerID: "openai", id: "gpt-5.5" },
      },
    ]);
    expect(calls[1]).toEqual([
      "POST",
      `/api/session/${id}/prompt`,
      {
        text: 'Be concise\nReturn only JSON matching this schema:\n{"type":"object"}\n\nSummarize',
        delivery: "steer",
      },
    ]);
    expect(events.filter(e => e.kind === "message")).toEqual([
      { kind: "message", session: id, text: '{"summary":"Done"}' },
    ]);
    expect(events.findIndex(e => e.kind === "usage")).toBeLessThan(
      events.findIndex(e => e.kind === "turn" && e.phase === "ended"),
    );
  } finally {
    mock.mockRestore();
  }
});
test("terminal preparation forks through the API and strips internal options", async () => {
  const saved = process.env.OPENCODE_CLI_CONFIG_CONTENT;
  delete process.env.OPENCODE_CLI_CONFIG_CONTENT;
  const calls: unknown[][] = [];
  const mock = spyOn(API.prototype, "call").mockImplementation(async (...args) => {
    calls.push(args);
    return { data: info };
  });
  try {
    const result = await prepare(
      ["--auto", "--model", "openai/gpt-5.5", "--corgi-fork", "ses_parent", "--corgi-name", "Fork"],
      "opencode",
    );
    expect(result.args).toEqual(["--auto", "--session", id]);
    expect(result.env).toEqual([
      ["OPENCODE_CLI_CONFIG_CONTENT", '{"session":{"sidebar":"hide"},"tabs":{"mode":"off"}}'],
    ]);
    expect(result.event).toMatchObject({ session_id: id, cwd: "/tmp", permission_mode: "bypassPermissions" });
    expect(calls).toEqual([
      ["POST", "/api/session/ses_parent/fork", {}],
      ["PATCH", `/api/session/${id}`, { title: "Fork" }],
      ["POST", `/api/session/${id}/model`, { model: { providerID: "openai", id: "gpt-5.5" } }],
    ]);
  } finally {
    mock.mockRestore();
    if (saved !== undefined) process.env.OPENCODE_CLI_CONFIG_CONTENT = saved;
  }
});
test("help and auth do not create sessions; unsupported transports fail before mutation", async () => {
  const mock = spyOn(API.prototype, "call").mockRejectedValue(Error("UnexpectedCall"));
  try {
    expect(await prepare(["auth", "login"], "opencode")).toEqual({ args: ["auth", "login"] });
    expect(await prepare(["--help"], "opencode")).toEqual({ args: ["--help"] });
    await expect(prepare(["--standalone"], "opencode")).rejects.toThrow("OpenCodeStandaloneUnsupported");
    await expect(prepare(["--server", "https://example.com"], "opencode")).rejects.toThrow("OpenCodeRemoteUnsupported");
    expect(mock).not.toHaveBeenCalled();
  } finally {
    mock.mockRestore();
  }
});
test("an inline CLI config the user set is left alone", async () => {
  const saved = process.env.OPENCODE_CLI_CONFIG_CONTENT;
  process.env.OPENCODE_CLI_CONFIG_CONTENT = '{"session":{"sidebar":"auto"}}';
  const mock = spyOn(API.prototype, "call").mockImplementation(async () => ({ data: info }));
  try {
    expect((await prepare([], "opencode")).env).toEqual([]);
  } finally {
    mock.mockRestore();
    if (saved === undefined) delete process.env.OPENCODE_CLI_CONFIG_CONTENT;
    else process.env.OPENCODE_CLI_CONFIG_CONTENT = saved;
  }
});
test("history normalizes milliseconds and excludes children and invalid identities", () => {
  expect(entry({ ...info, time: { updated: 1792775115335 } })).toMatchObject({
    provider: "opencode2",
    session: id,
    title: "Test",
    cwd: "/tmp",
    updated_at: 1792775115,
  });
  expect(entry({ ...info, parentID: "ses_parent" })).toBeNull();
  expect(entry({ ...info, id: "../bad" })).toBeNull();
});
test("projected messages deduplicate tools, streaming text and turn completions", () => {
  const events: Event[] = [],
    engine = new Engine(new API("unused", "/tmp"), e => events.push(e));
  const user = { id: "msg_user", type: "user", text: "Hello" },
    running = { id: "msg_assistant", type: "assistant", time: {}, content: [{ type: "tool", id: "tool", time: {} }] };
  engine.decode(id, [user, running]);
  engine.decode(id, [user, running]);
  const done = {
      ...running,
      time: { completed: 1 },
      tokens: usage,
      content: [
        { type: "tool", id: "tool", time: { completed: 1 } },
        { type: "text", text: "Done" },
      ],
    },
    idle = { id: "msg_idle", type: "idle", outcome: "succeeded" };
  engine.decode(id, [user, done, idle]);
  engine.decode(id, [user, done, idle]);
  expect(events.map(e => e.kind)).toEqual(["turn", "tool", "tool", "message", "turn"]);
  expect(events.at(-1)).toMatchObject({ phase: "ended", turn: "msg_user", outcome: "completed" });
});
test("headless requests use session-specific approval, form and interrupt endpoints", async () => {
  const calls: unknown[][] = [],
    mock = spyOn(API.prototype, "call").mockImplementation(async (...args) => {
      calls.push(args);
      return null;
    });
  try {
    const engine = new Engine(new API("unused"), () => {});
    engine.session = id;
    engine.requests.set("per_one", { session: id, form: false });
    engine.requests.set("frm_one", { session: id, form: true });
    await engine.send({ kind: "answer", request: "per_one", allow: true });
    await engine.send({ kind: "answer", request: "frm_one", allow: true, message: '{"answer":"yes"}' });
    await engine.send({ kind: "interrupt" });
    await expect(engine.send({ kind: "prompt", text: "x", session: "ses_someoneelse" })).rejects.toThrow(
      "InvalidSession",
    );
    expect(calls).toEqual([
      ["POST", `/api/session/${id}/permission/per_one/reply`, { decision: "once" }],
      ["POST", `/api/session/${id}/form/frm_one/reply`, { answer: { answer: "yes" } }],
      ["POST", `/api/session/${id}/interrupt?resume=false`],
    ]);
  } finally {
    mock.mockRestore();
  }
});
test("externally closed requests report whether their conversation is still running", async () => {
  let running = true;
  const events: Event[] = [],
    mock = spyOn(API.prototype, "call").mockImplementation(async (_method, path) => {
      if (path === `/api/session/${id}`) return { data: info };
      if (path.endsWith("/context"))
        return {
          data: [
            { type: "user", id: "msg_u", text: "Hello" },
            ...(!running ? [{ type: "idle", id: "msg_i", outcome: "succeeded" }] : []),
          ],
        };
      return { data: [] };
    });
  try {
    const engine = new Engine(new API("unused"), e => events.push(e));
    engine.session = id;
    engine.requests.set("per_one", { session: id, form: false });
    engine.requests.set("frm_child", { session: "ses_child", form: true });
    await engine.poll();
    running = false;
    engine.requests.set("frm_one", { session: id, form: true });
    await engine.poll();
    expect(events.filter(e => e.kind === "request_closed")).toEqual([
      { kind: "request_closed", session: id, id: "per_one", running: true },
      { kind: "request_closed", session: id, id: "frm_one", running: false },
    ]);
    expect([...engine.requests.keys()]).toEqual(["frm_child"]);
  } finally {
    mock.mockRestore();
  }
});
test("snapshot reports identity, usage, completion and model from the provider", async () => {
  const mock = spyOn(API.prototype, "call").mockImplementation(async (_method, path) => {
    if (path === `/api/session/${id}`) return { data: info };
    if (path.endsWith("/context"))
      return {
        data: [
          { type: "user", id: "msg_u", text: "Hello" },
          { type: "idle", id: "msg_i", outcome: "interrupted" },
        ],
      };
    return { data: [] };
  });
  try {
    const value = await snapshot(
      new API("unused"),
      { pane: 0, pid: 0, actor: 1, generation: 0n, title_revision: 0n, prefix: new Text(id) },
      {},
    );
    expect(value.state).toBe("idle");
    expect(value.outcome).toBe("interrupted");
    expect(value.turn.text()).toBe("msg_u");
    expect(value.model).toBe("openai/gpt-5.5");
    expect(value.usage?.total.input).toBe(19n);
    expect(value.usage?.last).toBeNull();
    expect(value.context).toBeNull();
  } finally {
    mock.mockRestore();
  }
});
test("a session whose model the catalog lists reports its context window use", async () => {
  const mock = spyOn(API.prototype, "call").mockImplementation(async (_method, path) => {
    if (path === `/api/session/${id}`) return { data: info };
    if (path.endsWith("/context"))
      return {
        data: [
          { type: "user", id: "msg_u", text: "Hello" },
          { type: "assistant", id: "msg_a", text: "Done", time: { completed: 2 }, tokens: usage },
        ],
      };
    return { data: [] };
  });
  try {
    const value = await snapshot(
      new API("unused"),
      { pane: 0, pid: 0, actor: 1, generation: 0n, title_revision: 0n, prefix: new Text(id) },
      {},
      new Map([["openai/gpt-5.5", 4000n]]),
    );
    expect(value.usage?.last?.input).toBe(19n);
    expect(value.usage?.last?.cached_input).toBe(7n);
    expect(value.usage?.last?.output).toBe(8n);
    expect(value.context?.window).toBe(4000n);
    expect(value.context?.used).toBe(27n);
    expect(value.context?.model.id.text()).toBe("openai/gpt-5.5");
  } finally {
    mock.mockRestore();
  }
});
test("terminal catalog metadata keeps variant identity and reaches the conversation", async () => {
  const mock = spyOn(API.prototype, "call").mockImplementation(async (_method, path) => {
    if (path === `/api/session/${id}`)
      return { data: { ...info, model: { providerID: "custom", id: "future", variant: "high" } } };
    return { data: [] };
  });
  try {
    const models = catalog.read({
        data: [{ providerID: "custom", id: "future", name: "Future Model", cost: [{ input: 1, output: 5 }] }],
      }),
      registry = new Registry(),
      actor = registry.get("opencode2", id),
      value = await snapshot(
        new API("unused"),
        { pane: 0, pid: 0, actor: actor.id, generation: 0n, title_revision: 0n, prefix: new Text(id) },
        {},
        new Map(),
        models,
      );
    actor.observeSnapshot(value, true, value.observed_at);
    expect(actor.model.id.text()).toBe("custom/future#high");
    expect(actor.model.name.text()).toBe("Future Model (high)");
    expect(actor.model.price).toEqual({ label: "Future Model", input: 1000n, output: 5000n });
    expect(models.get("custom/future")?.id.text()).toBe("custom/future");
  } finally {
    mock.mockRestore();
  }
});
test("pipe token counters normalize to bigint before the headless core sees them", () => {
  const io = new Stdio(),
    mock = spyOn(io, "read").mockReturnValue([
      {
        event: {
          kind: "usage",
          session: id,
          turn: "",
          total: { total: { input: 19, cached_input: 7, output: 8 }, last: null },
        },
      },
    ]);
  try {
    const client = new OpenCode2(io),
      session = new Session(1, "opencode2", "/tmp", client),
      registry = new Registry();
    session.poll(registry);
    expect(registry.find("opencode2", id)?.headless_meter.previous?.input).toBe(19n);
  } finally {
    mock.mockRestore();
    io.close();
  }
});
