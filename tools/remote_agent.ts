/** Real terminal apps, disposable settings, and a model that only answers locally. */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

export function model(provider: "claude" | "codex") {
  const answer = `Sandbox reply from ${provider === "claude" ? "Claude" : "Codex"}. No model request left this machine.`;
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/count_tokens")) return Response.json({ input_tokens: 20 });
      if (!path.endsWith("/messages") && !path.endsWith("/responses")) return Response.json({ data: [] });
      const body = (await request.json()) as { stream?: boolean };
      const id = "sandbox_" + crypto.randomUUID();
      const message = {
        id,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: answer }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 20 },
      };
      const item = {
        id: "msg_" + id,
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: answer }],
      };
      if (body.stream === false)
        return Response.json(path.endsWith("/messages") ? message : { id, output: [item], status: "completed" });
      const events = path.endsWith("/messages")
        ? [
            { type: "message_start", message: { ...message, content: [], stop_reason: null } },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 20 },
            },
            { type: "message_stop" },
          ]
        : [
            { type: "response.created", response: { id } },
            { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
            { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: answer },
            { type: "response.output_item.done", output_index: 0, item },
            {
              type: "response.completed",
              response: {
                id,
                status: "completed",
                output: [item],
                usage: { input_tokens: 20, output_tokens: 20, total_tokens: 40 },
              },
            },
          ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
}

export async function run(provider: "claude" | "codex"): Promise<number> {
  const binary = process.env[provider === "claude" ? "CORGI_LAB_CLAUDE" : "CORGI_LAB_CODEX"];
  if (!binary || !existsSync(binary)) throw Error(`The remote sandbox needs an installed ${provider} binary`);
  const root = join(process.env.HOME!, ".idle-agents");
  mkdirSync(root, { recursive: true });
  const home = mkdtempSync(join(root, provider + "-"));
  const cwd = realpathSync(process.cwd());
  const api = model(provider);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_)/.test(key)) delete env[key];
  Object.assign(env, {
    HOME: home,
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    ANTHROPIC_API_KEY: "corgi-sandbox-key",
    ANTHROPIC_BASE_URL: api.url.toString().replace(/\/$/, ""),
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
  });
  mkdirSync(env.CLAUDE_CONFIG_DIR!, { recursive: true });
  mkdirSync(env.CODEX_HOME!, { recursive: true });
  writeFileSync(
    join(env.CLAUDE_CONFIG_DIR!, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      theme: "dark",
      customApiKeyResponses: { approved: ["corgi-sandbox-key"], rejected: [] },
      projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    }),
  );
  writeFileSync(
    join(env.CODEX_HOME!, "config.toml"),
    [
      'model = "gpt-5.4"',
      'model_provider = "sandbox"',
      'model_reasoning_effort = "low"',
      "check_for_update_on_startup = false",
      "[features]",
      "plugins = false",
      "apps = false",
      "hooks = false",
      "[model_providers.sandbox]",
      'name = "Sandbox"',
      `base_url = "${api.url}v1"`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      `[projects.${JSON.stringify(cwd)}]`,
      'trust_level = "trusted"',
      "",
    ].join("\n"),
  );
  let appServer: ReturnType<typeof Bun.spawn> | undefined, child: ReturnType<typeof Bun.spawn> | undefined;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    for (const process of [child, appServer]) if (process?.exitCode === null) process.kill();
    await Promise.all([child?.exited, appServer?.exited]);
    api.stop(true);
  };
  const signal = () => void stop().then(() => process.exit(0));
  for (const name of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(name, signal);
  try {
    if (provider === "codex") {
      appServer = Bun.spawn([binary, "app-server", "--listen", "unix://"], {
        env,
        cwd,
        stdin: "ignore",
        stdout: "ignore",
        stderr: Bun.file(join(home, "server.log")),
      });
      const socket = join(env.CODEX_HOME!, "app-server-control/app-server-control.sock");
      const until = Date.now() + 15000;
      while (!existsSync(socket)) {
        if (stopping || appServer.exitCode !== null || Date.now() >= until)
          throw Error(`Codex server did not start; see ${join(home, "server.log")}`);
        await Bun.sleep(50);
      }
    }
    child = Bun.spawn(
      [binary, ...(provider === "claude" ? ["--bare", "--model", "claude-sonnet-4-6"] : ["--no-alt-screen"])],
      { env, cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    );
    return await child.exited;
  } finally {
    await stop();
    for (const name of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.off(name, signal);
  }
}

if (import.meta.main) {
  const provider = process.argv[2];
  if (provider !== "claude" && provider !== "codex") throw Error("Usage: remote_agent.ts claude|codex");
  process.exitCode = await run(provider);
}
