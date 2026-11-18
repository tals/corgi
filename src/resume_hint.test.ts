import { test, expect } from "bun:test";
import { ResumeHint } from "./resume_hint";
import { Text } from "./providers";
import { Agent } from "./agents";
import { hydrate } from "./persist/checkpoint";
import * as json from "./json";
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
test("a saved hint comes back with the permissions and model its agent last reported", () => {
  const agent = new Agent();
  agent.provider = "codex";
  agent.session = new Text("saved");
  agent.permissions = "bypass";
  agent.model = new Text("gpt-5.5");
  const hint = new ResumeHint();
  hint.observe(agent);
  const restored = hydrate(new ResumeHint(), json.clone(hint));
  expect(restored.permissions).toBe("bypass");
  expect(restored.model.text()).toBe("gpt-5.5");
  expect(restored.session.text()).toBe("saved");
});
test("recovery never prefills selection or control characters", () => {
  const hint = new ResumeHint();
  hint.provider = "codex";
  expect(hint.command()).toBe("");
  hint.session = new Text("a\nbc");
  expect(hint.command()).toBe("");
});
