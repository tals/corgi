import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { checkpoint, handoff, fixedText } from "./steps";
test("checkpoint 4 to 5 writes text alone and names providers", () => {
  const value: Record<string, unknown> = {
    version: 4,
    conversations: [
      {
        id: 1,
        agent: {
          name: "Fix\u0000",
          name_len: 3,
          transcript: "/t.jsonl\u0000",
          transcript_len: 8,
          turn: "t2\u0000",
          turn_len: 2,
          last_finished_turn: "t1\u0000",
          last_finished_turn_len: 2,
          recent: "r\u0000",
          recent_len: 1,
          provider: "claude",
          session: "s1\u0000",
          session_len: 2,
          activity: "Idleing tests",
          activity_len: 4,
          tool: "Bash\u0000",
          tool_len: 4,
          cwd: "/tmp\u0000",
          cwd_len: 4,
        },
        status_inference: {
          recent: [
            { bytes: "one\u0000", len: 3 },
            { bytes: "stale", len: 0 },
          ],
          len: 1,
          previous: { bytes: "Idle\u0000", len: 4 },
        },
      },
    ],
    panes: [
      {
        id: 1,
        binding: {
          actor: 0,
          provisional: {
            session: [112, 49, 0],
            session_len: 2,
            cwd: "/p\u0000",
            cwd_len: 2,
          },
        },
        label: { bytes: "api\u0000", len: 3 },
        agent: { session: "old", session_len: 3 },
        resume_hint: {
          name: "Fix\u0000",
          name_len: 3,
          touched_at: 5,
          provider: "claude",
          session: "s1\u0000",
          len: 2,
        },
      },
      { id: 2, binding: null, label: { bytes: "\u0000", len: 0 } },
    ],
    sessions: [
      {
        id: 1,
        resume_hint: {
          name: "\u0000",
          name_len: 0,
          provider: "codex",
          session: "n1\u0000",
          len: 2,
        },
      },
      {
        id: 2,
        binding: { actor: 0, provisional: { tool: "Read\u0000", tool_len: 4 } },
      },
    ],
    closed: [{ label: { bytes: "gone\u0000", len: 4 }, workspace_id: 1 }],
    link_labels: {
      entries: [
        null,
        { name: { bytes: "docs\u0000", len: 4 }, pending: false },
      ],
      generation: 0,
    },
    agent_yolo: [true, false],
    agent_hidden: [false, true],
    agent_commands: [
      {
        bytes: "codex --yolo\u0000",
        len: 12,
        original: "cx\u0000",
        original_len: 2,
        hidden: true,
        name: { bytes: "Fast\u0000", len: 4 },
        semantics: {
          provider: "codex",
          suggested_name: { bytes: "fast\u0000", len: 4 },
          model: { bytes: "gpt\u0000", len: 3 },
          account: { bytes: "\u0000", len: 0 },
          mode: { bytes: "Skips permission checks\u0000", len: 23 },
          yolo: true,
          default_account: false,
        },
      },
    ],
  };
  checkpoint[3](value);
  expect(value).toEqual({
    version: 4,
    conversations: [
      {
        id: 1,
        agent: {
          name: "Fix",
          transcript: "/t.jsonl",
          turn: "t2",
          last_finished_turn: "t1",
          recent: "r",
          provider: "claude",
          session: "s1",
          activity: "Idle",
          tool: "Bash",
          cwd: "/tmp",
        },
        status_inference: { recent: ["one", ""], len: 1, previous: "Idle" },
      },
    ],
    panes: [
      {
        id: 1,
        binding: { actor: 0, provisional: { session: "p1", cwd: "/p" } },
        label: "api",
        resume_hint: {
          name: "Fix",
          touched_at: 5,
          provider: "claude",
          session: "s1",
        },
      },
      { id: 2, binding: null, label: "" },
    ],
    sessions: [
      { id: 1, resume_hint: { name: "", provider: "codex", session: "n1" } },
      { id: 2, binding: { actor: 0, provisional: { tool: "Read" } } },
    ],
    closed: [{ label: "gone", workspace_id: 1 }],
    link_labels: {
      entries: [null, { name: "docs", pending: false }],
      generation: 0,
    },
    agent_yolo: { codex: true, claude: false },
    agent_hidden: { codex: false, claude: true },
    agent_commands: [
      {
        command: "codex --yolo",
        original: "cx",
        hidden: true,
        name: "Fast",
        semantics: {
          provider: "codex",
          suggested_name: "fast",
          model: "gpt",
          account: "",
          mode: "Skips permission checks",
          yolo: true,
          default_account: false,
        },
      },
    ],
  });
});
test("handoff 3 to 4 writes summary and launcher text alone and names providers", () => {
  const value: Record<string, unknown> = {
    version: 3,
    runtime: {
      version: 4,
      panes: [{ label: { bytes: "keep\u0000", len: 4 } }],
    },
    summaries: {
      next_request: 3,
      launches: { count: { values: [7, 4] }, latest: "claude" },
      slots: [
        {
          index: 0,
          slot: {
            request: {
              actor: 1,
              provider: "codex",
              session: "s1\u0000",
              session_len: 2,
              turn: "t1\u0000",
              turn_len: 2,
              evidence: { bytes: "ran tests\u0000", len: 9 },
              panes: [4, 0],
              panes_len: 1,
              name: "Fix\u0000",
              name_len: 3,
              conversation: {
                recent: [
                  { bytes: "one\u0000", len: 3 },
                  { bytes: "\u0000", len: 0 },
                ],
                len: 1,
                previous: { bytes: "Idle\u0000", len: 4 },
              },
            },
            commentary: { bytes: "Looking\u0000", len: 7 },
            tool_evidence: { bytes: [98, 97, 115, 104, 0], len: 4 },
            retry: false,
            result: {
              request: {
                session: "s0\u0000",
                session_len: 2,
                turn: "t0\u0000",
                turn_len: 2,
                evidence: { bytes: "\u0000", len: 0 },
                name: "\u0000",
                name_len: 0,
                conversation: {
                  recent: [],
                  len: 0,
                  previous: { bytes: "x", len: 0 },
                },
              },
              label: { bytes: "Testing\u0000", len: 7 },
              number: 3,
            },
          },
        },
        {
          index: 1,
          slot: {
            request: { session: "s2", session_len: 2 },
            commentary: { bytes: "", len: 0 },
            tool_evidence: { bytes: "", len: 0 },
            result: { label: null, number: 0 },
          },
        },
        {
          index: 2,
          slot: { commentary: { bytes: "a", len: 1 }, result: null },
        },
      ],
      link_results: [
        null,
        { slot: 0, name: { bytes: "docs\u0000", len: 4 } },
        { slot: 1, name: null },
      ],
    },
    clients: [
      {
        fd: 3,
        launch_preview: {
          cwd: "/tmp\u0000",
          len: 4,
          checked: 5,
          preview: {
            pending: false,
            options: [
              {
                signed_in: true,
                model: { bytes: "gpt\u0000", len: 3 },
                source: { bytes: "config\u0000", len: 6 },
                account: { bytes: "a@b\u0000", len: 3 },
                plan: { bytes: "pro\u0000", len: 3 },
                limits: { metered: {} },
                usage_fetched_at: 9,
                usage_error: { bytes: "\u0000", len: 0 },
                usage_needs_consent: false,
              },
              {
                signed_in: null,
                model: { bytes: "opus\u0000", len: 4 },
                source: { bytes: "", len: 0 },
                account: { bytes: "", len: 0 },
                plan: { bytes: "max\u0000", len: 3 },
                usage_error: { bytes: "timed out\u0000", len: 9 },
              },
            ],
            installed: [true, false],
          },
        },
      },
      { fd: 4, launch_preview: null },
      { fd: 5 },
    ],
  };
  handoff[2](value);
  expect(value).toEqual({
    version: 3,
    runtime: {
      version: 4,
      panes: [{ label: { bytes: "keep\u0000", len: 4 } }],
    },
    summaries: {
      next_request: 3,
      launches: { count: { codex: 7, claude: 4 }, latest: "claude" },
      slots: [
        {
          index: 0,
          slot: {
            request: {
              actor: 1,
              provider: "codex",
              session: "s1",
              turn: "t1",
              evidence: "ran tests",
              panes: [4, 0],
              panes_len: 1,
              name: "Fix",
              conversation: { recent: ["one", ""], len: 1, previous: "Idle" },
            },
            commentary: "Looking",
            tool_evidence: "bash",
            retry: false,
            result: {
              request: {
                session: "s0",
                turn: "t0",
                evidence: "",
                name: "",
                conversation: { recent: [], len: 0, previous: "" },
              },
              label: "Testing",
              number: 3,
            },
          },
        },
        {
          index: 1,
          slot: {
            request: { session: "s2" },
            commentary: "",
            tool_evidence: "",
            result: { label: null, number: 0 },
          },
        },
        { index: 2, slot: { commentary: "a", result: null } },
      ],
      link_results: [null, { slot: 0, name: "docs" }, { slot: 1, name: null }],
    },
    clients: [
      {
        fd: 3,
        launch_preview: {
          cwd: "/tmp",
          checked: 5,
          preview: {
            pending: false,
            options: {
              codex: {
                signed_in: true,
                model: "gpt",
                source: "config",
                account: "a@b",
                plan: "pro",
                limits: { metered: {} },
                usage_fetched_at: 9,
                usage_error: "",
                usage_needs_consent: false,
              },
              claude: {
                signed_in: null,
                model: "opus",
                source: "",
                account: "",
                plan: "max",
                usage_error: "timed out",
              },
            },
            installed: { codex: true, claude: false },
          },
        },
      },
      { fd: 4, launch_preview: null },
      { fd: 5 },
    ],
  });
});
test("fixed text is cut at its saved length, never at a NUL", () => {
  expect(fixedText("Idleing tests\0\0", 4)).toBe("Idle");
  expect(fixedText([115, 49, 255, 0], 2)).toBe("s1");
  expect(fixedText("t1\0")).toBe("");
  expect(fixedText("a\0b\0", 3)).toBe("a\0b");
  expect(fixedText(undefined, 0)).toBe("");
  expect((fixedText([104, 105, 255, 0], 3) as { bytes: Buffer }).bytes).toEqual(
    Buffer.from([104, 105, 255]),
  );
  for (const [bytes, len] of [
    ["ab", 3],
    [[97, 98], 3],
    ["ab", -1],
    [[97, 256], 1],
    [null, 0],
  ] as any[])
    expect(() => fixedText(bytes, len)).toThrow("InvalidCheckpoint");
  for (const label of [{ bytes: "ab", len: 3 }, { len: 1 }, "ab"])
    expect(() => checkpoint[3]({ panes: [{ label }] })).toThrow(
      "InvalidCheckpoint",
    );
});
test("provider arrays hold at most one bool per historical provider", () => {
  const value: any = { version: 4, agent_yolo: [true], agent_hidden: [] };
  checkpoint[3](value);
  expect(value).toEqual({
    version: 4,
    agent_yolo: { codex: true },
    agent_hidden: {},
  });
  for (const value of [
    { agent_yolo: [true, false, true] },
    { agent_yolo: [1, 0] },
    { agent_yolo: null },
    { agent_hidden: { codex: true } },
  ])
    expect(() => checkpoint[3](value)).toThrow("InvalidCheckpoint");
});
test("the V4 fixture migrates to text without padding", () => {
  const value = JSON.parse(
    readFileSync(
      new URL("../fixtures/checkpoint-v4.json", import.meta.url),
      "utf8",
    ),
  );
  checkpoint[3](value);
  expect(JSON.stringify(value)).not.toContain("\\u0000");
  const check = (v: any) => {
    if (v && typeof v === "object") {
      for (const [key, item] of Object.entries(v)) {
        expect(key.endsWith("_len")).toBe(false);
        check(item);
      }
    }
  };
  check(value);
  expect(value.conversations[0].agent.session).toBe("v3-shared");
  for (const pane of value.panes) expect(pane.agent).toBeUndefined();
  expect(value.panes[0].resume_hint.session).toBe("v3-shared");
});
