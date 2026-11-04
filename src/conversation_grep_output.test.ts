import { expect, test } from "bun:test";
import { render, type Hit, type Match, type Options } from "./conversation_grep_output";

const options: Options = {
  workspace: "/work",
  json: false,
  onlyMatching: false,
  list: false,
  count: false,
  maxLineChars: 40,
  maxOutputChars: 0,
  fullLines: false,
};
const hit = (text: string, needle = "needle", extra: Partial<Hit> = {}): Hit => {
  const start = Buffer.byteLength(text.slice(0, text.indexOf(needle)));
  return {
    line: 42,
    seq: 42,
    text,
    context: false,
    role: "assistant",
    timestamp: null,
    ref: "r",
    message_line: 1,
    submatches: [{ start, end: start + Buffer.byteLength(needle) }],
    ...extra,
  };
};
const match = (...hits: Hit[]): Match => ({
  source: { provider: "codex", session: "full-session-id", cwd: "/work/app", updated_at: Date.UTC(2026, 0, 2) },
  hits,
});

test("shows far-right matches and converts UTF-8 byte offsets", () => {
  const result = render([match(hit("é".repeat(200) + " needle tail"))], options);
  expect(result.text).toContain("needle");
  expect(result.text).toContain("…");
  expect(result.clipped_lines).toBe(1);
  expect(render([match(hit("é before needle after"))], { ...options, onlyMatching: true }).text).toContain(
    "42:assistant:needle",
  );
});

test("clips context, separates disjoint regions, and labels tools", () => {
  const result = render(
    [
      match(
        hit("needle"),
        hit("x".repeat(100), "x", { line: 43, seq: 43, context: true }),
        hit("needle", "needle", { line: 50, seq: 50, role: "tool", lane: "tools" }),
      ),
    ],
    options,
  );
  expect(result.text).toContain("43-assistant-");
  expect(result.text).toContain("\n--\nT50:tool:needle");
  expect(result.clipped_lines).toBe(1);
});

test("a hit names its message's line in the cache file, and later lines of the message as N.L", () => {
  const cached = {
    ...match(
      hit("needle", "needle", { line: 7, message_line: 3, seq: 10 }),
      hit("after", "after", { line: 8, seq: 11, context: true }),
      hit("needle", "needle", { line: 9, message_line: 2, seq: 13 }),
    ),
  };
  cached.source.cache = "/cache/conversation.jsonl";
  const text = render([cached], options).text;
  // The next message's first line follows the last one directly; a skipped line is a gap.
  expect(text).toBe(
    "codex:full-session-id  2026-01-02  app  /cache/conversation.jsonl\n7.3:assistant:needle\n8-assistant-after\n--\n9.2:assistant:needle\n",
  );
  const json = JSON.parse(render([cached], { ...options, json: true }).text.split("\n")[0]);
  expect(json.source.cache).toBe("/cache/conversation.jsonl");
  expect(json.hits[0]).toMatchObject({ line: 7, message_line: 3 });
  expect(json.hits[0].seq).toBeUndefined();
});

test("JSONL remains valid under budget and drops stale offsets", () => {
  const result = render([match(hit("x".repeat(200) + " needle"))], { ...options, json: true, maxOutputChars: 350 });
  expect(result.text.length).toBeLessThanOrEqual(350);
  for (const line of result.text.trim().split("\n")) {
    const record = JSON.parse(line);
    expect(record.hits[0].clipped).toBe(true);
    expect(record.hits[0].submatches).toBeUndefined();
  }
});

test("only-matching prints no empty matches", () => {
  const text = "say needle";
  const empty = { start: 0, end: 0 },
    found = hit(text).submatches[0];
  const one = render([match(hit(text, "needle", { submatches: [empty, found] }))], { ...options, onlyMatching: true });
  expect(one.text.split("\n").slice(1)).toEqual(["42:assistant:needle", ""]);
  const none = render([match(hit(text, "needle", { submatches: [empty] }))], { ...options, onlyMatching: true });
  expect(none).toMatchObject({ text: "", shown_conversations: 0 });
});

test("global limit reports truncated only-matching output", () => {
  const result = render([match(hit("z".repeat(200), "z".repeat(200)))], {
    ...options,
    onlyMatching: true,
    maxOutputChars: 90,
  });
  expect(result.text.length).toBeLessThanOrEqual(90);
  expect(result.text).toContain("…");
  expect(result.truncated).toBe(true);
  expect(result.clipped_lines).toBe(1);
});

test("shows windows for distant matches", () => {
  const text = "start " + "x".repeat(80) + "first" + "y".repeat(80) + "second" + "z".repeat(80);
  const first = text.indexOf("first"),
    second = text.indexOf("second");
  const result = render(
    [
      match(
        hit(text, "first", {
          submatches: [
            { start: first, end: first + 5 },
            { start: second, end: second + 6 },
          ],
        }),
      ),
    ],
    { ...options, maxLineChars: 50 },
  );
  expect(result.text).toContain("first");
  expect(result.text).toContain("second");
});

test("JSON keeps literal text while terminal output escapes control sequences", () => {
  const text = "needle\t\u001b[31m";
  const value = match(hit(text));
  const json = render([value], { ...options, json: true });
  expect(JSON.parse(json.text).hits[0].text).toBe(text);
  const terminal = render([value], options);
  expect(terminal.text).not.toContain("\u001b");
  expect(terminal.text).toContain("\\t\\u001b[31m");
});

test("a conversation outside the workspace's folder, in one of its worktrees, shows its full folder", () => {
  const outside = {
    ...match(hit("a needle")),
    source: { ...match(hit("a needle")).source, cwd: "/elsewhere/app-fix" },
  };
  expect(render([outside], options).text.split("\n")[0]).toContain("  /elsewhere/app-fix");
  expect(render([match(hit("a needle"))], options).text.split("\n")[0]).toContain("  app");
});
