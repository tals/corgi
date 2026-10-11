import { test, expect } from "bun:test";
import { Tracker, Call } from "./tools";
import { parseLabel } from "./summary";
import * as prompt from "./prompt";
import { Children, Inventory, Ended, classify } from "./background_tasks";
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
  t.ingest(call, false);
  t.ingest(output, false);
  t.ingest(output, true);
  expect(t.completed).toBe(0n);
  t.bind("b");
  t.ingest(call, true);
  t.ingest(output, true);
  t.ingest(output, true);
  expect(t.completed).toBe(1n);
  expect(t.view().evidence.text()).toContain("rg focus src");
  t.bind("c");
  t.ingest(output, true);
  expect(t.completed).toBe(0n);
});
test("code-mode evidence keeps commands and patch files while dropping wrapper", () => {
  const t = new Tracker();
  t.bind("a");
  t.ingest(
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
test("Claude tool progress joins hook turn and text commentary", () => {
  const t = new Tracker();
  t.bind("p");
  t.ingestClaude(
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Inspecting parser" },
          {
            type: "tool_use",
            id: "c1",
            name: "Read",
            input: { file_path: "/repo/src/parse.zig" },
          },
        ],
      },
    },
    true,
  );
  expect(t.view().running).toBe(1);
  expect(t.view().evidence.text()).toContain("src/parse.zig");
  t.ingestClaude(
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "c1" }] },
    },
    true,
  );
  expect(t.view().completed).toBe(1n);
  expect(t.view().commentary.text()).toContain("Inspecting parser");
});
test("abstention is valid and invalid labels fail separately", () => {
  expect(prompt.parse('{"action":"none","label":null}', null).label).toBeNull();
  expect(prompt.parse('{"action":"new","label":" Null "}', null).label).toBeNull();
  expect(prompt.parse('{"action":"new","label":"Running tests"}', null).label?.text()).toBe("Running tests");
  for (const raw of [
    "{}",
    "null",
    '{"action":"new","label":false}',
    '{"action":"none","label":null,"reason":"unknown"}',
  ])
    expect(() => prompt.parse(raw, null)).toThrow("InvalidDecision");
  expect(() => prompt.parse('{"action":"new","label":""}', null)).toThrow("EmptyLabel");
  expect(parseLabel("Running\ncommands")).toBeNull();
  expect(parseLabel("This label has far too many words")).toBeNull();
});
test("provider task identities and categories remain bounded", () => {
  const inv = Inventory.claude(
    [
      {
        id: "1",
        type: "shell",
        status: "running",
        description: "Check parser",
        command: "bun test",
      },
      { id: "1", type: "shell", command: "bun test" },
      { id: "2", type: "subagent" },
      { id: "3", type: "shell", status: "completed", command: "bun build" },
    ],
    123,
  )!;
  expect(inv.len).toBe(1);
  expect(inv.items[0].label.text()).toBe("Check parser");
  expect(inv.items[0].group).toBe("tests");
  expect(classify("./scripts/zig build test")).toBe("tests");
  expect(classify("bun run dev")).toBe("servers");
  expect(classify("echo 'test server'")).toBe("commands");
  const children = Children.claude([
    { id: "a1", type: "subagent" },
    { id: "a1", type: "subagent" },
    { id: "b1", type: "shell" },
  ])!;
  expect(children.running).toBe(1);
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
    tracker.ingest(
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
    tracker.ingest(
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
  tracker.ingestClaude(assistant, true);
  expect(tracker.commentary.len).toBe(0);
  tracker.bind("prompt-1");
  tracker.ingestClaude(assistant, true);
  tracker.ingestClaude(
    {
      type: "assistant",
      isSidechain: true,
      message: { content: [{ type: "text", text: "Subagent chatter" }] },
    },
    true,
  );
  expect(tracker.commentary.text()).toBe("Latest agent update: Tracing the hook router");
  tracker.ingestClaude(result, true);
  tracker.ingestClaude(result, true);
  expect(tracker.completed).toBe(1n);
  expect(tracker.view().evidence.text()).toContain("Bash: Find hook routing");
  tracker.ingestClaude({ type: "system", subtype: "turn_duration" }, true);
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
      index === 0 ? tracker.ingest(value, live) : tracker.ingestClaude(value, live);
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
