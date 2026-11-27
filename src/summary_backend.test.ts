import { expect, test } from "bun:test";
import { Backend, type Input, type Source } from "./summary_backend";
import { Response, type Request } from "./inference/harness";
import * as plan from "./activity/plan";
import * as owner from "./activity/plan_owner";
import type { Input as RoadInput } from "./activity/roadmap";

const input: Input = { provider: "codex", turn: "turn", phase: null, earlier: [], evidence: "Inspect saved links" };
const source: Source = { actor: 1, panes: [1], agent_name: "Codex", session: "session", tools_since_last: 0n };
const seed = `BEGIN_PLAN
mkdir /e active Diagnose saved links
set /e subtitle Trace the missing saved index
mkdir /e/s active Inspect document index
set /s subtitle Read saved link lookup fields
mkdir /e/b active Build document renderer
set /b subtitle Compile the renderer in the background
set_owner 1 /s
set_owner 2 /b
set_focus 1 /s`;
const road = (): RoadInput => ({
  state: plan.empty(),
  support: [],
  events: [1, 2].map(id => ({ id, turn: 1, line: id, at: "", kind: "tool", text: "Inspect saved links" })),
});
function backend(outputs: string[], usage = 1000n) {
  const backend = new Backend();
  const requests: Request[] = [];
  backend.pool.infer = async request => {
    requests.push(request);
    const response = new Response();
    response.set(outputs[requests.length - 1]);
    response.usage.input = usage;
    response.usage.output = 100n;
    return response;
  };
  return { backend, requests };
}

test("live plans use the evaluated ownership prompt and keep the foreground label across background results", async () => {
  const fixture = backend([seed, "BEGIN_PLAN\nset_owner 3 /b"]),
    first = road();
  try {
    const result = await fixture.backend.infer(input, "turn", "conversation", source, false, first);
    expect(fixture.requests[0].instructions).toBe(owner.variant("direct").instructions);
    expect(fixture.requests[0].schema).toBeNull();
    expect(result.decision?.label?.text()).toBe("Inspect document index");
    const { state } = plan.apply(first.state, result.patch!, first.events);
    expect(state.nodes).toHaveLength(3);
    expect(state.spans.at(-1)?.node).toBe("b");
    const next: RoadInput = {
      state,
      support: first.events,
      events: [{ id: 3, turn: 1, line: 3, at: "", kind: "result", text: "Background renderer build passed" }],
    };
    const background = await fixture.backend.infer(input, "turn", "conversation", source, false, next);
    expect(background.decision?.label?.text()).toBe("Inspect document index");
    expect(JSON.parse(background.patch!).spans).toEqual([{ from: 3, to: 3, node: "b", focus: false }]);
    expect(fixture.requests[1].conversation).toBe(fixture.requests[0].conversation);
    expect(JSON.parse(fixture.requests[1].content.split("\n", 1)[0]).tree_updates).toBeDefined();
  } finally {
    fixture.backend.close();
  }
});

test("live ownership retries once atomically and refreshes the cache when the failed attempt exhausts its budget", async () => {
  const incomplete = seed.replace("set_owner 2 /b\n", "");
  for (const replacement of [seed, incomplete]) {
    const fixture = backend([incomplete, replacement], 90_000n),
      first = road(),
      before = structuredClone(first);
    try {
      const result = await fixture.backend.infer(input, "turn", "conversation", source, false, first);
      expect(fixture.requests).toHaveLength(2);
      const correction = fixture.requests[1],
        metadata = JSON.parse(correction.content.split("\n", 1)[0]);
      expect(correction.conversation).not.toBe(fixture.requests[0].conversation);
      expect(correction.content).toBe(correction.fresh_content!);
      expect(correction.instructions).toBe(owner.variant("direct").instructions);
      expect(metadata.correction).toContain("NONE of its edits or assignments were applied");
      expect(metadata.rejected).toBe(incomplete);
      expect(metadata.tree).toEqual([]);
      expect(first).toEqual(before);
      if (replacement === seed) expect(JSON.parse(result.patch!).nodes).toHaveLength(3);
      else expect(result.decision).toBeNull();
    } finally {
      fixture.backend.close();
    }
  }
});
