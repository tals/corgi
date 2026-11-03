import { test, expect } from "bun:test";
import { instructions, looks, where } from "./prompt_tools";

const bin = "/Users/me/.local/bin/corgi";
test("Corgi commands that only look or move a viewer run without asking", () => {
  for (const line of [
    "corgi list",
    "corgi list --json",
    "corgi history --limit 30",
    "corgi grep --workspace '/project' --tools -iC2 'branch|worktree'",
    "corgi resume claude 0f315d2b-dd8d-4ce2-93db-6831458ca975 --viewer 7",
    "corgi focus 31 --viewer 7",
    "corgi workspace switch 2 --viewer 7",
    "corgi pane read 31 --lines 80",
    `${bin} list`,
    "corgi --skill",
  ])
    expect(looks(line, bin)).toBe(true);
});
test("anything else asks", () => {
  for (const line of [
    "corgi pane send 31 hi --enter",
    "corgi pane keys 31 ctrl+c",
    "corgi pane close 31",
    "corgi tab new --command rm",
    "corgi workspace close 2",
    "corgi launcher edit claude --yolo on",
    "corgi list; rm -rf ~",
    "corgi grep --workspace '/project' needle; rm -rf ~",
    "corgi grep --workspace '/project' \"$(id)\"",
    "corgi grep --workspace '*' 'needle' > /tmp/results",
    "corgi list && curl x",
    "corgi list | sh",
    "corgi list\nrm -rf ~",
    "corgi list $(rm -rf ~)",
    "corgi list `id`",
    "corgi resume claude 'x'",
    "corgi list > /etc/passwd",
    "corgi focus 31 --viewer x",
    "corgi focus 31 --unknown",
    "/tmp/evil/corgi list",
    "corgix list",
    "ls",
    "",
  ])
    expect(looks(line, bin)).toBe(false);
});
test("memory commands run without asking, their text quoted, but nothing a shell would run", () => {
  for (const line of [
    "corgi memory search bun tests",
    "corgi memory get MEMORY.md:3-10",
    'corgi memory add --long "Prefers bun over npm"',
    "corgi memory add 'Ships on Fridays; never on Mondays'",
    'corgi memory add --replaces 2026-10-31.md:2 "foo = qux"',
    "corgi memory forget 2026-10-31.md:2",
    `${bin} memory add --workspace corgi "Tests run with bun test src"`,
  ])
    expect(looks(line, bin)).toBe(true);
  for (const line of [
    'corgi memory add "x $(rm -rf ~)"',
    'corgi memory add "x `id`"',
    "corgi memory add 'x' ; rm -rf ~",
    "corgi memory add 'x' && curl evil",
    'corgi memory add "x" > /etc/passwd',
    "corgi memory add 'unterminated",
    "corgi memory wipe",
    "/tmp/evil/corgi memory add x",
  ])
    expect(looks(line, bin)).toBe(false);
});
test("the instructions name the binary and the commands that show the user something", () => {
  const text = instructions(bin);
  expect(text).toContain(bin);
  expect(text).toContain("corgi resume PROVIDER SESSION --viewer V");
  // The skill comes whole, without the front matter a skill file starts with.
  expect(text).toContain("<corgi_skill>\n# Corgi\n");
  expect(text).toContain("## Read, message and send");
  expect(text).not.toContain("name: corgi");
  expect(where(7, 'my "ws"')).toBe('<corgi viewer="7" workspace="my  ws "/>');
});
