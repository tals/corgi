import { expect, test } from "bun:test";
import * as json from "./json";
import { Link, reply_limit } from "./link";

test("a link runs each numbered request once and answers it again from the reply it had", () => {
  const link = new Link();
  expect(link.admit(1n)).toEqual({ run: true });
  link.record(1n, { ok: true, result: { pane: 3 } });
  expect(link.admit(1n)).toEqual({ run: false, reply: { ok: true, result: { pane: 3 } } });
  // A request whose predecessor never arrived waits for it.
  expect(link.admit(3n)).toEqual({ run: false, reply: { err: "SequenceGap" } });
  expect(link.admit(2n)).toEqual({ run: true });
  link.record(2n, { err: "NoPane" });
  link.confirm(1n);
  expect(link.admit(1n)).toEqual({ run: false, reply: { err: "ReplyExpired" } });
  expect(link.admit(2n)).toEqual({ run: false, reply: { err: "NoPane" } });
});

test("a link keeps only its latest unconfirmed replies", () => {
  const link = new Link();
  for (let seq = 1n; seq <= BigInt(reply_limit) + 10n; seq++) link.record(seq, { ok: true });
  expect(link.admit(1n)).toEqual({ run: false, reply: { err: "ReplyExpired" } });
  expect(link.admit(BigInt(reply_limit) + 10n)).toEqual({ run: false, reply: { ok: true } });
});

test("a link and the viewer waiting on it survive a handoff", () => {
  const link = new Link();
  link.record(7n, { ok: true, result: { pane: 2 } });
  link.viewer = {
    viewer_id: 4,
    active_seq: 9,
    view_workspace: 1,
    controls: [{ seq: 3n, kind: "focus", id: 2 }],
    next_control: 4n,
    last_control: 2n,
  };
  link.detached_at = 1234;
  const restored = Link.restore(json.parse(json.stringify(link.capture())));
  expect(restored.id).toBe(link.id);
  expect(restored.applied).toBe(7n);
  expect(restored.admit(7n)).toEqual({ run: false, reply: { ok: true, result: { pane: 2 } } });
  expect(restored.viewer).toEqual(link.viewer);
  expect(restored.detached_at).toBe(1234);
});
