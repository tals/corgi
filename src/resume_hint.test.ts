import { test, expect } from "bun:test";
import { ResumeHint } from "./resume_hint";
import { Text } from "./providers";
import { Agent } from "./agents";
test("resume command quotes session text as one shell argument", () => {
  const hint = new ResumeHint();
  hint.provider = "codex";
  hint.session = new Text("session'with quote");
  expect(hint.command()).toBe("codex resume 'session'\\''with quote'");
});
test("recovery metadata survives observation and clears on session switch", () => {
  const agent = new Agent();
  agent.provider = "codex";
  agent.updated_at = 1000;
  agent.session = new Text("first");
  agent.setName("A session\nwith controls\x1b");
  const hint = new ResumeHint();
  hint.observe(agent);
  expect(hint.banner(1120)).toContain("# A session with controls ");
  expect(hint.banner(1120)).toContain("# Last active 2 minutes ago");
  agent.session = new Text("second");
  agent.name = new Text();
  agent.updated_at = 0;
  hint.observe(agent);
  expect(hint.name.len).toBe(0);
  expect(hint.touched_at).toBe(0);
});
test("recovery never prefills selection or control characters", () => {
  const hint = new ResumeHint();
  hint.provider = "codex";
  expect(hint.command()).toBe("");
  hint.session = new Text("a\nbc");
  expect(hint.command()).toBe("");
});
