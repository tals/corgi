import { test, expect } from "bun:test";
import { Entry, identify, wrapperBody, analyze } from "./command";
test("command labels skip inline assignments and wrappers without changing source", () => {
  for (const s of [
    "FOO=123 claude code --whatever",
    "FOO='two words' BAR=3 /opt/bin/claude --model sonnet",
    "env -u OLD FOO=123 claude",
    "bunx @anthropic-ai/claude-code@latest",
  ]) {
    const e = new Entry();
    e.set(s);
    expect(e.text()).toBe(s);
    expect(identify(s)).toBe("claude");
  }
  expect(identify("KEY=abc bun x @openai/codex")).toBe("codex");
  expect(identify("my-agent --fast")).toBeNull();
  expect(identify("echo claude")).toBeNull();
});
test("wrapper bodies preserve quoting and reject complex functions", () => {
  expect(wrapperBody("alias c='claude --model sonnet'")).toBe("claude --model sonnet");
  expect(wrapperBody('c ()\n{\n claude --model sonnet "$@";\n}')).toBe("claude --model sonnet");
  expect(() => wrapperBody('c ()\n{\n echo first; claude "$@";\n}')).toThrow("ComplexShellFunction");
});
test("command semantics isolate explicit credential and profile settings", () => {
  const a = analyze("ANTHROPIC_API_KEY=private claude --model sonnet --dangerously-skip-permissions", ".");
  expect(a.provider).toBe("claude");
  expect(a.account).toBe("API key - identity unavailable");
  expect(a.yolo).toBe(true);
  expect(a.modelLabel()).toBe("Sonnet");
  const b = analyze("codex --profile alternate", ".");
  expect(b.default_account).toBe(false);
  expect(b.account).toBe("Profile selected; identity unknown");
});

test("command semantics distinguish default accounts from auth overrides", () => {
  const base = analyze("command claude --model sonnet --dangerously-skip-permissions", "/tmp");
  expect(base.default_account).toBe(true);
  expect(base.model).toBe("sonnet");
  expect(base.mode).toBe("Skips permission checks");
  expect(base.modelLabel()).toBe("Sonnet");
  expect(base.suggested_name).toBe("Claude Code - Sonnet");
  expect(analyze("claude --dangerously-skip-permissions", "/tmp").suggested_name).toBe("Claude Code");
  const api = analyze("ANTHROPIC_API_KEY=private-value claude", "/tmp");
  expect(api.default_account).toBe(false);
  expect(api.account).toBe("API key - identity unavailable");
  expect(api.account).not.toContain("private-value");
  expect(analyze("codex --profile work", "/tmp").account).toBe("Profile selected; identity unknown");
});

test("explicit Codex home uses only that profile's cached public identity", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "corgi-profile-"));
  try {
    await writeFile(join(root, "auth.json"), '{{"tokens":{}}}'.slice(1));
    await writeFile(
      join(root, "auth.json"),
      JSON.stringify({
        tokens: { id_token: "x.eyJlbWFpbCI6IndvcmtAZXhhbXBsZS5jb20ifQ.x" },
      }),
    );
    const s = analyze(`CODEX_HOME='${root}' codex`, "/tmp");
    expect(s.default_account).toBe(false);
    expect(s.account).toBe("work@example.com (cached)");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("Claude HOME override reads the home identity cache", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "corgi-profile-"));
  try {
    await writeFile(
      join(root, ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "claude-work@example.com" },
      }),
    );
    const s = analyze(`HOME='${root}' claude`, "/tmp");
    expect(s.default_account).toBe(false);
    expect(s.account).toBe("claude-work@example.com (cached)");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("opaque shell expansion leaves account undetermined", () => {
  const unknown = analyze("CLAUDE_CONFIG_DIR=$WORK_PROFILE claude", "/tmp");
  expect(unknown.default_account).toBe(false);
  expect(unknown.account).toBe("Account cannot be determined");
});
