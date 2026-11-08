//! Capture real TUIs with disposable homes and canned local model responses.
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Terminal } from "../../../src/pane/terminal";

const root = resolve(import.meta.dir, "../../..");
const name = process.argv[2];
if (!["codex", "claude", "micro", "shell", "cat", "cat-dense", "moonlander", "moonlander-kitty"].includes(name))
  throw Error(
    "usage: bun tools/benchmarks/frame_sequences/record.ts codex|claude|micro|shell|cat|cat-dense|moonlander|moonlander-kitty [OUTPUT_DIRECTORY] [SCENARIO_JSON]",
  );
const output = resolve(
  process.argv[3] ??
    (name.startsWith("moonlander") ? join(root, "dist/benchmarks/frame_sequences") : join(import.meta.dir, "fixtures")),
);
const dir = realpathSync(mkdtempSync(join(tmpdir(), "corgi-frames-")));
const cols = 120,
  rows = 40;
const screen = Terminal.create(cols, rows);
const frames: { at: number; frame: string }[] = [];
const actions: { at: number; input: string }[] = [];
const scenario: { prompt: string; answer: string; expected: string } | null = process.argv[4]
  ? await Bun.file(process.argv[4]).json()
  : null;
if (
  scenario &&
  [scenario.prompt, scenario.answer, scenario.expected].some(value => typeof value !== "string" || !value)
)
  throw Error("InvalidScenario");
const answer =
  scenario?.answer ??
  "Here is a small example.\n\n```typescript\nexport function total(values: number[]): number {\n  return values.reduce((sum, value) => sum + value, 0);\n}\n```\n\n" +
    Array.from(
      { length: 18 },
      (_, i) => `${i + 1}. Check item ${i + 1}: keep the result readable and verify the boundary cases.\n`,
    ).join("");
let requests = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    if (!new URL(req.url).pathname.endsWith("/responses") && !new URL(req.url).pathname.endsWith("/messages"))
      return Response.json({ data: [] });
    requests++;
    const claude = new URL(req.url).pathname.endsWith("/messages");
    const stream = new ReadableStream({
      async start(controller) {
        const event = (value: Record<string, unknown>) =>
          controller.enqueue(new TextEncoder().encode(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`));
        try {
          if (claude) {
            event({
              type: "message_start",
              message: {
                id: "msg_fixture",
                type: "message",
                role: "assistant",
                model: "claude-sonnet-4-6",
                content: [],
                stop_reason: null,
                usage: { input_tokens: 20, output_tokens: 0 },
              },
            });
            event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
          } else {
            event({ type: "response.created", response: { id: "resp_fixture" } });
            event({
              type: "response.output_item.added",
              item: { type: "message", role: "assistant", id: "msg_fixture", content: [] },
            });
          }
          for (const delta of answer.match(/.{1,24}|\n/g)!) {
            event(
              claude
                ? { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } }
                : { type: "response.output_text.delta", delta },
            );
            await Bun.sleep(45);
          }
          if (claude) {
            event({ type: "content_block_stop", index: 0 });
            event({
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 300 },
            });
            event({ type: "message_stop" });
          } else {
            event({
              type: "response.output_item.done",
              item: {
                type: "message",
                role: "assistant",
                id: "msg_fixture",
                content: [{ type: "output_text", text: answer }],
              },
            });
            event({
              type: "response.completed",
              response: { id: "resp_fixture", usage: { input_tokens: 20, output_tokens: 300, total_tokens: 320 } },
            });
          }
          controller.close();
        } catch {
          /* The disposable client may close its stream on exit. */
        }
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  },
});
mkdirSync(join(dir, ".codex"));
await Bun.write(
  join(dir, ".codex/config.toml"),
  `model = "gpt-5.4"\nmodel_provider = "fixture"\ncheck_for_update_on_startup = false\n[model_providers.fixture]\nname = "fixture"\nbase_url = "${server.url}v1"\nwire_api = "responses"\n[projects."${dir}"]\ntrust_level = "trusted"\n`,
);
await Bun.write(
  join(dir, ".claude.json"),
  JSON.stringify({
    hasCompletedOnboarding: true,
    theme: "dark",
    lastOnboardingVersion: "2.1.306",
    projects: { [dir]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  }),
);
await Bun.write(
  join(dir, "example.ts"),
  Array.from({ length: 200 }, (_, i) => `export const item${i} = "sample ${i} 界 é";\n`).join(""),
);
await Bun.write(
  join(dir, "big.txt"),
  Array.from(
    { length: 30000 },
    (_, i) =>
      `${String(i).padStart(6, "0")} ${name === "cat-dense" ? Array.from({ length: 90 }, (_, j) => String.fromCharCode(33 + (Math.imul(i + 1, j + 47) % 90))).join("") : "sample output 界 ".repeat(6)}\n`,
  ).join(""),
);
const commands: Record<string, string[]> = {
  codex: ["codex", "--no-alt-screen", "-c", 'model_reasoning_effort="low"'],
  claude: ["claude", "--bare", "--model", "claude-sonnet-4-6"],
  micro: ["micro", "-config-dir", join(dir, "micro"), "example.ts"],
  shell: ["/bin/zsh", "-f"],
  cat: ["/bin/zsh", "-f"],
  "cat-dense": ["/bin/zsh", "-f"],
  moonlander: [process.execPath, join(root, "tools/moonlander.ts"), "--hull", "turned-gray"],
  "moonlander-kitty": [process.execPath, join(root, "tools/moonlander.ts")],
};
const start = performance.now();
let dirty = false;
let kittyPending = "",
  sending: string | null = null;
const uploads = new Set<string>();
const uvCache = name === "moonlander-kitty" ? Bun.spawnSync(["uv", "cache", "dir"]).stdout.toString().trim() : "";
const child = Bun.spawn(commands[name], {
  cwd: dir,
  env: {
    PATH: process.env.PATH!,
    HOME: dir,
    TMPDIR: tmpdir(),
    TERM: name === "moonlander-kitty" ? "xterm-kitty" : "xterm-256color",
    ...(uvCache ? { UV_CACHE_DIR: uvCache } : {}),
    COLORTERM: "truecolor",
    LANG: "en_US.UTF-8",
    PS1: "$ ",
    CODEX_HOME: join(dir, ".codex"),
    ANTHROPIC_API_KEY: "fixture-key",
    ANTHROPIC_BASE_URL: server.url.toString().replace(/\/$/, ""),
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
    CORGI_NATIVE_ROOT: join(root, "native/zig-out"),
  },
  terminal: {
    cols,
    rows,
    data(pty, bytes) {
      screen.feed(bytes);
      const pending = screen.native({ op: "takePending" }) as string;
      if (pending) pty.write(pending);
      if (name === "moonlander-kitty") {
        kittyPending += Buffer.from(bytes).toString("latin1");
        while (kittyPending.length) {
          const esc = kittyPending.indexOf("\x1b");
          if (esc < 0) {
            kittyPending = "";
            break;
          }
          if (esc > 0) kittyPending = kittyPending.slice(esc);
          if (kittyPending.length < 2) break;
          if (kittyPending.startsWith("\x1b_G")) {
            const end = kittyPending.indexOf("\x1b\\");
            if (end < 0) break;
            const fields = Object.fromEntries(
              kittyPending
                .slice(3, end)
                .split(";", 1)[0]
                .split(",")
                .map(field => field.split("=")),
            );
            kittyPending = kittyPending.slice(end + 2);
            if (fields.a === "q") pty.write("\x1b[6;22;10t\x1b_Gi=730201;OK\x1b\\");
            if (fields.a === "t") sending = fields.i;
            if (sending && fields.m === "0") {
              uploads.add(sending);
              pty.write(`\x1b_Gi=${sending};OK\x1b\\`);
              sending = null;
            }
          } else if (kittyPending.startsWith("\x1b[")) {
            const match = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(kittyPending);
            if (!match) break;
            kittyPending = kittyPending.slice(match[0].length);
            if (match[0] === "\x1b[16t") pty.write("\x1b[6;22;10t");
            if (match[0] === "\x1b[14t") pty.write("\x1b[4;880;1200t");
          } else if ("\x1b_G".startsWith(kittyPending)) break;
          else kittyPending = kittyPending.slice(2);
        }
      }
      dirty = true;
    },
  },
});
const capture = () => {
  if (!dirty || screen.vt.modes.get("synchronized_output")) return;
  dirty = false;
  const surface = screen.surface(0).surface;
  let frame = "\x1b[?7l\x1b[0m\x1b[H\x1b[J";
  for (let row = 0; row < surface.lines.length; row++) frame += `\x1b[${row + 1};1H${surface.lines[row]}`;
  frame += surface.cursor ? `\x1b[${surface.cursor.y + 1};${surface.cursor.x + 1}H\x1b[?25h` : "\x1b[H\x1b[?25l";
  frame += "\x1b[0m";
  if (frames.at(-1)?.frame !== frame) frames.push({ at: Math.round(performance.now() - start), frame });
};
const interval = setInterval(capture, 33);
const send = async (input: string, delay = 200) => {
  actions.push({ at: Math.round(performance.now() - start), input });
  child.terminal!.write(input);
  await Bun.sleep(delay);
};
try {
  await Bun.sleep(1800);
  if (name === "moonlander-kitty") {
    const deadline = performance.now() + 15000;
    while (uploads.size < 2 && performance.now() < deadline) await Bun.sleep(100);
    if (uploads.size < 2) throw Error("Kitty assets did not initialize");
  }
  if (name === "codex" || name === "claude") {
    if (name === "claude" && screen.liveText().includes("Yes, I trust this folder")) await send("\x1b[B\r", 1500);
    if (name === "claude" && screen.liveText().includes("API key")) {
      console.log("KEY", screen.liveText());
      await send("\x1b[A\r", 1000);
    }
    console.log("START", screen.liveText());
    await send(scenario?.prompt ?? "Write a short TypeScript example and a numbered checklist. Do not use tools.", 300);
    await send("\r", 7000);
    console.log("ANSWER", screen.liveText());
    await send("Follow up: ", 200);
    await send("\x1b[D".repeat(4), 200);
    await send("\x7f\x7f", 200);
    await send("\x03", 200);
  } else if (name === "micro") {
    await send("// edit at top\r");
    await send("\x1b[6~".repeat(3));
    await send("\x06");
    await send("item125");
    await send("\r");
    await send("\x1b");
    await send("\x1b[5~".repeat(2));
    await send("\x13");
  } else if (name === "shell") {
    await send("printf '\\033[31mred\\033[0m and 界 é\\n'\r");
    await send("printf '\\033]8;;https://example.test\\033\\\\link\\033]8;;\\033\\\\\\n'\r");
    await send("for i in {1..30}; do printf '\\rprogress %3d%%' $((i*100/30)); sleep .04; done; printf '\\n'\r", 1600);
    await send("echo editing a long command");
    await send("\x01");
    await send("\x05");
    await send("\x7f".repeat(12));
    await send("\r");
    await send("clear\r");
    await send("printf 'done\\n'\r");
  } else if (name === "cat" || name === "cat-dense") {
    await send("cat big.txt\r", 2500);
    await send("echo done\r");
  } else {
    await send("\rw", 2000);
    await send("d", 1000);
    await send("a", 2000);
    await send("s", 2000);
    await send("w", 1000);
  }
  capture();
  const text = screen.liveText();
  if ((name === "codex" || name === "claude") && (requests === 0 || !text.includes(scenario?.expected ?? "Check item")))
    throw Error(`No streamed answer captured (${requests} requests): ${text}`);
  if (frames.length < 5) throw Error(`Too few frames: ${frames.length}`);
  const fixture = {
    name,
    cols,
    rows,
    source: commands[name].map(arg => arg.replace(dir, "<temporary home>").replace(root, "<repository>")),
    version:
      name === "codex" || name === "claude" || name === "micro"
        ? Bun.spawnSync([name, name === "micro" ? "-version" : "--version"])
            .stdout.toString()
            .trim()
        : name.startsWith("moonlander")
          ? "Corgi " + Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim()
          : Bun.spawnSync(["/bin/zsh", "--version"]).stdout.toString().trim(),
    samplingMs: 33,
    durationMs: Math.round(performance.now() - start),
    requests,
    ...(scenario ? { scenario } : {}),
    uploads: [...uploads],
    actions,
    frames,
  };
  mkdirSync(output, { recursive: true });
  const path = join(output, `${name}.json.gz`);
  await Bun.write(path, Bun.gzipSync(JSON.stringify(fixture)));
  console.log(
    JSON.stringify({ path, frames: frames.length, requests, bytes: Bun.file(path).size, final: text.slice(-400) }),
  );
} finally {
  clearInterval(interval);
  child.kill("SIGKILL");
  await child.exited;
  child.terminal?.close();
  screen.destroy();
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
}
