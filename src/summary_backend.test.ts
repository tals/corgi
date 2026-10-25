import { test, expect } from "bun:test";
import { Backend, type Input } from "./summary_backend";
import { Response } from "./inference/harness";
import { Timeline } from "./activity/timeline";

test("backend sends task context and rejects obsolete output instead of accepting a partial decision", async () => {
  const backend = new Backend();
  const input: Input = {
    provider: "codex",
    turn: "turn",
    phase: null,
    earlier: [],
    evidence: "Reading parser",
    work: new Timeline().taskContext(),
    history: ["Previous parser investigation"],
  };
  const source = { actor: 1, panes: [], agent_name: "", session: "s", tools_since_last: 0n };
  let raw = '{"action":"new","label":"Reading parser"}';
  backend.pool.infer = async request => {
    expect(JSON.parse(request.content).work).toEqual(input.work);
    expect(JSON.parse(request.content).history).toBeUndefined();
    expect(JSON.parse(request.fresh_content!).history).toEqual(input.history);
    const response = new Response();
    response.set(raw);
    return response;
  };
  try {
    expect((await backend.infer(input, "turn", "s", source)).decision).toBeNull();
    raw = JSON.stringify({
      action: "new",
      label: "Reading parser",
      task: { id: null, label: "Repair parser" },
      completed: [],
    });
    const result = await backend.infer(input, "turn", "s", source);
    expect(result.decision?.task).toEqual({ id: null, label: "Repair parser" });
    expect(result.decision?.completed).toEqual([]);
    input.work.supplied = true;
    expect((await backend.infer(input, "turn", "s", source)).decision).toBeNull();
  } finally {
    backend.close();
  }
});
