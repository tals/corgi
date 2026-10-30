/** Compare exact agent observations without serializing them for equality. */
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Agent, Text, Path } from "../../src/agents";
import * as json from "../../src/json";
import * as benchmark from "./cpu_lock";

function capture(a: Agent) {
  return a.comparison();
}
function fixture() {
  return new Agent({
    provider: "claude",
    state: "working",
    name: new Text("Fix terminal rendering 界 🐕"),
    session: new Text("11111111-1111-4111-8111-111111111111"),
    transcript: new Path("/home/fixture/.claude/projects/example/session.jsonl"),
    activity: new Text("Inspecting a retained terminal frame"),
    model: new Text("model-name"),
    cwd: new Path("/home/fixture/project"),
    last_seq: 18446744073709551615n,
  });
}
function verify() {
  let comparisons = 0;
  const check = (mutate: (a: Agent) => void) => {
    const a = fixture(),
      before = capture(a),
      wire = json.stringify(a);
    mutate(a);
    assert.equal(Bun.deepEquals(before, capture(a)), wire === json.stringify(a));
    comparisons++;
  };
  check(() => {});
  check(a => a.reset());
  check(a => a.acknowledge());
  check(a => a.beginTurn("next"));
  check(a => a.observation.finish("completed", "screen"));
  check(a => a.name.append(" changed"));
  check(a => (a.name = Text.fromJSON([255, 254])));
  check(a => (a.model.value = "new model"));
  for (const key of Object.keys(fixture()) as (keyof Agent)[]) {
    check(a => {
      const values = a as unknown as Record<string, unknown>,
        value = values[key];
      if (typeof value === "bigint") values[key] = value + 1n;
      else if (typeof value === "number") values[key] = value + 1;
      else if (typeof value === "boolean") values[key] = !value;
      else if (typeof value === "string") values[key] = value + "changed";
      else if (value === null) values[key] = 1;
      else if (key === "observation") a.observation.pending_stop = true;
      else if (key === "subagents") a.subagents.running++;
      else (value as Text).append(" changed");
    });
  }
  const raw = fixture();
  raw.name = Text.fromJSON([255, 254]);
  const before = capture(raw),
    wire = json.stringify(raw);
  raw.name.append("x");
  assert.equal(Bun.deepEquals(before, capture(raw)), wire === json.stringify(raw));
  comparisons++;
  return comparisons;
}
type Mutation = "unchanged" | "counter" | "status";
function run(method: "json" | "owned", mutation: Mutation, count: number) {
  const a = fixture();
  let changed = 0;
  const alter = () => {
    if (mutation === "counter") a.permission_review = (a.permission_review ?? 0) + 1;
    else if (mutation === "status") a.state = a.state === "working" ? "idle" : "working";
  };
  if (method === "json") {
    for (let i = 0; i < count; i++) {
      const before = json.stringify(a);
      alter();
      if (before !== json.stringify(a)) changed++;
    }
  } else {
    for (let i = 0; i < count; i++) {
      const before = capture(a);
      alter();
      if (!Bun.deepEquals(before, capture(a))) changed++;
    }
  }
  assert.equal(changed, mutation === "unchanged" ? 0 : count);
}
const release = await benchmark.acquire();
try {
  const comparisons = verify(),
    results = [],
    reverse = process.argv.includes("--reverse");
  for (const mutation of ["unchanged", "counter", "status"] as const) {
    for (const method of ["json", "owned"] as const) run(method, mutation, 2000);
    for (let trial = 0; trial < 5; trial++)
      for (const method of (trial + Number(reverse)) % 2
        ? (["owned", "json"] as const)
        : (["json", "owned"] as const)) {
        const start = process.cpuUsage(),
          at = performance.now(),
          count = 10000;
        run(method, mutation, count);
        const cpu = process.cpuUsage(start);
        results.push({
          mutation,
          trial,
          method,
          count,
          wall_ms: performance.now() - at,
          cpu_us_per_observation: (cpu.user + cpu.system) / count,
        });
      }
  }
  console.log(
    JSON.stringify(
      {
        comparisons,
        reverse,
        bun: Bun.version,
        source_sha256: createHash("sha256")
          .update(readFileSync(import.meta.path))
          .digest("hex"),
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await release();
}
