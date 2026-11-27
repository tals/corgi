import { expect, test } from "bun:test";
import * as plan from "./plan";
import * as lines from "./plan_lines";
import * as json from "./plan_protocol";
import type { Input } from "./roadmap";

const event = (id: number): plan.Event => ({ id, turn: 1, line: id, at: "", kind: "tool", text: "Verify downloads" });
const seed = `new e - active Repair offsets
sub e Retain downloaded bytes
new s e active Test resume
sub s Check retry offsets
work 1 s`;
const input = (): Input => ({ state: plan.empty(), support: [], events: [event(1)] });
const next = (): Input => ({
  state: lines.apply(input(), seed).state,
  support: [event(1)],
  events: [event(2), event(3)],
});

test("uncited line edits preserve literal text and attach the observed batch in code", () => {
  const source = next(),
    title = 'Check "retry" | offsets',
    subtitle = String.raw`Keep C:\tmp\part and {"offset": 2}; literal \n, \", pipe | and  double spaces`,
    raw = `title s ${title}\nsub s ${subtitle}\nstate s done\nwork 3 s`;
  const expected = json.apply(
    source,
    JSON.stringify({
      ops: [
        ["~", "s", { t: title }, [2, 3]],
        ["~", "s", { s: subtitle }, [2, 3]],
        ["=", "s", "d", [2, 3]],
        ["@", 3, "s", 1],
      ],
    }),
  );
  expect(lines.apply(source, raw)).toEqual(expected);
  expect(lines.apply(source, raw).state.nodes.at(-1)?.subtitle).toBe(subtitle);
  expect(lines.apply(input(), `\n  ${seed.replaceAll("\n", "\r\n  ")}\r\n`)).toEqual(lines.apply(input(), seed));
  expect(lines.apply(input(), "skip 1").patch.nodes).toEqual([]);
});

test("setbacks and recoveries retain failed attempts and earlier provenance", () => {
  const source = next(),
    before = structuredClone(source);
  const result = lines.apply(
    source,
    `bump s verification Retry duplicated bytes
new retry e done Retry resume
sub retry Repaired offsets passed
resolve s
work 2 s
work 3 retry`,
  );
  expect(source).toEqual(before);
  expect(result.state.nodes.find(n => n.id === "s")).toMatchObject({
    state: "failed",
    bump: { kind: "verification", state: "resolved", detail: "Retry duplicated bytes", evidence: [2, 3] },
  });
  expect(plan.apply(source.state, JSON.stringify(result.patch), source.events).state).toEqual(result.state);
  const later = { state: result.state, support: source.events, events: [event(4)] };
  expect(lines.apply(later, "state s done\nwork 4 retry").state.nodes.find(n => n.id === "s")?.state).toBe("failed");
  const failed = lines.apply(source, "bump s verification Retry duplicated bytes\nwork 3 s").state;
  const recovered = lines.apply({ ...later, state: failed }, "resolve s\nnote 4 s");
  expect(recovered.state.nodes.find(n => n.id === "s")?.bump?.evidence).toEqual([2, 4]);
  expect(recovered.state.nodes.find(n => n.id === "s")?.state).toBe("failed");
});

test("an explicit start boundary tolerates preambles without ignoring malformed operations", () => {
  const source = next(),
    raw = "sub s BEGIN_PLAN is ordinary text here\nwork 3 s",
    expected = lines.apply(source, raw);
  expect(lines.apply(source, "BEGIN_PLAN\n" + raw)).toEqual(expected);
  expect(lines.apply(source, "Here is the update.\n\nBEGIN_PLAN\n" + raw)).toEqual(expected);
  for (const invalid of [
    "Here is the update.\n" + raw,
    "BEGIN_PLAN",
    "BEGIN_PLAN\nBEGIN_PLAN\n" + raw,
    "BEGIN_PLAN\n" + raw + "\nAll done.",
  ])
    expect(() => lines.apply(source, invalid)).toThrow();
});

test("uncited proposals still reject invalid coverage, identities and missing fields atomically", () => {
  const source = next(),
    before = structuredClone(source);
  for (const raw of [
    "",
    "```\nwork 3 s\n```",
    '{"ops":[["@",3,"s",1]]}',
    "work 3 s extra",
    "work 3 e",
    "work 2 s",
    "work 4 s",
    "work 3 missing",
    "note 3 -",
    "state missing done\nwork 3 s",
    "sub s",
    "cite 2\nsub s No model citations\nwork 3 s",
    "resolve s\nwork 3 s",
    "bump s unknown Failed check\nwork 3 s",
    "new s e active Duplicate node\nsub s Duplicate subtitle\nwork 3 s",
    "new fresh e active Missing subtitle\nwork 3 fresh",
    "new - e active Reserved identity\nsub - No node\nskip 3",
    "sub s Invalid\tsubtitle\nwork 3 s",
    "please work 3 s",
    "work 3 s\nskip 3",
    "work 2,3 s",
    "skip 3 s",
  ]) {
    expect(() => lines.apply(source, raw)).toThrow();
    expect(source).toEqual(before);
  }
});

test("all new batch IDs are retained internally and never echoed to the model as citations", () => {
  const source = next();
  source.events = Array.from({ length: 11 }, (_, i) => event(i + 2));
  const result = lines.apply(source, "sub s All retry offsets verified\nwork 12 s");
  expect(result.state.nodes.find(n => n.id === "s")?.evidence).toEqual(source.events.map(e => e.id));
  const failed = lines.apply(source, "bump s verification Offset repeated\nwork 12 s").state;
  const original = structuredClone(failed);
  const encoded = lines.encode(json.envelope({ state: failed, support: source.events, events: [event(13)] }));
  const metadata = JSON.parse(encoded.split("\n")[0]);
  expect(metadata.tree[0]).toHaveLength(6);
  expect(metadata.tree[1][6]).toEqual(["verification", "open", "Offset repeated"]);
  expect(encoded).toContain("@13 1 tool\n Verify downloads");
  expect(failed).toEqual(original);
});

test("redundant creations and harmless syntax normalize without changing meaning", () => {
  const source = next(),
    old = source.state.nodes.find(n => n.id === "s")!;
  const repeated = `new s ${old.parent} ${old.state} ${old.title}\nsub s Verified byte offsets\nwork 3 s`;
  const result = lines.apply(source, repeated),
    plain = lines.apply(source, "sub s Verified byte offsets\nwork 3 s");
  expect(result.state).toEqual(plain.state);
  expect(result.repairs).toEqual(["ignored redundant creation: s"]);
  expect(() => lines.apply(source, repeated.replace(`new s ${old.parent}`, "new s -"))).toThrow("InvalidCreation");
  expect(() => lines.apply(source, repeated.replace(old.title, "Different work activity"))).toThrow("InvalidCreation");
  const repaired = lines.apply(source, "BEGIN_PLAN\nwork through 3 s\nwork 3 s\nEOF");
  expect(repaired.state).toEqual(lines.apply(source, "work 3 s").state);
  expect(repaired.repairs).toHaveLength(3);
  expect(() => lines.apply(source, "BEGIN_PLAN\nwork 2 s\nEOF")).toThrow();
  expect(() => lines.apply(source, "BEGIN_PLAN\nwork 3 s\nskip 3\nEOF")).toThrow();
});
