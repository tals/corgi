/**
 * Pi with a subagent plugin: the real `pi` on PATH, a stand-in model that
 * delegates every request to two subagents, and a small plugin that runs them
 * inside Pi's process the way pi-subagents and tintinweb's do. Each subagent
 * shows under the Pi conversation while it works.
 */
import { join } from "node:path";
import { table, type Sandbox, type World } from "../sandbox";

/** An OpenAI-compatible model on a free port: the parent calls `subagent`,
 * and each subagent answers after a few seconds. */
const model = `
import { writeFileSync } from "node:fs";
const [config, ready] = process.argv.slice(2);
const chunk = (delta, finish = null) =>
  "data: " + JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] }) + "\\n\\n";
const server = Bun.serve({
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    const body = await req.json(), messages = body.messages ?? [];
    const parent = (body.tools ?? []).some(t => t.function?.name === "subagent");
    let stream;
    if (parent && messages.at(-1)?.role !== "tool") {
      const tasks = [
        { agent: "scout", task: "Map how the sidebar draws agent rows" },
        { agent: "reviewer", task: "Review the launcher's account picker" },
      ];
      stream = chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_" + Date.now(), type: "function",
        function: { name: "subagent", arguments: JSON.stringify({ tasks }) } }] }) + chunk({}, "tool_calls");
    } else {
      if (!parent) await Bun.sleep(6000 + Math.random() * 6000);
      stream = chunk({ role: "assistant", content: parent ? "Both subagents reported back." : "Done: nothing surprising." }) + chunk({}, "stop");
    }
    return new Response(stream + "data: [DONE]\\n\\n", { headers: { "content-type": "text/event-stream" } });
  },
});
writeFileSync(config, JSON.stringify({ providers: { fake: { baseUrl: "http://127.0.0.1:" + server.port + "/v1", api: "openai-completions",
  apiKey: "fake", models: [{ id: "m", name: "Stand-in", contextWindow: 200000, maxTokens: 4000, input: ["text"], reasoning: false }] } } }));
writeFileSync(ready, "");
`;

/** A subagent plugin: its tool runs each task in a session of its own, made
 * from Pi's SDK in Pi's process, with no extensions loaded. */
const plugin = `
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Run tasks in parallel subagents.",
    parameters: Type.Object({ tasks: Type.Array(Type.Object({ agent: Type.String(), task: Type.String() })) }),
    async execute(_id, params, _signal, _update, ctx) {
      const parent = ctx.sessionManager.getSessionFile();
      const reports = await Promise.all(params.tasks.map(async ({ agent, task }) => {
        const resourceLoader = new DefaultResourceLoader({ cwd: ctx.cwd, agentDir: getAgentDir(), noExtensions: true });
        await resourceLoader.reload();
        const { session } = await createAgentSession({ cwd: ctx.cwd, resourceLoader, tools: ["read"],
          sessionManager: SessionManager.create(ctx.cwd, parent.replace(/\\.jsonl$/, ""), { parentSession: parent }) });
        session.setSessionName(agent + ": " + task);
        await session.prompt("Task: " + task);
        const reply = session.messages.findLast(m => m.role === "assistant");
        session.dispose();
        return agent + ": " + (reply?.content ?? []).map(part => part.text ?? "").join("");
      }));
      return { content: [{ type: "text", text: reports.join("\\n") }], details: {} };
    },
  });
}
`;

function paths(s: Sandbox) {
  const agent = join(s.home, ".pi/agent");
  return {
    agent,
    project: join(s.dir, "project"),
    model: join(s.dir, "model.ts"),
    ready: join(s.dir, "run", "model-ready"),
  };
}

export const world: World = {
  seed(s) {
    const p = paths(s);
    s.write(join(p.project, "README.md"), "# A project for Pi's subagents to look at\n");
    s.write(p.model, model);
    s.write(join(p.agent, "extensions", "subagents.js"), plugin);
    s.write(
      join(p.agent, "settings.json"),
      JSON.stringify({ defaultProvider: "fake", defaultModel: "m", lastChangelogVersion: "99.0.0" }),
    );
  },
  arrange(s) {
    const p = paths(s),
      before: { id: number; model?: { tabs?: unknown[] } }[] = s.corgi(["workspace", "list"])?.workspaces ?? [],
      workspace: { workspace: number; tab: number } = s.corgi(["workspace", "new", "Pi subagents", "--cwd", p.project]);
    s.corgi(["tab", "rename", String(workspace.tab), "shell"]);
    const start =
      `rm -f '${p.ready}'; '${process.execPath}' '${p.model}' '${join(p.agent, "models.json")}' '${p.ready}' & ` +
      `while [ ! -e '${p.ready}' ]; do sleep 0.05; done; exec '${s.exe}' agent pi`;
    s.corgi([
      "tab",
      "new",
      "--workspace",
      String(workspace.workspace),
      "--name",
      "Pi",
      "--cwd",
      p.project,
      "--command",
      start,
    ]);
    // The daemon's own starting workspace stays empty; close it so only this one shows.
    for (const w of before)
      if (w.id !== workspace.workspace && (w.model?.tabs?.length ?? 0) === 0)
        s.corgi(["workspace", "close", String(w.id)], false);
  },
  intro() {
    return [
      "Pi with a subagent plugin. Each request runs two subagents for 6-12 seconds.",
      ...table([
        ["type", "anything in the Pi pane, then Enter: scout and reviewer show under it"],
        ["hover", "the Pi row's subagent count to list them"],
      ]),
    ];
  },
};
