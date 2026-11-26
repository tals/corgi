import { test, expect } from "bun:test";
import { chatFlag, instructions, tool, toolArgs, toolLine, where } from "./prompt_tools";
import skill from "../assets/corgi-skill.md" with { type: "text" };
import recallSkill from "../assets/corgi-recall-skill.md" with { type: "text" };

const bin = "/Users/me/.local/bin/corgi";
test("the instructions carry the reply format, then the Corgi skill, and each message names its viewer", () => {
  const text = instructions(bin);
  expect(text.slice(0, text.indexOf("<corgi_skill>"))).toContain(
    "Show commits inline in normal Markdown with descriptive links",
  );
  // The skill comes whole, without the front matter a skill file starts with.
  expect(text).toContain("<corgi_skill>\n# Corgi\n");
  expect(text).toContain("## Read, message and send");
  expect(text).not.toContain("name: corgi");
  expect(where(7, 'my "ws"')).toBe('<corgi viewer="7" workspace="my  ws "/>');
});
test("the instructions point to the recall skill without embedding it", () => {
  const text = instructions(bin),
    description = /\ndescription: (.*)\n/.exec(recallSkill)?.[1];
  expect(text).toContain("`corgi skill show recall`");
  expect(text).not.toContain("# Corgi recall");
  expect(description).toBeTruthy();
  expect(text).not.toContain(description!);
  // The pointer is the only recall guidance the prompt carries.
  const recall = (lines: string) => lines.split("\n").filter(line => /recall/i.test(line));
  expect(recall(skill)).toHaveLength(1);
  expect(recall(text)).toEqual(recall(skill));
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
