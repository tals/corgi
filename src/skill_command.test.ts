import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import corgiSkill from "../assets/corgi-skill.md" with { type: "text" };
import recallSkill from "../assets/corgi-recall-skill.md" with { type: "text" };
import * as accounts from "./accounts";
import * as integration from "./integration";
import * as skillCommand from "./skill_command";

const variables = [
    "HOME",
    "CORGI_ENV_BASE",
    "XDG_STATE_HOME",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "PI_CODING_AGENT_DIR",
  ],
  saved = Object.fromEntries(variables.map(key => [key, process.env[key]]));
let home = "";
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "corgi-skill-")));
  for (const key of variables) delete process.env[key];
  process.env.HOME = home;
  process.env.CORGI_ENV_BASE = join(home, "state");
  // Claude Code and Pi are set up; Codex and omp are not.
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  // One account shares the default's skills, as Corgi links them; one keeps its own.
  mkdirSync(join(home, "work"));
  symlinkSync(join(home, ".claude", "skills"), join(home, "work", "skills"));
  mkdirSync(join(home, "solo"));
  accounts.reset();
  accounts.add("claude", "work", join(home, "work"));
  accounts.add("claude", "solo", join(home, "solo"));
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  accounts.reset();
  rmSync(home, { recursive: true, force: true });
});

/** Runs `corgi skill ARGS`, with what it printed and its exit status. */
async function run(...args: string[]) {
  const out = spyOn(process.stdout, "write").mockReturnValue(true),
    err = spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    const code = await skillCommand.command(args);
    return {
      code,
      stdout: out.mock.calls.map(c => String(c[0])).join(""),
      stderr: err.mock.calls.map(c => String(c[0])).join(""),
    };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}
const claude = () => join(home, ".claude", "skills", "corgi-recall", "SKILL.md"),
  solo = () => join(home, "solo", "skills", "corgi-recall", "SKILL.md"),
  pi = () => join(home, ".pi", "agent", "skills", "corgi-recall", "SKILL.md");

test("list names each bundled skill with its description", async () => {
  const { code, stdout } = await run("list");
  expect(code).toBe(0);
  const lines = stdout.trimEnd().split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toStartWith("corgi   Use Corgi to manage panes");
  expect(lines[1]).toStartWith("recall  Use when the user asks to recall");
});

test("show prints a bundled skill verbatim", async () => {
  expect((await run("show", "recall")).stdout).toBe(recallSkill);
  expect((await run("show", "corgi")).stdout).toBe(corgiSkill);
});

test("install writes each real skill folder once and skips missing homes", async () => {
  const first = await run("install", "recall");
  expect(first.code).toBe(0);
  expect(first.stdout).toBe(
    [
      "· Codex               recall  skipped, no ~/.codex",
      "✓ Claude Code         recall  written to ~/.claude/skills/corgi-recall/SKILL.md",
      "✓ Claude Code · solo  recall  written to ~/solo/skills/corgi-recall/SKILL.md",
      "✓ Pi                  recall  written to ~/.pi/agent/skills/corgi-recall/SKILL.md",
      "· Oh My Pi            recall  skipped, no ~/.omp/agent",
      "",
    ].join("\n"),
  );
  for (const path of [claude(), solo(), pi()]) expect(readFileSync(path, "utf8")).toBe(recallSkill);
  expect(existsSync(join(home, ".codex"))).toBe(false);
  expect(existsSync(join(home, ".omp"))).toBe(false);

  const again = await run("install", "recall");
  expect(again.code).toBe(0);
  expect(again.stdout).toContain(
    "· Claude Code         recall  already current in ~/.claude/skills/corgi-recall/SKILL.md",
  );
  expect(again.stdout).not.toContain("✓");

  writeFileSync(pi(), "---\nname: corgi-recall\ndescription: old\n---\n\nOld text.\n");
  const refreshed = await run("install", "recall", "pi");
  expect(refreshed.code).toBe(0);
  expect(refreshed.stdout).toBe("✓ Pi  recall  refreshed ~/.pi/agent/skills/corgi-recall/SKILL.md\n");
  expect(readFileSync(pi(), "utf8")).toBe(recallSkill);
});

test("install refuses a SKILL.md that names another skill", async () => {
  const theirs = "---\nname: my-recall\ndescription: mine\n---\n\nMine.\n";
  mkdirSync(join(home, ".claude", "skills", "corgi-recall"));
  writeFileSync(claude(), theirs);
  const { code, stdout } = await run("install", "recall", "claude");
  expect(code).toBe(1);
  expect(stdout).toContain(
    "✗ Claude Code         recall  conflict: ~/.claude/skills/corgi-recall/SKILL.md names another skill",
  );
  expect(stdout).toContain("✓ Claude Code · solo  recall  written to");
  expect(readFileSync(claude(), "utf8")).toBe(theirs);
});

test("status shows current, outdated, absent and conflicting copies with the next command", async () => {
  await run("install", "recall", "claude", "--account", "default");
  mkdirSync(join(home, ".pi", "agent", "skills", "corgi-recall"), { recursive: true });
  writeFileSync(pi(), "---\nname: corgi-recall\ndescription: old\n---\n");
  mkdirSync(join(home, "solo", "skills", "corgi-recall"), { recursive: true });
  writeFileSync(solo(), "no front matter\n");
  const { code, stdout } = await run("status");
  expect(code).toBe(0);
  const lines = stdout.trimEnd().split("\n");
  expect(lines).toContain("· Codex               recall  no ~/.codex");
  expect(lines.filter(l => / corgi  /.test(l))).toEqual([]);
  expect(lines).toContain("✓ Claude Code         recall  current in ~/.claude/skills/corgi-recall/SKILL.md");
  expect(lines).toContain(
    "✗ Claude Code · solo  recall  conflict: ~/solo/skills/corgi-recall/SKILL.md names another skill",
  );
  expect(lines).toContain(
    "✗ Pi                  recall  outdated in ~/.pi/agent/skills/corgi-recall/SKILL.md; `corgi skill install recall` refreshes it",
  );
  // Recall in each of five folders; the linked account shares the default's.
  expect(lines).toHaveLength(5);
  expect((await run("status", "recall", "pi")).stdout.trimEnd().split("\n")).toHaveLength(1);
});

test("status lists the Corgi guide only where it is installed, unless asked for by name", async () => {
  await run("install", "corgi", "claude", "--account", "default");
  const lines = (await run("status")).stdout.trimEnd().split("\n");
  expect(lines.filter(l => / corgi  /.test(l))).toEqual([
    "✓ Claude Code         corgi   current in ~/.claude/skills/corgi/SKILL.md",
  ]);
  expect((await run("status", "corgi", "pi")).stdout).toContain(
    "absent from ~/.pi/agent/skills; `corgi skill install corgi` adds it",
  );
});

test("uninstall removes only Corgi's file and the folder it leaves empty", async () => {
  await run("install", "recall");
  writeFileSync(join(home, "solo", "skills", "corgi-recall", "notes.md"), "keep\n");
  writeFileSync(pi(), "---\nname: someone-else\n---\n");
  const { code, stdout } = await run("uninstall", "recall");
  expect(code).toBe(1);
  expect(stdout).toContain("✓ Claude Code         recall  removed ~/.claude/skills/corgi-recall\n");
  expect(stdout).toContain("✓ Claude Code · solo  recall  removed ~/solo/skills/corgi-recall/SKILL.md; left notes.md");
  expect(stdout).toContain(
    "✗ Pi                  recall  conflict: ~/.pi/agent/skills/corgi-recall/SKILL.md names another skill, left",
  );
  expect(existsSync(join(home, ".claude", "skills", "corgi-recall"))).toBe(false);
  expect(existsSync(join(home, ".claude", "skills"))).toBe(true);
  expect(existsSync(solo())).toBe(false);
  expect(readFileSync(join(home, "solo", "skills", "corgi-recall", "notes.md"), "utf8")).toBe("keep\n");
  expect(readFileSync(pi(), "utf8")).toBe("---\nname: someone-else\n---\n");
  const again = await run("uninstall", "recall", "claude");
  expect(again.code).toBe(0);
  expect(again.stdout).toContain("· Claude Code         recall  not in ~/.claude/skills");
});

test("a provider and --account narrow the folders", async () => {
  const solo = await run("install", "recall", "--account", "solo");
  expect(solo.stdout).toBe("✓ Claude Code · solo  recall  written to ~/solo/skills/corgi-recall/SKILL.md\n");
  expect(existsSync(claude())).toBe(false);
  const work = await run("install", "recall", "claude", "--account", "work");
  expect(work.stdout).toBe("✓ Claude Code · work  recall  written to ~/work/skills/corgi-recall/SKILL.md\n");
  // The work account's skills are the default's.
  expect(readFileSync(claude(), "utf8")).toBe(recallSkill);
  const unknown = await run("install", "recall", "--account", "nobody");
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain("no account by that name");
});

test("usage errors print the usage on stderr", async () => {
  for (const args of [
    ["show"],
    ["show", "nope"],
    ["show", "Recall"],
    ["install"],
    ["install", "nope"],
    ["uninstall"],
    ["frobnicate"],
    ["list", "extra"],
    ["show", "recall", "claude"],
    ["install", "recall", "opencode2"],
    ["install", "recall", "nope"],
    ["install", "recall", "--account", ""],
    ["install", "recall", "--account"],
    ["status", "recall", "claude", "extra"],
  ]) {
    const { code, stdout, stderr } = await run(...args);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toStartWith("Usage: corgi skill COMMAND [NAME] [codex|claude|pi|omp] [--account NAME]");
  }
  for (const args of [[], ["help"], ["install", "--help"]]) {
    const { code, stdout } = await run(...args);
    expect(code).toBe(0);
    expect(stdout).toContain("NAME is corgi or recall. Nothing is installed until you run install.");
  }
});

test("corgi integration install writes no skills", async () => {
  const out = spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    await integration.command("install", "claude");
    await integration.command("install", "pi");
  } finally {
    out.mockRestore();
  }
  for (const path of [claude(), solo(), pi()]) expect(existsSync(path)).toBe(false);
  expect(existsSync(join(home, ".claude", "skills", "corgi"))).toBe(false);
});
