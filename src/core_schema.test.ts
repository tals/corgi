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
import { parseLabel } from "./activity/summary";
import { captureManifest } from "./persist/handoff";
import { checkpoint_version, handoff_version } from "./persist/migrations";
import { validateCheckpoint } from "./persist/schema";

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
  const actor = server.runtime.conversations.get("codex", "schema-session");
  actor.workspace = 1;
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
  expect(protocol.version).toBe(1);
  expect(createHash("sha256").update(schemas.protocol).digest("hex")).toBe(
    "4091d68e01ba45e19eff276527c9cb806368bfa9ff6f17498d2e4c8c55675a92",
  );
  const { server, dispose } = fixture();
  try {
    const snapshot = json.parse(json.stringify(session.snapshot(server.runtime)));
    validate(schemas.protocol, { snapshot });
    expect(snapshot.panes[0].agent.session).toBe("schema-session");
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
    "26de6495b69997a9821764a11c34c1515919fa87f248c8a45ac7555c71e98814",
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
  expect(handoff_version).toBe(4);
  expect(checkpoint_version).toBe(5);
  expect(createHash("sha256").update(schemas.handoff).digest("hex")).toBe(
    "31dff96b92b603147f91cc98cb0fb6e0e429a5095135458bf7b7ea20af1be2fe",
  );
  const { server, client, dispose } = fixture();
  const summaries = new Worker();
  const request = new Request();
  request.conversation.remember("turn", "Running tests", parseLabel("Running tests")!);
  summaries.slots[0] = new Slot(request);
  summaries.slots[0].result = new Result(request, parseLabel("Running unit tests"), "amend");
  (server as any).summaries = summaries;
  await summaries.pause();
  try {
    const captured = json.parse(json.stringify(captureManifest(server, client)));
    validate(schemas.handoff, captured);
    validateCheckpoint(captured.runtime);
    expect(captured.runtime.panes[0].binding.actor).toBe(1);
    expect(captured.clients).toHaveLength(1);
    expect(captured.summaries.pool.slots).toHaveLength(4);
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
