import { test, expect } from "bun:test";
import { Codex } from "./providers/codex";
import { childName, unique, threadState } from "./codex_observer";

test("title UUID parsing handles truncation and refuses ambiguity", () => {
  const id = "01901234-1234-1234-1234-123456789abc";
  expect(Codex.titleSession("codex | " + id + " | Ready")?.text()).toBe(id);
  expect(Codex.titleSession("codex | 01901234-1234-1234-1234-12345...")?.text()).toBe(id.slice(0, 29));
  expect(Codex.titleSession("project 01901234")).toBeNull();
  expect(Codex.titleSession(id + " " + id)).toBeNull();
  const prefix = Codex.titleSession("01901234-1234-1234-1234-12345...")!;
  expect(unique([id, "01901234-1234-1234-1234-123456789def"], prefix)).toBeNull();
});

test("unloaded child threads read as idle", () => {
  for (const [value, state] of [
    [{ type: "notLoaded" }, "idle"],
    [{ type: "systemError" }, "idle"],
    [{ type: "idle" }, "idle"],
    [{ type: "active", activeFlags: [] }, "working"],
    [{ type: "active", activeFlags: ["waitingOnApproval"] }, "blocked"],
    [{ type: "future" }, "unknown"],
  ] as const)
    expect(threadState(value)).toBe(state);
});

test("child threads are named by their task, then nickname", () => {
  const spawned = (agent_path: string | null) => ({
    name: null,
    agentNickname: "Boole",
    source: { subAgent: { thread_spawn: { depth: 1, agent_path, agent_nickname: "Boole", agent_role: null } } },
  });
  expect(childName(spawned("/root/typed_rpc"))).toBe("typed_rpc");
  expect(childName(spawned("/root/typed_rpc/tests"))).toBe("typed_rpc/tests");
  expect(childName(spawned(null))).toBe("Boole");
  expect(childName({ ...spawned("/root/typed_rpc"), name: "Renamed" })).toBe("Renamed");
});
