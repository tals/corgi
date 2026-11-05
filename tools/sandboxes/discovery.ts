/** Slow, unconfigured Pi/omp and a missing OpenCode for first-load launcher checks. */
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { table, type World } from "../sandbox";

export const world: World = {
  configure(s) {
    delete s.env.PI_CODING_AGENT_DIR;
    for (const name of ["codex", "pi", "omp", "opencode2"])
      s.env[`CORGI_${name.toUpperCase()}_BIN`] = join(
        s.home,
        "bin",
        name === "codex" || name === "opencode2" ? `missing-${name}` : name,
      );
    s.env.CORGI_CLAUDE_BIN = join(s.home, "bin/claude");
  },
  seed(s) {
    s.write(
      join(s.home, ".claude/.claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "sandbox@example.com" }, hasCompletedOnboarding: true }),
    );
    for (const provider of ["pi", "omp"]) {
      const root = join(s.home, `.${provider}/agent`),
        file = join(s.home, "bin", provider);
      s.write(join(root, "delay-ms"), provider === "pi" ? "2000" : "4000");
      s.write(
        file,
        `#!${process.execPath}\n` +
          String.raw`
import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { createInterface } from "node:readline";
const provider = basename(process.argv[1]);
const root = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME, "." + provider, "agent");
if (process.argv.includes("--version")) { console.log(provider === "pi" ? "1.20.0" : "omp/18.12.6"); process.exit(0); }
if (process.argv[2] === "auth") { console.log(JSON.stringify({ provider: "custom", status: existsSync(join(root,"ready")) ? "ready" : "missing" })); process.exit(0); }
if (!process.argv.includes("--mode")) {
  console.log(provider + " fixture ready; no credentials configured");
  await Bun.stdin.text();
  process.exit(0);
}
createInterface({ input: process.stdin }).on("line", async line => {
  const request = JSON.parse(line);
  if (request.type === "get_available_models") await Bun.sleep(Number(readFileSync(join(root, "delay-ms"), "utf8")));
  const ready = existsSync(join(root, "ready")), model = { provider: "custom", id: "local", name: "Local", input: ["text"], cost: { input: 0, output: 0 } };
  const data = request.type === "get_available_models" ? { models: ready ? [model] : [] } : { model: ready ? model : null };
  console.log(JSON.stringify({ type: "response", id: request.id, success: true, data }));
});
`,
      );
      chmodSync(file, 0o700);
    }
  },
  arrange(s) {
    const workspace = String(s.corgi(["workspace", "list"]).workspaces[0].id);
    s.corgi(["workspace", "edit", workspace, "--name", "discovery", "--cwd", s.home]);
    s.corgi(["tab", "new", "--workspace", workspace, "--cwd", s.home]);
  },
  intro(s) {
    return [
      "Claude is configured. Pi and Oh My Pi take two/four seconds to discover that no account is configured; OpenCode is missing.",
      ...table([
        [`${s.prefixName} c`, "watch Discovering… settle; only Claude should be offered"],
        ["Manage agents", "only Claude is added automatically; Add agent can add the signed-out Pi and Oh My Pi"],
        ["add Pi", "choose Pi under Add agent, then its default row; launch it or reload to verify your choice stays"],
        ["shell", "touch ~/.pi/agent/ready to make Pi available, then reload the sandbox"],
        ["remove Pi", "reopen or reload: a manual removal must stay removed"],
      ]),
    ];
  },
};
