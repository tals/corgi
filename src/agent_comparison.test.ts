import { expect, test } from "bun:test";
import { Agent, Text, Path } from "./agents";
import * as json from "./json";

function fixture() {
  const agent = new Agent({
    provider: "claude",
    state: "working",
    name: new Text("Owned 界🐕"),
    cwd: new Path("/project/界"),
    last_seq: 18446744073709551615n,
  });
  agent.observation.completed = 9007199254740993n;
  return agent;
}
function agrees(mutate: (agent: Agent) => void) {
  const agent = fixture(),
    before = agent.comparison(),
    serialized = json.stringify(agent);
  mutate(agent);
  const same = Bun.deepEquals(before, agent.comparison());
  expect(same).toBe(serialized === json.stringify(agent));
  return same;
}

test("agent comparisons observe every current data field without depending on object identity", () => {
  expect(agrees(() => {})).toBe(true);
  expect(Bun.deepEquals(fixture().comparison(), fixture().comparison())).toBe(true);
  for (const key of Object.keys(fixture())) {
    expect(
      agrees(agent => {
        const data = agent as unknown as Record<string, unknown>,
          value = data[key];
        switch (typeof value) {
          case "bigint":
            data[key] = value - 1n;
            break;
          case "number":
            data[key] = value + 1;
            break;
          case "boolean":
            data[key] = !value;
            break;
          case "string":
            data[key] = value + " changed";
            break;
          default:
            if (value === null) data[key] = 1;
            else if (key === "subagents") agent.subagents.running++;
            else if (key === "observation") agent.observation.pending_stop = true;
            else (value as Text).append(" changed");
        }
      }),
    ).toBe(false);
  }
});

test("agent comparisons own nested receipt and subagent values", () => {
  for (const mutate of [
    (a: Agent) => {
      a.observation.source = "screen";
    },
    (a: Agent) => {
      a.observation.outcome = "interrupted";
    },
    (a: Agent) => {
      a.observation.pending_stop = true;
    },
    (a: Agent) => {
      a.observation.completed++;
    },
    (a: Agent) => {
      a.observation.read++;
    },
    (a: Agent) => {
      a.subagents.running++;
    },
    (a: Agent) => {
      a.subagents.blocked++;
    },
    (a: Agent) => {
      a.subagents.waiting = true;
    },
  ])
    expect(agrees(mutate)).toBe(false);
});

test("agent comparisons retain exact invalid UTF-8 bytes and mutable model text", () => {
  const a = fixture();
  a.name = Text.fromJSON([255]);
  a.model = Text.fromJSON([254]);
  a.cwd = Path.fromJSON([255, 254]);
  const before = a.comparison(),
    serialized = json.stringify(a);
  expect(Bun.deepEquals(before, a.comparison())).toBe(true);
  a.name = Text.fromJSON([254]);
  // Both invalid byte strings display as U+FFFD, but are different saved values.
  expect(Bun.deepEquals(before, a.comparison())).toBe(false);
  a.name = Text.fromJSON([255]);
  a.model.append(" changed");
  expect(Bun.deepEquals(before, a.comparison())).toBe(false);
  expect(json.stringify(before)).toBe(serialized);
  expect(
    agrees(agent => {
      agent.model.value = "new model";
    }),
  ).toBe(false);
});

test("agent comparisons detect state changes even when no attention notification is returned", () => {
  const agent = fixture();
  agent.permission_review = 0;
  const before = agent.comparison(),
    serialized = json.stringify(agent);
  expect(agent.observePermissionPrompt(true, false, 100)).toBe(false);
  expect(agent.permission_review).toBe(1);
  expect(Bun.deepEquals(before, agent.comparison())).toBe(false);
  expect(json.stringify(agent)).not.toBe(serialized);
  expect(agrees(a => a.reset())).toBe(false);
  expect(agrees(a => a.acknowledge())).toBe(false);
  expect(agrees(a => a.beginTurn("new turn"))).toBe(false);
});
