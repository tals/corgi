import { test, expect } from "bun:test";
import { Tracker, Call } from "./tools";
import * as claudeUsage from "../providers/claude/usage";
import * as codexUsage from "../providers/codex/usage";
import { parseLabel } from "./summary";
import * as prompt from "./prompt";
import { classify } from "./background_tasks";
import * as claudeConversation from "../providers/claude/conversation";
test("plan outcomes retain a failed command beside its successful retry while flat evidence stays compact", () => {
  const tracker = new Tracker();
  tracker.bind("turn");
  for (const [id, outcome, result] of [
    ["failed", "failure", "Existing focus test failed"],
    ["retry", "success", "All focus tests passed"],
  ] as const) {
    const call = new Call();
    call.id = tracker.key(id);
    call.append("bun test focus");
    tracker.save(call, true);
    tracker.finishId(call.id, true, outcome, result);
  }
  const view = tracker.view();
  expect(view.evidence.text().match(/bun test focus/g)).toHaveLength(1);
  expect(view.road_evidence.text()).toContain("[failure]: Existing focus test failed");
  expect(view.road_evidence.text()).toContain("[success]: All focus tests passed");
  tracker.bind("next");
  expect(tracker.view().road_evidence.len).toBe(0);
});
test("completed tools are deduplicated, historical calls do not advance waves, and turns reset", () => {
  const t = new Tracker(),
    call = {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "c1",
        name: "exec_command",
        arguments: '{"cmd":"rg focus src"}',
      },
    },
    output = {
      type: "response_item",
      payload: { type: "function_call_output", call_id: "c1" },
    };
  t.bind("a");
  codexUsage.progress(t, call, false);
  codexUsage.progress(t, output, false);
  codexUsage.progress(t, output, true);
  expect(t.completed).toBe(0n);
  t.bind("b");
  codexUsage.progress(t, call, true);
  codexUsage.progress(t, output, true);
  codexUsage.progress(t, output, true);
  expect(t.completed).toBe(1n);
  expect(t.view().evidence.text()).toContain("rg focus src");
  t.bind("c");
  codexUsage.progress(t, output, true);
  expect(t.completed).toBe(0n);
});
test("code-mode evidence keeps commands and patch files while dropping wrapper", () => {
  const t = new Tracker();
  t.bind("a");
  codexUsage.progress(
    t,
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        call_id: "c1",
        name: "functions.exec",
        input: 'text(await tools.exec_command({cmd:"rg focus src",max_output_tokens:4000}));',
      },
    },
    true,
  );
  expect(t.view().evidence.text()).toContain("rg focus src");
  expect(t.view().evidence.text()).not.toContain("max_output_tokens");
});
test("tool lines keep the command and drop wrappers, scripts and patch bodies", () => {
  function call(name: string) {
    const value = new Call();
    value.id = 1n;
    value.append(name + ": ");
    return value;
  }
  let value = call("exec");
  expect(
    value.script(
      `text((await tools.exec_command({cmd:"sed -n '1,220p' tests/support.ts",workdir:"/Users/tal/dev/personal/corgi",max_output_tokens:8000})).output)`,
    ),
  ).toBe(true);
  expect(value.text()).toBe("exec: sed -n '1,220p' tests/support.ts");
  value = call("exec");
  expect(
    value.script(String.raw`const r = await Promise.allSettled([
    tools.exec_command({cmd:"rg -n \"focus|blur\" src",max_output_tokens:4000}),
    tools.apply_patch("*** Begin Patch\n*** Update File: /Users/tal/dev/personal/corgi/src/resources.zig\n@@\n-  old\n+  new\n*** End Patch"),
    tools.write_stdin({session_id:17169,chars:""})
  ]);`),
  ).toBe(true);
  expect(value.text()).toBe('exec: rg -n "focus|blur" src; apply_patch src/resources.zig; write_stdin');
  value = call("exec_command");
  value.detail("python3 - <<'EOF'\nprint('long script')\nEOF");
  expect(value.text()).toBe("exec_command: python3 - <<'EOF'…");
  value = call("apply_patch");
  const start = Buffer.byteLength(value.text());
  expect(
    value.patchFiles(
      "*** Begin Patch\n*** Add File: /repo/docs/notes.md\n+hi\n*** Delete File: /repo/src/old.zig\n*** End Patch",
    ),
  ).toBe(true);
  value.bound(start, false);
  expect(value.text()).toBe("apply_patch: docs/notes.md, src/old.zig");
  value = call("Bash");
  value.detail("rg " + "x".repeat(200));
  expect(value.text().endsWith("…")).toBe(true);
  expect(Buffer.byteLength(value.text())).toBe(126);
});

test("polling the same call leaves the evidence unchanged", () => {
  const tracker = new Tracker();
  tracker.bind("turn");
  let before = "";
  for (let i = 0; i < 3; i++) {
    const id = `poll-${i}`;
    codexUsage.progress(
      tracker,
      {
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: id,
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "lavish-axi poll" }),
        },
      },
      true,
    );
    if (i > 0) expect(tracker.view().evidence.text()).toBe(before);
    codexUsage.progress(
      tracker,
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: id,
          output: "no feedback",
        },
      },
      true,
    );
    before = tracker.view().evidence.text();
  }
  expect(tracker.completed).toBe(3n);
  expect(tracker.view().evidence.text().split("lavish-axi poll").length - 1).toBe(1);
});

test("Claude text and completed tools become evidence for the bound turn", () => {
  const tracker = new Tracker();
  const assistant = {
    type: "assistant",
    message: {
      content: [
        { type: "thinking", thinking: "" },
        { type: "text", text: "Tracing the hook router" },
        {
          type: "tool_use",
          id: "t1",
          name: "Bash",
          input: { command: "rg routeHook", description: "Find hook routing" },
        },
        { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/repo/src/hooks.ts" } },
      ],
    },
  };
  const result = {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: "large output ignored",
        },
      ],
    },
  };
  claudeUsage.progress(tracker, assistant, true);
  expect(tracker.commentary.len).toBe(0);
  tracker.bind("prompt-1");
  claudeUsage.progress(tracker, assistant, true);
  claudeUsage.progress(
    tracker,
    {
      type: "assistant",
      isSidechain: true,
      message: { content: [{ type: "text", text: "Subagent chatter" }] },
    },
    true,
  );
  expect(tracker.commentary.text()).toBe("Latest agent update: Tracing the hook router");
  expect(tracker.view().running).toBe(2);
  expect(tracker.view().evidence.text()).toContain("Read: src/hooks.ts");
  claudeUsage.progress(tracker, result, true);
  claudeUsage.progress(tracker, result, true);
  expect(tracker.completed).toBe(1n);
  expect(tracker.view().evidence.text()).toContain("Bash: Find hook routing");
  claudeUsage.progress(tracker, { type: "system", subtype: "turn_duration" }, true);
  expect(tracker.view().ended).toBe(true);
  tracker.bind("prompt-2");
  expect(tracker.view().ended).toBe(false);
  expect(tracker.completed).toBe(0n);
});

test("running tools publish stable evidence before completion for both providers", () => {
  const cases = [
    [
      {
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "c1",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "bun test tests/smoke.test.ts" }),
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "c1",
          output: "done",
        },
      },
    ],
    [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "c1",
              name: "Bash",
              input: { command: "bun test tests/smoke.test.ts" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "c1", content: "done" }],
        },
      },
    ],
  ];
  for (const [index, [start, done]] of cases.entries()) {
    const tracker = new Tracker();
    const ingest = (value: any, live: boolean) =>
      index === 0 ? codexUsage.progress(tracker, value, live) : claudeUsage.progress(tracker, value, live);
    tracker.bind("turn");
    tracker.dirty = false;
    ingest(start, false);
    expect(tracker.dirty).toBe(false);
    expect(tracker.view().evidence.len).toBe(0);
    ingest(start, true);
    expect(tracker.dirty).toBe(true);
    const running = tracker.view();
    expect(running.completed).toBe(0n);
    expect(running.evidence.text()).toContain("Currently running tools");
    expect(running.evidence.text()).toContain("bun test tests/smoke.test.ts");
    tracker.dirty = false;
    ingest(start, true);
    expect(tracker.dirty).toBe(false);
    expect(tracker.view().evidence.text()).toBe(running.evidence.text());
    ingest(done, true);
    expect(tracker.dirty).toBe(true);
    expect(tracker.view().evidence.text()).not.toContain("Currently running tools");
    expect(tracker.view().evidence.text()).toContain("Recent completed tools");
  }
});

test("mapped shell commands provide evidence for distinct worktree reads", () => {
  const code = (names: string[]) =>
    "const cmds=" +
    JSON.stringify(names) +
    ';const r=await Promise.allSettled(cmds.map(cmd=>tools.exec_command({cmd,workdir:load("wt")})));';
  for (const command of ["cat src/activity/roadmap.ts", "rg -n tooltip src/controller.ts"]) {
    const item = new Call();
    expect(item.script(code([command, "git status --short"]))).toBe(true);
    expect(item.text()).toContain(command);
    expect(item.text()).not.toContain("exec_command");
  }
});

test("code-mode tool outputs preserve failed commands inside a completed script and survive a handoff", () => {
  const t = new Tracker();
  t.bind("turn");
  const shellResult = (code: number) =>
    JSON.stringify({ status: "fulfilled", value: { chunk_id: "test", exit_code: code, output: "Exit code: 99" } });
  for (const [id, result] of [
    ["a", shellResult(7)],
    ["b", shellResult(0)],
    ["c", "Exit code: 1\nWall time: 0.2 seconds\nOutput:\nmissing file"],
    ["d", "Process exited with code 0\nOutput:\nExit code: 99"],
  ]) {
    codexUsage.progress(
      t,
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: id,
          input: 'text(await tools.exec_command({cmd:"bun test"}))',
        },
      },
      true,
    );
    codexUsage.progress(
      t,
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: id,
          output: [
            { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
            {
              type: "input_text",
              text: result,
            },
          ],
        },
      },
      true,
    );
  }
  expect(t.view().calls.map(c => c.outcome)).toEqual(["failure", "success", "failure", "success"]);
  expect(
    Tracker.restore(JSON.parse(JSON.stringify(t, (_, v) => (typeof v === "bigint" ? String(v) : v)))).view().calls,
  ).toEqual(t.view().calls);
});
