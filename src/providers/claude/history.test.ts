import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entry, locate } from "./history";
const lines = (...v: any[]) => v.map(x => JSON.stringify(x)).join("\n") + "\n";
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
  const e = entry("s1", t, t, false, 50)!;
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
  expect(entry("s", empty, empty)!.first).toBe("");
  const sdk = lines(user("Reply with just: ok", { entrypoint: "sdk-cli" }));
  expect(entry("s", sdk, sdk)).toBeNull();
  const moved = lines(user("hello"), {
    type: "continued-in",
    continuedInSessionId: "other",
  });
  expect(entry("s", moved, moved)).toBeNull();
  const renamed = lines(
    user("$commit-all"),
    { type: "ai-title", aiTitle: "Commit all changes" },
    { type: "custom-title", customTitle: "Release prep" },
  );
  expect(entry("s", renamed, renamed)!.title).toBe("Release prep");
});
test("a tail that starts mid-line skips the partial line", () => {
  const head = lines(user("first")),
    tail = 'ext":"cut"}]}}\n' + lines(user("latest")) + '{"type":"user","message":{"content":"unfinished';
  expect(entry("s", head, tail, true)).toMatchObject({
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
  expect(entry("s", t, t, false, 1790600000)!.updated_at).toBe(1790244000);
});

test("a Claude session's transcript is found in whichever project folder holds it", () => {
  const account = mkdtempSync(join(tmpdir(), "corgi-claude-")),
    session = "0f315d2b-dd8d-4ce2-93db-6831458ca975",
    path = join(account, "projects", "-tmp-project", `${session}.jsonl`);
  try {
    mkdirSync(join(account, "projects", "-tmp-other"), { recursive: true });
    mkdirSync(join(account, "projects", "-tmp-project"), { recursive: true });
    writeFileSync(path, "{}\n");
    expect(locate(session, account)).toBe(path);
    expect(locate("1f315d2b-dd8d-4ce2-93db-6831458ca975", account)).toBe("");
    expect(locate("../x", account)).toBe("");
    expect(locate(session, join(account, "missing"))).toBe("");
  } finally {
    rmSync(account, { recursive: true, force: true });
  }
});
