import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import * as json from "../json";
import * as steps from "./steps";
import { decode, checkpoint_version, handoff_version } from "./migrations";
for (const kind of ["checkpoint", "handoff"] as const)
  for (const [i, step] of steps[kind].entries())
    test(`${kind} released step ${i + 1} retains golden output`, () => {
      const base = new URL(
        `../fixtures/steps/${kind}-${i + 1}`,
        import.meta.url,
      );
      const input = json.parse(
        readFileSync(`${base.pathname}.in.json`, "utf8"),
      );
      const output = json.parse(
        readFileSync(`${base.pathname}.out.json`, "utf8"),
      );
      step(input);
      expect(input).toEqual(output);
    });
test("versions are checked before current enum decoding", () => {
  expect(() => decode("checkpoint", "{}")).toThrow("MissingStateVersion");
  for (const value of ["0", "-1", "null", '"2"', "2.5"])
    expect(() => decode("checkpoint", `{"version":${value}}`)).toThrow(
      "InvalidStateVersion",
    );
  expect(() =>
    decode("checkpoint", '{"version":99,"provider":"other"}'),
  ).toThrow("UnsupportedStateVersion");
  expect(() =>
    decode("handoff", '{"version":2,"runtime":{"version":99}}'),
  ).toThrow("UnsupportedStateVersion");
});
test("handoff and runtime versions migrate independently without losing launch counts", () => {
  const result = decode(
    "handoff",
    '{"version":1,"runtime":{"version":1},"summaries":{"launches":{"codex":7,"claude":4,"latest":"claude"}}}',
  );
  expect(result.value.version).toBe(handoff_version);
  expect(result.value.runtime.version).toBe(checkpoint_version);
  expect(result.value.summaries.launches.count).toEqual({
    codex: 7,
    claude: 4,
  });
  expect(result.migrated).toBe(true);
});
test("legacy panes and native sessions share one migrated conversation", () => {
  const result = decode(
    "checkpoint",
    JSON.stringify({
      version: 1,
      panes: [
        {
          agent: {
            provider: "codex",
            session: "shared\0",
            session_len: 6,
            later: 1,
          },
        },
        {
          agent: {
            provider: "codex",
            session: [115, 104, 97, 114, 101, 100, 0],
            session_len: 6,
          },
        },
      ],
      sessions: [
        { provider: "codex", resume_hint: { session: "shared\0", len: 6 } },
      ],
    }),
  );
  expect(result.value.conversations).toHaveLength(1);
  expect(result.value.conversations[0].agent.later).toBe(1);
  expect(result.value.sessions[0].binding.actor).toBe(1);
  expect(result.value.panes[1].binding.actor).toBe(1);
});
test("lossless counters survive current decoding", () => {
  expect(
    decode("checkpoint", '{"version":5,"counter":18446744073709551615}').value
      .counter,
  ).toBe(18446744073709551615n);
});
test("provider migrations are scoped and accept both V2 representations", () => {
  const result = decode(
    "checkpoint",
    JSON.stringify({
      version: 2,
      panes: [
        {
          agent: { provider: "other" },
          resume_hint: { provider: null },
          binding: { provisional: { provider: "codex" } },
        },
      ],
      sessions: [
        {
          provider: "claude",
          binding: { provisional: { provider: "other" } },
          resume_hint: { provider: "other" },
          events: [{ provider: "other" }],
        },
      ],
      conversations: [{ agent: { provider: "claude" } }],
      agent_commands: [{ semantics: { provider: "other" } }],
      payload: { provider: "other" },
    }),
  ).value;
  expect(result.panes[0].binding.provisional.provider).toBe("codex");
  expect(result.panes[0].resume_hint.provider).toBe(null);
  expect(result.sessions[0].resume_hint.provider).toBe(null);
  expect(result.sessions[0].provider).toBe("claude");
  expect(result.sessions[0].events[0].provider).toBe("other");
  expect(result.payload.provider).toBe("other");
  expect(result.agent_commands[0].semantics.provider).toBe(null);
});
test("yolo is recovered from the saved mode text and left alone otherwise", () => {
  const commands = [
    { semantics: { mode: { bytes: "Skips permission checks", len: 23 } } },
    { semantics: { mode: { bytes: "Provider permission settings", len: 28 } } },
    { semantics: { mode: { bytes: [83, 107, 105, 112, 115], len: 5 } } },
    { semantics: {} },
    {},
  ];
  const result = decode(
    "checkpoint",
    JSON.stringify({ version: 3, agent_commands: commands }),
  ).value.agent_commands;
  expect(result[0].semantics.yolo).toBe(true);
  for (let i = 1; i < 4; i++) expect(result[i].semantics.yolo).toBeUndefined();
  expect(result[4]).toEqual({});
});
test("promotion moves agents as JSON and never shares them", () => {
  const value = {
    next_conversation: 4,
    conversations: [],
    panes: [
      { agent: { provider: "claude", session: "", session_len: 0, later: 2 } },
    ],
  };
  steps.checkpoint[1](value);
  value.panes[0].agent.later = 9;
  expect((value.panes[0] as any).binding.provisional.later).toBe(2);
  expect(() =>
    decode(
      "checkpoint",
      '{"version":2,"panes":[{"agent":{"provider":"codex","session":"s","session_len":9}}]}',
    ),
  ).toThrow("InvalidCheckpoint");
});
test("historical fixed text cuts byte length and rejects malformed buffers", () => {
  expect(steps.fixedText("Idleing tests\0", 4)).toBe("Idle");
  expect(steps.fixedText([115, 49, 255, 0], 2)).toBe("s1");
  expect(steps.fixedText("a\0b\0", 3)).toBe("a\0b");
  for (const [bytes, len] of [
    ["ab", 3],
    [[97, 98], 3],
    ["ab", -1],
    [[97, 256], 1],
    [null, 0],
  ] as any[])
    expect(() => steps.fixedText(bytes, len)).toThrow("InvalidCheckpoint");
  for (const value of [
    { agent_yolo: [true, false, true] },
    { agent_yolo: [1, 0] },
  ])
    expect(() => steps.checkpoint[3](value)).toThrow("InvalidCheckpoint");
});
test("migration steps import only std", () => {
  const source = readFileSync(new URL("./steps.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/(?:from|import\s*\()\s*["']\./);
});
test("handoff keeps only the metered fact from launcher usage text", () => {
  const result = decode(
    "handoff",
    JSON.stringify({
      version: 2,
      runtime: { version: 4 },
      clients: [
        {
          launch_preview: {
            preview: {
              options: [
                {
                  usage: { bytes: "Metered", len: 7 },
                  usage_metered: true,
                  resets: {},
                },
                {
                  usage: { bytes: "5h 12%", len: 6 },
                  usage_metered: false,
                  resets: { at: [100, null] },
                  usage_fetched_at: 9,
                },
              ],
            },
          },
        },
        { launch_preview: null },
      ],
    }),
  );
  const options = result.value.clients[0].launch_preview.preview.options;
  expect(options.codex.limits).toEqual({ metered: {} });
  expect(options.claude.limits).toBeUndefined();
  expect(options.claude.usage_fetched_at).toBe(9);
  for (const option of Object.values(options) as any[])
    for (const key of ["usage", "usage_metered", "resets"])
      expect(option[key]).toBeUndefined();
});
test("each released step still produces its golden output", () => {
  for (const kind of ["checkpoint", "handoff"] as const)
    for (const [i, step] of steps[kind].entries()) {
      const base = new URL(
          `../fixtures/steps/${kind}-${i + 1}`,
          import.meta.url,
        ).pathname,
        input = json.parse(readFileSync(base + ".in.json", "utf8")),
        output = json.parse(readFileSync(base + ".out.json", "utf8"));
      step(input);
      expect(input).toEqual(output);
    }
});
