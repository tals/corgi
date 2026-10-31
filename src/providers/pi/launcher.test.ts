import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "./launcher";
import { Option } from "../../launch/preview";
import { Quit } from "../../subprocess";

let root: string, account: string, executable: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "corgi-pi-launcher-"));
  account = join(root, "account");
  mkdirSync(account);
  executable = process.env.CORGI_PI_BIN;
  process.env.CORGI_PI_BIN = join(root, "pi");
  writeFileSync(
    process.env.CORGI_PI_BIN,
    `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const root = process.env.PI_CODING_AGENT_DIR;
appendFileSync(join(root, "starts"), process.cwd() + "\\n");
const settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
writeFileSync(join(root, "probe.json"), JSON.stringify({
  cwd: process.cwd(), args: process.argv.slice(2), pane: process.env.CORGI_PANE, socket: process.env.CORGI_SOCKET
}));
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (settings.hang) return;
  const respond = () => {
    console.log(JSON.stringify({ type: "response", id: "other", success: true }));
    console.log(JSON.stringify({ type: "response", id: request.id, command: request.type,
      success: !settings.reject,
      data: { model: settings.model ?? { provider: settings.defaultProvider, id: settings.defaultModel, name: settings.name } }
    }));
  };
  if (settings.delay) setTimeout(respond, settings.delay);
  else respond();
});
`,
    { mode: 0o755 },
  );
});
afterEach(() => {
  setSystemTime();
  if (executable === undefined) delete process.env.CORGI_PI_BIN;
  else process.env.CORGI_PI_BIN = executable;
  rmSync(root, { recursive: true, force: true });
});
function settings(value: object) {
  writeFileSync(join(account, "settings.json"), JSON.stringify(value));
}
const starts = () =>
  existsSync(join(account, "starts")) ? readFileSync(join(account, "starts"), "utf8").trim().split("\n").length : 0;

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
    // Asked outside any project, for the agent folder's own model.
    expect(probe.cwd).toBe(realpathSync(tmpdir()));
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

test("Pi falls back to formatting when its model has no display name", async () => {
  settings({ defaultProvider: "openai-codex", defaultModel: "gpt-6-luna" });
  const launcher = open(account);
  try {
    const chosen = await launcher.model(root, new Quit()),
      option = new Option();
    option.setModel(chosen.model, chosen.source, chosen.model_name);
    expect(option.modelLabel()).toBe("GPT-6 Luna");
  } finally {
    launcher.close();
  }
});

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

test("Pi is asked once until what decides its model changes, or a refresh", async () => {
  settings({ defaultProvider: "custom", defaultModel: "first" });
  const other = join(root, "other");
  mkdirSync(other);
  const launcher = open(account);
  try {
    expect((await launcher.model(root, new Quit())).model).toBe("custom/first");
    expect((await launcher.model(root, new Quit())).model).toBe("custom/first");
    // Folders without settings of their own share its answer.
    await launcher.model(other, new Quit());
    expect(starts()).toBe(1);
    settings({ defaultProvider: "custom", defaultModel: "second-choice" });
    expect((await launcher.model(root, new Quit())).model).toBe("custom/second-choice");
    expect(starts()).toBe(2);
    // However old it gets.
    setSystemTime(new Date(Date.now() + 24 * 3600 * 1000));
    await launcher.model(other, new Quit());
    expect(starts()).toBe(2);
    launcher.refresh!();
    await launcher.model(root, new Quit());
    await launcher.model(other, new Quit());
    expect(starts()).toBe(3);
    // A folder that sets its own model is asked there, once.
    mkdirSync(join(other, ".pi"));
    writeFileSync(join(other, ".pi", "settings.json"), JSON.stringify({ defaultModel: "local" }));
    await launcher.model(other, new Quit());
    await launcher.model(other, new Quit());
    await launcher.model(root, new Quit());
    expect(starts()).toBe(4);
    expect(JSON.parse(readFileSync(join(account, "probe.json"), "utf8")).cwd).toBe(realpathSync(other));
  } finally {
    launcher.close();
  }
});

test("a failed lookup stands until a refresh, and one cut short isn't kept", async () => {
  settings({ defaultProvider: "custom", defaultModel: "saved", reject: true });
  const launcher = open(account);
  try {
    expect((await launcher.model(root, new Quit())).source).toBe("Pi user settings");
    setSystemTime(new Date(Date.now() + 24 * 3600 * 1000));
    await launcher.model(root, new Quit());
    expect(starts()).toBe(1);
    launcher.refresh!();
    await launcher.model(root, new Quit());
    expect(starts()).toBe(2);
  } finally {
    launcher.close();
  }
  settings({ defaultProvider: "custom", defaultModel: "saved", hang: true });
  const next = open(account),
    quit = new Quit(),
    timer = setTimeout(() => quit.signal(), 50);
  try {
    await next.model(root, quit);
    clearTimeout(timer);
    settings({ defaultProvider: "custom", defaultModel: "saved" });
    expect((await next.model(root, new Quit())).source).toBe("Effective Pi settings");
  } finally {
    clearTimeout(timer);
    next.close();
  }
});

test("a lookup that a refresh overtakes isn't kept", async () => {
  settings({ defaultProvider: "custom", defaultModel: "saved", delay: 300 });
  const launcher = open(account);
  try {
    const asking = launcher.model(root, new Quit());
    for (let i = 0; i < 200 && starts() === 0; i++) await new Promise(r => setTimeout(r, 10));
    launcher.refresh!();
    expect((await asking).model).toBe("custom/saved");
    await launcher.model(root, new Quit());
    await launcher.model(root, new Quit());
    expect(starts()).toBe(2);
  } finally {
    launcher.close();
  }
});
