import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "./launcher";
import { Option } from "../../launch/preview";
import { Quit } from "../../subprocess";
import { scopedEnv } from "../../fixtures/env";

let root: string, account: string, env: Disposable;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "corgi-pi-launcher-"));
  account = join(root, "account");
  mkdirSync(account);
  env = scopedEnv({ CORGI_PI_BIN: join(root, "pi") });
  writeFileSync(
    join(root, "pi"),
    `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const root = process.env.PI_CODING_AGENT_DIR;
const settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
writeFileSync(join(root, "probe.json"), JSON.stringify({
  cwd: process.cwd(), args: process.argv.slice(2), pane: process.env.CORGI_PANE, socket: process.env.CORGI_SOCKET
}));
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (settings.hang) return;
  console.log(JSON.stringify({ type: "response", id: "other", success: true }));
  console.log(JSON.stringify({ type: "response", id: request.id, command: request.type,
    success: !settings.reject,
    data: { model: settings.model ?? { provider: settings.defaultProvider, id: settings.defaultModel, name: settings.name } }
  }));
});
`,
    { mode: 0o755 },
  );
});
afterEach(() => {
  env[Symbol.dispose]();
  rmSync(root, { recursive: true, force: true });
});
function settings(value: object) {
  writeFileSync(join(account, "settings.json"), JSON.stringify(value));
}

test("Pi supplies its model name without losing the provider-qualified launch id", async () => {
  settings({ defaultProvider: "custom", defaultModel: "private/model-v2", name: "Team coding model" });
  const launcher = open(account);
  try {
    const chosen = await launcher.model(root, new Quit());
    expect(chosen).toEqual({
      model: "custom/private/model-v2",
      model_name: "Team coding model",
      source: "Effective Pi settings",
    });
    const probe = JSON.parse(readFileSync(join(account, "probe.json"), "utf8"));
    expect(probe.cwd).toBe(realpathSync(root));
    expect(probe.pane).toBeUndefined();
    expect(probe.socket).toBeUndefined();
    for (const flag of ["--no-session", "--no-extensions", "--no-tools", "--no-mcp", "--offline"])
      expect(probe.args).toContain(flag);
    expect(probe.args).not.toContain("--approve");
    expect(probe.args).not.toContain("--no-approve");
  } finally {
    launcher.close();
  }
});

test("Pi's effective model takes precedence over the settings preview", async () => {
  settings({
    defaultProvider: "openai-codex",
    defaultModel: "old",
    model: { provider: "custom", id: "selected", name: "Selected model" },
  });
  const launcher = open(account);
  try {
    expect(await launcher.model(root, new Quit())).toMatchObject({
      model: "custom/selected",
      model_name: "Selected model",
    });
  } finally {
    launcher.close();
  }
});

test.each([{ reject: true }, { model: {} }, { model: { id: "missing-provider" } }])(
  "Pi falls back to settings when its model response is unavailable: %j",
  async response => {
    settings({ defaultProvider: "openai-codex", defaultModel: "gpt-6-luna", ...response });
    const launcher = open(account);
    try {
      const chosen = await launcher.model(root, new Quit()),
        option = new Option();
      expect(chosen.model).toBe("openai-codex/gpt-6-luna");
      option.setModel(chosen.model, chosen.source, chosen.model_name);
      expect(option.modelLabel()).toBe("GPT-6 Luna");
    } finally {
      launcher.close();
    }
  },
);

test.each(["cancel", "close"])("Pi's model probe stops on %s", async mode => {
  settings({ defaultProvider: "custom", defaultModel: "saved", hang: true });
  const launcher = open(account),
    quit = new Quit(),
    timer = setTimeout(() => (mode === "cancel" ? quit.signal() : launcher.close()), 50);
  try {
    expect((await launcher.model(root, quit)).model).toBe("custom/saved");
  } finally {
    clearTimeout(timer);
    launcher.close();
  }
});
