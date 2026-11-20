import { test, expect } from "bun:test";
import {
  Entry,
  Worker,
  identify,
  wrapperBody,
  analyze,
  shell,
  shellArgs,
  shellStatus,
  installedShells,
} from "./command";
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findExecutable, loginShell } from "../os";
import * as settings from "../settings";
import { scopedEnv } from "../fixtures/env";

test("stopping command previews cancels and reaps an active shell lookup", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-command-stop-")),
    worker = Worker.start(),
    pidFile = join(root, "pid"),
    executable = join(root, "bash");
  using env = scopedEnv({ CORGI_ENV_DIR: root });
  try {
    // Renamed into place, so the file never exists without its PID.
    writeFileSync(
      executable,
      `#!/bin/sh\nprintf '%s' "$$" > '${pidFile}.tmp'\n/bin/mv '${pidFile}.tmp' '${pidFile}'\nexec /bin/sleep 60\n`,
      { mode: 0o755 },
    );
    settings.update(settings.path(), { shell: executable });
    const result = worker.request(1n, "alias_to_resolve", root),
      deadline = Date.now() + 2500;
    while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(5);
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    await worker.stop();
    expect(result.pending).toBe(false);
    expect(result.error_message).toBe("Cancelled");
    expect(() => process.kill(pid, 0)).toThrow();
    expect(() => worker.request(2n, "another_alias", root)).toThrow("Cancelled");
  } finally {
    await worker.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

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
test("command semantics distinguish default accounts from auth overrides", async () => {
  const base = await analyze("command claude --model sonnet --dangerously-skip-permissions", "/tmp");
  expect(base.default_account).toBe(true);
  expect(base.model).toBe("sonnet");
  expect(base.mode).toBe("Skips permission checks");
  expect(base.modelLabel()).toBe("Sonnet");
  expect(base.suggested_name).toBe("Claude Code - Sonnet");
  expect((await analyze("claude --dangerously-skip-permissions", "/tmp")).suggested_name).toBe("Claude Code");
  const api = await analyze("ANTHROPIC_API_KEY=private-value claude", "/tmp");
  expect(api.default_account).toBe(false);
  expect(api.account).toBe("API key - identity unavailable");
  expect(api.account).not.toContain("private-value");
  expect(await analyze("codex --profile work", "/tmp")).toMatchObject({
    default_account: false,
    account: "Profile selected; identity unknown",
  });
});

test("explicit Codex home uses only that profile's cached public identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-profile-"));
  try {
    writeFileSync(
      join(root, "auth.json"),
      JSON.stringify({
        tokens: { id_token: "x.eyJlbWFpbCI6IndvcmtAZXhhbXBsZS5jb20ifQ.x" },
      }),
    );
    const s = await analyze(`CODEX_HOME='${root}' codex`, "/tmp");
    expect(s.default_account).toBe(false);
    expect(s.account).toBe("work@example.com (cached)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("Claude HOME override reads the home identity cache", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-profile-"));
  try {
    writeFileSync(
      join(root, ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "claude-work@example.com" },
      }),
    );
    const s = await analyze(`HOME='${root}' claude`, "/tmp");
    expect(s.default_account).toBe(false);
    expect(s.account).toBe("claude-work@example.com (cached)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("opaque shell expansion leaves account undetermined", async () => {
  const unknown = await analyze("CLAUDE_CONFIG_DIR=$WORK_PROFILE claude", "/tmp");
  expect(unknown.default_account).toBe(false);
  expect(unknown.account).toBe("Account cannot be determined");
});
test("panes use the configured shell, then an absolute SHELL, then the account's", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-shell-"));
  using env = scopedEnv({ CORGI_ENV_DIR: root, SHELL: "/bin/bash" });
  try {
    expect(shell()).toBe("/bin/bash");
    for (const value of [undefined, "", "zsh"]) {
      if (value === undefined) delete process.env.SHELL;
      else process.env.SHELL = value;
      expect(shell()).toBe(loginShell() ?? "/bin/sh");
    }
    process.env.SHELL = "/bin/bash";
    settings.update(settings.path(), { shell: "/bin/sh" });
    expect(shell()).toBe("/bin/sh");
    settings.update(settings.path(), { shell: "sh" });
    expect(shell()).toBe(findExecutable("sh")!);
    for (const missing of ["/nonexistent/zsh", "no-such-shell", "/bin"]) {
      settings.update(settings.path(), { shell: missing });
      expect(shell()).toBe("/bin/bash");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("panes start login shells only on macOS", () => {
  expect(shellArgs(null, false, "darwin")).toEqual(["-l"]);
  expect(shellArgs("claude", false, "darwin")).toEqual(["-lc", "claude"]);
  expect(shellArgs("ls", true, "darwin")).toEqual(["-lic", "ls"]);
  expect(shellArgs(null, false, "linux")).toEqual([]);
  expect(shellArgs("claude", false, "linux")).toEqual(["-c", "claude"]);
  expect(shellArgs("ls", true, "linux")).toEqual(["-ic", "ls"]);
});
test("the shell status says what panes run with and without the setting", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-shell-"));
  using env = scopedEnv({ CORGI_ENV_DIR: root, SHELL: "/bin/bash" });
  try {
    expect(shellStatus()).toEqual({
      setting: "",
      path: "/bin/bash",
      source: "env",
      default: "/bin/bash",
      default_source: "env",
    });
    settings.update(settings.path(), { shell: "/bin/sh" });
    expect(shellStatus()).toMatchObject({
      setting: "/bin/sh",
      path: "/bin/sh",
      source: "setting",
      default: "/bin/bash",
    });
    settings.update(settings.path(), { shell: "/bin/zshh" });
    expect(shellStatus()).toMatchObject({ setting: "/bin/zshh", path: "/bin/bash", source: "env" });
    delete process.env.SHELL;
    expect(shellStatus().default_source).toBe(loginShell() ? "account" : "fallback");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("installed shells skip multiplexers, missing files and second names for one shell", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-shells-"));
  try {
    symlinkSync("/bin/sh", join(root, "sh-link"));
    writeFileSync(
      join(root, "shells"),
      [
        "# comment",
        "/bin/sh",
        join(root, "sh-link"),
        "/usr/bin/tmux",
        "/bin/missing",
        "relative",
        "/bin/bash",
        "",
      ].join("\n"),
    );
    expect(installedShells(join(root, "shells"))).toEqual(["/bin/bash", "/bin/sh"]);
    expect(installedShells(join(root, "absent"))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
