import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as protocol from "./protocol";
import * as json from "./json";
import * as session from "./session";
import * as viewer from "./viewer_protocol";
import { Server } from "./server";
import { Client } from "./peer";
import { Pane } from "./runtime";
import { Workspace } from "./workspace";
import { Terminal } from "./pane/terminal";
import { Worker, Request, Result, Slot } from "./activity/worker";
import { Worker as UsageWorker, Tail } from "./usage/worker";
import { parseLabel } from "./activity/summary";
import { captureManifest } from "./persist/handoff";
import { checkpoint_version, handoff_version } from "./persist/migrations";
import { validateCheckpoint } from "./persist/schema";
import { Preview } from "./launch/preview";
import { preview as restorePreview } from "./agent_launcher";
import { Option } from "./inference/models";

const schemas = Object.fromEntries(
  ["protocol", "viewer", "handoff"].map(name => [
    name,
    readFileSync(new URL(`./fixtures/${name}.schema`, import.meta.url), "utf8"),
  ]),
);

// Runtime conformance replaces Zig's compile-time reflected-type comparison.
// Branches absent from the captured value are covered by their module tests.
function validate(schema: string, value: unknown): void {
  for (const line of schema.trim().split("\n")) {
    const [path, type] = line.split(": ");
    let values: any[] = [value];
    for (const token of path.slice(1).matchAll(/\.([^.[?|]+)|\[(\d*)\]|(\?)|\|([^.[?|]+)/g)) {
      if (token[1] || token[4]) {
        const name = token[1] ?? token[4];
        values = values.flatMap(item => (item && Object.hasOwn(item, name) ? [item[name]] : []));
      } else if (token[2] !== undefined) {
        values = values.flatMap(item => {
          expect(Array.isArray(item), path).toBe(true);
          if (token[2]) expect(item.length, path).toBe(Number(token[2]));
          return item;
        });
      } else values = values.filter(item => item !== null);
    }
    for (const item of values) {
      if (type === "any" || type === "optional" || type.startsWith("versioned ")) continue;
      if (type === "one of") {
        expect(typeof item, path).toBe("object");
        expect(Object.keys(item), path).toHaveLength(1);
        const tags = schema
          .split("\n")
          .filter(line => line.startsWith(path + "|"))
          .map(line => line.slice(path.length + 1).split(/[.:|?\[]/)[0]);
        expect(tags, path).toContain(Object.keys(item)[0]);
      } else if (type.startsWith("enum ")) expect(type.slice(5).split(" "), path).toContain(item);
      else if (type === "bool") expect(typeof item, path).toBe("boolean");
      else if (type === "{}") expect(item, path).toEqual({});
      else if (type === "string" || type.startsWith("custom bounded_text.")) {
        expect(typeof item === "string" || Array.isArray(item), path).toBe(true);
        const length = typeof item === "string" ? Buffer.byteLength(item) : item.length;
        const capacity = type.match(/\((\d+)\)/);
        if (capacity) expect(length, path).toBeLessThanOrEqual(Number(capacity[1]));
      } else if (/^(?:[ui]\d+|usize|c_int)$/.test(type)) {
        expect(typeof item === "bigint" || (typeof item === "number" && Number.isInteger(item)), path).toBe(true);
        const bits = type === "usize" ? 64 : type === "c_int" ? 32 : Number(type.slice(1));
        const signed = type.startsWith("i") || type === "c_int";
        const n = BigInt(item);
        expect(n, path).toBeGreaterThanOrEqual(signed ? -(1n << BigInt(bits - 1)) : 0n);
        expect(n, path).toBeLessThanOrEqual((1n << BigInt(signed ? bits - 1 : bits)) - 1n);
      } else if (/^f\d+$/.test(type)) expect(typeof item, path).toBe("number");
    }
  }
}

function fixture() {
  const server = new Server("", "", "0".repeat(64));
  const workspace = new Workspace(1, "/tmp");
  server.runtime.workspaces.items.push(workspace);
  server.runtime.workspaces.next_id = 2;
  const terminal = new Terminal(80, 24);
  terminal.feed("schema boundary");
  const pane = new Pane(1, terminal, "/tmp");
  workspace.model.newTab("schema");
  server.runtime.panes.push(pane);
  server.runtime.inference.available.push(
    Object.assign(new Option(), {
      provider: "opencode2",
      model: "openai/gpt-6-luna",
      name: "GPT-6 Luna",
      plan: "Pro 500",
      subscription: true,
    }),
  );
  const actor = server.runtime.conversations.get("codex", "schema-session");
  actor.workspace = 1;
  actor.model.price = { label: "catalog", input: 1250n, output: 5000n };
  pane.attachment.select(actor);
  const loop = (server as any).loop;
  const client = new Client(
    -1,
    loop,
    () => {},
    () => {},
    false,
  );
  server.clients.push(client);
  const preview = new Preview();
  preview.options.claude.limits = "metered";
  preview.options.claude.spend = {
    used_minor: 59,
    limit_minor: null,
    currency: "USD",
    exponent: 2,
    period_start: 1790812800,
    reset_at: 1793491200,
  };
  preview.options.codex.limits = "metered";
  preview.options.codex.spend = {
    used_minor: 38820,
    limit_minor: 25000000,
    currency: null,
    exponent: 2,
    period_start: 1790812800,
    reset_at: 1793491200,
  };
  client.launch_preview = {
    cwd: "/tmp",
    preview,
    checked: 0,
    history_asked: false,
    history_epoch: 0n,
    history_sent: 0n,
  };
  return {
    server,
    client,
    dispose() {
      server.runtime.destroy();
      loop.close();
    },
  };
}

test("the runtime wire matches protocol.version", () => {
  expect(protocol.version).toBe(3);
  expect(createHash("sha256").update(schemas.protocol).digest("hex")).toBe(
    "c6cc7c3651313af30742a6b3edda9c63cfd494ffbe601c899807aed449dbdfaf",
  );
  const { server, client, dispose } = fixture();
  try {
    const snapshot = json.parse(json.stringify(session.snapshot(server.runtime)));
    validate(schemas.protocol, { snapshot });
    const preview = json.parse(json.stringify(client.launch_preview!.preview));
    validate(schemas.protocol, { launch_preview: preview });
    expect(restorePreview(preview).options.claude.spend).toEqual(client.launch_preview!.preview.options.claude.spend);
    expect(restorePreview(preview).options.codex.spend).toEqual(client.launch_preview!.preview.options.codex.spend);
    delete preview.options.claude.spend;
    expect(restorePreview(preview).options.claude.spend).toBeNull();
    expect(snapshot.panes[0].agent.session).toBe("schema-session");
    expect(snapshot.conversations[0].model_price).toEqual({ label: "catalog", input: 1250, output: 5000 });
    const wrong = structuredClone(snapshot);
    wrong.panes[0].id = -1;
    expect(() => validate(schemas.protocol, { snapshot: wrong })).toThrow();
    for (const event of [null, 3, "event", [1, {}], { arbitrary: true }]) {
      const request = protocol.decode("hook", {
        provider: "codex",
        pane: 1,
        event,
      });
      validate(schemas.protocol, { requests: { hook: request } });
      expect(request.event).toEqual(event);
    }
  } finally {
    dispose();
  }
});

test("the viewer wire matches viewer_version.version", async () => {
  expect(protocol.viewer_version).toBe(3);
  expect(createHash("sha256").update(schemas.viewer).digest("hex")).toBe(
    "d4195c7c300255d9829f1c092cac2b70233f2eb8c9551f6e224c9dce02d5174f",
  );
  const { server, client, dispose } = fixture();
  let view: any;
  client.queue = value => {
    view = json.parse(json.stringify(value));
  };
  client.viewer = true;
  client.viewer_id = 1;
  client.view_workspace = 1;
  try {
    await viewer.sync(
      server,
      client,
      protocol.decode("viewer.sync", {
        interests: [{ pane: 1, cols: 80, rows: 24 }],
        focus: 1,
        workspace: 1,
        watched: false,
        active: false,
        ack: 0,
        session_hash: 0,
        resources_hash: 0,
        resources: false,
        resource_detail: null,
        worktree_detail: null,
      }),
    );
    validate(schemas.viewer, { view });
    expect(view.surfaces).toHaveLength(1);
    expect(view.surfaces[0].surface.lines.join("\n")).toContain("schema boundary");
    expect(() => validate(schemas.viewer, { view: { ...view, viewer_protocol: -1 } })).toThrow();
  } finally {
    dispose();
  }
});

test("saved handoff format matches its version", async () => {
  expect(handoff_version).toBe(6);
  expect(checkpoint_version).toBe(6);
  expect(createHash("sha256").update(schemas.handoff).digest("hex")).toBe(
    "6f038c8c4195f6d923b78a8e7298f36af38eab6c4c92e08a5c1a87d6ccc607ed",
  );
  const { server, client, dispose } = fixture();
  const summaries = new Worker();
  const request = new Request();
  request.conversation.remember("turn", "Running tests", parseLabel("Running tests")!);
  summaries.slots[0] = new Slot(request);
  summaries.slots[0].result = new Result(request, parseLabel("Running unit tests"), "amend");
  (server as any).summaries = summaries;
  await summaries.pause();
  const usage = new UsageWorker(),
    tail = Object.assign(new Tail(), { actor: 1, opened: true, inode: 7, device: 1, offset: 42 });
  usage.watchers.set(1, tail);
  server.usage = usage;
  try {
    const captured = json.parse(json.stringify(captureManifest(server, client)));
    validate(schemas.handoff, captured);
    validateCheckpoint(captured.runtime);
    expect(captured.runtime.panes[0].binding.actor).toBe(1);
    expect(captured.clients).toHaveLength(1);
    expect(captured.clients[0].launch_preview.preview.options.claude.spend.used_minor).toBe(59);
    expect(captured.summaries.pool.slots).toHaveLength(4);
    expect(captured.usage[0].position.offset).toBe(42);
    expect(() => validate(schemas.handoff, { ...captured, listener: "bad" })).toThrow();
  } finally {
    await summaries.stop();
    dispose();
  }
});

test("a schema shows a JSON value a provider or command defines as any", () => {
  const schema = "$.event: any\n$.seq: optional\n$.seq?: i64\n";
  for (const event of [null, false, 3, "event", [], { nested: [1] }]) validate(schema, { event, seq: null });
  expect(() => validate(schema, { event: {}, seq: "not an integer" })).toThrow();
});
