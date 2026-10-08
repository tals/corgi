import { test, expect } from "bun:test";
import { claudeEntry, codexTail, clip, Worker, type Entry } from "./history";
const lines = (...v: any[]) =>
  v.map((x) => JSON.stringify(x)).join("\n") + "\n";
const user = (content: any, extra: any = {}) => ({
  type: "user",
  cwd: "/work",
  message: { role: "user", content },
  ...extra,
});
test("a Claude transcript yields its title, prompts, branch and interruption", () => {
  const t = lines(
    user("<command-name>/clear</command-name>"),
    user("fix the   sidebar\nflicker", { gitBranch: "main" }),
    { type: "ai-title", aiTitle: "Sidebar flicker" },
    user([{ type: "text", text: "does it work on linux?" }], {
      gitBranch: "topic",
    }),
    user("[Request interrupted by user]"),
  );
  const e = claudeEntry("s1", t, t, false, 50)!;
  expect(e).toMatchObject({
    title: "Sidebar flicker",
    first: "fix the   sidebar\nflicker",
    last: "does it work on linux?",
    branch: "topic",
    cwd: "/work",
    interrupted: true,
    updated_at: 50,
  });
});
test("Claude transcripts from the SDK or continued elsewhere are skipped", () => {
  const empty = lines(user("<local-command-stdout>ok</local-command-stdout>"));
  expect(claudeEntry("s", empty, empty)!.first).toBe("");
  const sdk = lines(user("Reply with just: ok", { entrypoint: "sdk-cli" }));
  expect(claudeEntry("s", sdk, sdk)).toBeNull();
  const moved = lines(user("hello"), {
    type: "continued-in",
    continuedInSessionId: "other",
  });
  expect(claudeEntry("s", moved, moved)).toBeNull();
  const renamed = lines(
    user("$commit-all"),
    { type: "ai-title", aiTitle: "Commit all changes" },
    { type: "custom-title", customTitle: "Release prep" },
  );
  expect(claudeEntry("s", renamed, renamed)!.title).toBe("Release prep");
});
test("a tail that starts mid-line skips the partial line", () => {
  const head = lines(user("first")),
    tail =
      'ext":"cut"}]}}\n' +
      lines(user("latest")) +
      '{"type":"user","message":{"content":"unfinished';
  expect(claudeEntry("s", head, tail, true)).toMatchObject({
    first: "first",
    last: "latest",
  });
});
test("a Claude conversation dates from its last prompt or reply, not its file", () => {
  const t = lines(
    user("ship it", { timestamp: "2026-09-24T09:59:00.000Z" }),
    {
      type: "assistant",
      timestamp: "2026-09-24T10:00:00.123Z",
      message: { content: [] },
    },
    { type: "system", timestamp: "2026-09-25T10:00:00.000Z" },
    { type: "custom-title", customTitle: "Release" },
  );
  expect(claudeEntry("s", t, t, false, 1790600000)!.updated_at).toBe(
    1790244000,
  );
});
test("a Codex rollout tail yields the last typed prompt and an abort", () => {
  const message = (text: string) => ({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    }),
    t = lines(message("# AGENTS.md instructions"), message("why is it slow?"), {
      type: "event_msg",
      payload: { type: "turn_aborted" },
    });
  expect(codexTail(t)).toEqual({ last: "why is it slow?", interrupted: true });
  expect(codexTail(t + lines(message("try again")))).toEqual({
    last: "try again",
    interrupted: false,
  });
});
test("clip keeps one line within its byte limit at a UTF-8 boundary", () => {
  const out = clip("  a\tb\n\nc\x1b é", 7);
  expect(out.slice(0, 6)).toBe("a b c ");
  expect(Buffer.byteLength(out)).toBeLessThanOrEqual(7);
});
test("a viewer gets everything once, then only what changed, and everything from another daemon", () => {
  const w = new Worker();
  w.epoch = 5n;
  w.ready = true;
  const first: Entry = {
      provider: "claude",
      session: "a",
      title: "First",
      first: "",
      last: "",
      cwd: "/w",
      branch: "",
      updated_at: 1,
      interrupted: false,
    },
    second = {
      ...first,
      provider: "codex" as const,
      session: "b",
      title: "Second",
      updated_at: 2,
    };
  w.store.replace([first, second], ["claude", "codex"]);
  const full = w.update(0, 0)!;
  expect(full.full).toBe(true);
  expect(full.entries[0].title).toBe("Second");
  expect(w.update(full.epoch, full.revision)).toBeNull();
  w.store.put(first);
  expect(w.update(full.epoch, full.revision)).toBeNull();
  w.store.put({ ...first, last: "one more thing", updated_at: 9 });
  w.store.remove("codex", "b");
  const delta = w.update(full.epoch, full.revision)!;
  expect(delta.full).toBe(false);
  expect(delta.entries[0].last).toBe("one more thing");
  expect(delta.removed[0].session).toBe("b");
  expect(w.update(4, delta.revision)!.full).toBe(true);
  w.store.put(second);
  w.store.replace([], ["claude"]);
  expect(w.store.get("codex", "b")).not.toBeNull();
  expect(w.store.get("claude", "a")).toBeNull();
  w.stop();
});
