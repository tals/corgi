import { expect, test } from "bun:test";
import { baseline, History, histories, parse, supported, select } from "./formats";
import type { Revision } from "./formats";
import * as root from "./revisions/r_68139a93dee0_terminal_core_handoff_baseline";

function createHistory(current: string, revisions: Revision[]) {
  return new History(current, [root.revision, ...revisions]);
}

const a = "a".repeat(12),
  b = "b".repeat(12),
  c = "c".repeat(12);
const step = (id: string, parent: string, key: string) => ({
  id,
  parent,
  description: `Add ${key}`,
  up: (value: unknown) => ({ ...(value as object), [key]: true }),
  down: (value: unknown) => {
    const result = { ...(value as Record<string, unknown>) };
    delete result[key];
    return result;
  },
});
test("divergent branches transfer through their nearest shared state revision", () => {
  const common = step(a, baseline, "common"),
    left = createHistory(b, [common, step(b, a, "left")]),
    right = createHistory(c, [common, step(c, a, "right")]),
    original = { common: true, left: true, count: 18446744073709551615n },
    shared = select(left, supported(right)),
    exported = left.down(original, shared);
  expect(shared).toBe(a);
  expect(right.up(exported, shared)).toEqual({ common: true, right: true, count: original.count });
  expect(original).toEqual({ common: true, left: true, count: original.count });
  const back = right.down(right.up(exported, shared), a);
  expect(left.up(back, a)).toEqual(original);
});
test("unrelated metadata and baseline-only binaries always share the core", () => {
  const left = createHistory(a, [step(a, baseline, "left")]),
    right = createHistory(b, [step(b, baseline, "right")]),
    core = createHistory(baseline, []);
  for (const peer of [right, core]) {
    expect(select(left, supported(peer))).toBe(baseline);
    expect(left.down({ left: true }, baseline)).toEqual({});
  }
  expect(right.up({}, baseline)).toEqual({ right: true });
});
test("identical formats preserve their payload without invoking migrations", () => {
  const history = createHistory(a, [step(a, baseline, "extra")]),
    value = { extra: "kept" };
  expect(history.up(history.down(value, a), a)).toEqual(value);
});
test("format advertisements and migration paths reject malformed identities", () => {
  for (const value of [
    null,
    [],
    [a],
    [baseline, baseline],
    ["bad", baseline],
    [a.slice(1), baseline],
    [a + "a", baseline],
  ])
    expect(() => parse(value)).toThrow("InvalidStateFormats");
  expect(() => createHistory(a, [step(a, b, "a"), step(b, a, "b")])).toThrow("InvalidStateHistory");
  expect(() => createHistory(a, [])).toThrow("InvalidStateHistory");
  expect(() => createHistory(a, [step(a, baseline, "a"), step(a, baseline, "b")])).toThrow("InvalidStateHistory");
  expect(() => createHistory(a, [{ ...step(a, baseline, "a"), description: " " }])).toThrow("InvalidStateHistory");
  expect(() => createHistory(a, [step(a, baseline, "a"), step(b, c, "b")])).toThrow("InvalidStateHistory");
});

test("a checkout rejects sibling revisions even when only one branch is selected", () => {
  for (const revisions of [
    [step(a, baseline, "left"), step(b, baseline, "right")],
    [step(a, baseline, "common"), step(b, a, "left"), step(c, a, "right")],
    [{ ...step(a, baseline, "historical root"), parent: null }, step(b, a, "left"), step(c, a, "right")],
  ]) {
    for (const current of [baseline, b]) expect(() => createHistory(current, revisions)).toThrow("ForkedStateHistory");
  }
});

test("checkout heads must cover exactly four complete independent histories", () => {
  const next = "d".repeat(12),
    heads = { state: next, checkpoint: a, handoff: b, workspaces: c },
    revisions = [
      root.revision,
      ...[a, b, c].map(id => ({ ...step(id, baseline, "historical root"), parent: null })),
      step(next, baseline, "metadata"),
    ];
  expect(histories(heads, revisions).state.ancestors).toEqual([next, baseline]);
  expect(() => histories({ ...heads, state: baseline }, revisions)).toThrow("InvalidStateHeads");
  expect(() => histories({ ...heads, workspaces: a }, revisions)).toThrow("InvalidStateHeads");
  expect(() =>
    histories(heads, [...revisions, { ...step("e".repeat(12), baseline, "extra root"), parent: null }]),
  ).toThrow("InvalidStateHeads");
});

test("descriptions and migration order do not change revision identity", () => {
  const original = createHistory(b, [step(a, baseline, "common"), step(b, a, "next")]),
    edited = createHistory(b, [
      { ...step(b, a, "next"), description: "Clarify the migration description" },
      step(a, baseline, "common"),
    ]);
  expect(supported(edited)).toEqual(supported(original));
  expect(select(edited, supported(original))).toBe(b);
});

test("historical roots use the same runner without becoming live downgrade targets", () => {
  const initial = { ...step(a, baseline, "initial"), parent: null, down: null },
    upgrade = { ...step(b, a, "added"), down: null },
    history = new History(b, [initial, upgrade, root.revision]);
  expect(history.up({ kept: 42 }, a)).toEqual({ kept: 42, added: true });
  expect(() => history.down({ added: true }, a)).toThrow("UnsupportedStateDowngrade");
  expect(() => supported(history)).toThrow("InvalidHandoffHistory");
  expect(() => history.up({}, baseline)).toThrow("UnsupportedStateFormat");
});
