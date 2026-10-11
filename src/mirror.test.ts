import { expect, test } from "bun:test";
import { Controller } from "./controller";
import { transport } from "./fixtures/transport";
import * as json from "./json";
import * as mirror from "./mirror";
import * as viewer from "./viewer";

test("viewer scalars retain their bigint type after small and large wire replies", async () => {
  let value = 1n;
  const requests: any[] = [];
  const view = new Controller(
    transport(async (op, fields) => {
      requests.push({ op, fields });
      return json.parse(
        json.stringify({
          viewer_protocol: 3,
          session: null,
          session_hash: value,
          resources: null,
          resources_hash: value,
          viewer: 1,
          controls: [{ seq: value, kind: "focus", id: 1 }],
          surfaces: [],
          bell_seq: value,
          bell_kind: "none",
          detach: false,
        }),
      );
    }),
  );
  view.receiveSnapshot({
    workspaces: [{ id: 1, model: { nodes: [{ pane: 1 }], tabs: [{ id: 1, root: 0, title: "" }], revision: 0 } }],
    panes: [{ id: 1, cols: 80, rows: 24, binding: 1 }],
  });
  const bell = { seq: 0n };
  try {
    for (const next of [1n, 0xffffffffffffffffn]) {
      value = next;
      await viewer.sync(view, bell, false);
      expect(view.runtime.snapshot_hash).toBe(value);
      expect(view.runtime.resources_hash).toBe(value);
      expect(view.input_state.last_control).toBe(value);
      expect(bell.seq).toBe(value);
      await viewer.sync(view, bell, false);
      expect(requests.at(-1).fields.ack).toBe(value);
      expect(requests.at(-1).fields.session_hash).toBe(value);
    }
    expect(view.runtime.panes[0].binding).toBe(1n);
  } finally {
    viewer.close(view);
  }
});

test("mirrored observations keep exact completion counters", () => {
  const small = mirror.agent({ observation: { completed: 1, read: 0 } });
  expect(small.observation.completed).toBe(1n);
  expect(mirror.unread(small.observation)).toBe(true);
  const large = mirror.agent(
    json.parse('{"observation":{"completed":18446744073709551615,"read":18446744073709551614}}'),
  );
  mirror.acknowledge(large.observation, large.observation.completed);
  expect(large.observation.read).toBe(0xffffffffffffffffn);
  expect(mirror.unread(large.observation)).toBe(false);
});
