import { test, expect } from "bun:test";
import { chatFlag, instructions, tool, toolArgs, toolLine, where } from "./prompt_tools";

const bin = "/Users/me/.local/bin/corgi";
test("the instructions name the binary and the commands that show the user something", () => {
  const text = instructions(bin);
  expect(text).toContain(bin);
  expect(text).toContain("corgi resume PROVIDER SESSION --viewer V");
  expect(text.slice(0, text.indexOf("<corgi_skill>"))).toContain(
    "Show commits inline in normal Markdown with descriptive links",
  );
  // The skill comes whole, without the front matter a skill file starts with.
  expect(text).toContain("<corgi_skill>\n# Corgi\n");
  expect(text).toContain("## Read, message and send");
  expect(text).not.toContain("name: corgi");
  expect(where(7, 'my "ws"')).toBe('<corgi viewer="7" workspace="my  ws "/>');
});
test("a session with Corgi's tool drives Corgi through it; one without, through its shell", () => {
  const shell = instructions(bin),
    tools = instructions(bin, true);
  expect(shell).toContain(`its CLI: \`corgi\` (also ${bin})`);
  expect(tools).toContain("with the `corgi` tool");
  expect(tools).not.toContain(bin);
  // Both describe the same commands.
  for (const text of [shell, tools]) expect(text).toContain("corgi resume PROVIDER SESSION --viewer V");
  expect(chatFlag(7)).toContain("`--chat 7`");
});
test("the tool takes a command's words, nothing a shell would read", () => {
  expect(tool.name).toBe("corgi");
  expect(toolArgs({ args: ["memory", "add", "--workspace", "Q&A!", "x; rm -rf ~"] })).toEqual([
    "memory",
    "add",
    "--workspace",
    "Q&A!",
    "x; rm -rf ~",
  ]);
  for (const bad of [{}, { args: [] }, { args: "list" }, { args: ["list", 3] }, null]) expect(toolArgs(bad)).toBeNull();
  expect(toolLine({ args: ["grep", "--workspace", "/project", "flicker"] })).toBe(
    "corgi grep --workspace /project flicker",
  );
});
