import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Client } from "./account";
import * as models from "./models";
import { Client as Pi } from "../pi/account";
import * as piModels from "../pi/models";
import { Quit } from "../../subprocess";
import { Menu, preview } from "../../agent_launcher";
import { byProvider } from "../../providers";
import * as discovery from "../../discovery";
import * as subprocess from "../../subprocess";
import { Stdio } from "../stdio";
import * as piLauncher from "../pi/launcher";
import * as ompLauncher from "./launcher";
import type { InferenceModel } from "../adapter";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "corgi-omp-account-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function mockModels(provider: "pi" | "omp", values: InferenceModel[]) {
  return provider === "pi"
    ? spyOn(piModels, "availability").mockResolvedValue({ models: values, unverified: new Set() })
    : spyOn(models, "read").mockResolvedValue(values);
}

test.each(["pi", "omp"] as const)(
  "%s account discovery uses workspace installs while probing in isolation",
  async provider => {
    const cwd = join(root, "workspace"),
      executable = join(root, "mise-install", provider),
      launcher = (provider === "pi" ? piLauncher : ompLauncher).open(root),
      io = new Stdio(),
      resolve = spyOn(discovery, "resolve").mockImplementation(async (_provider, directory) => {
        if (directory !== cwd) throw Error("ProviderNotFound");
        return executable;
      }),
      spawn = spyOn(Stdio, "spawn").mockReturnValue(io),
      read = spyOn(io, "read").mockReturnValue([
        {
          type: "response",
          id: "corgi-models",
          success: true,
          data: { models: [{ provider: "custom", id: "local", input: ["text"] }] },
        },
      ]),
      auth = spyOn(subprocess, "run").mockResolvedValue(
        new subprocess.Output({ exited: 0 }, Buffer.from('{"provider":"custom","status":"ready"}'), Buffer.alloc(0)),
      );
    try {
      const info = await launcher.account(new Quit(), 60, cwd);
      expect(info.signed_in).toBe(true);
      expect(info.account.text()).toBe("custom");
      expect(resolve).toHaveBeenCalledWith(provider, cwd);
      expect(spawn.mock.calls[0]?.[0][0]).toBe(executable);
      expect(spawn.mock.calls[0]?.[1].cwd).toBe("/tmp");
      if (provider === "pi") {
        expect(auth.mock.calls[0]?.[0][0]).toBe(executable);
        expect(auth.mock.calls[0]?.[1].cwd).toBe("/tmp");
      }
    } finally {
      launcher.close();
      io.close();
      resolve.mockRestore();
      spawn.mockRestore();
      read.mockRestore();
      auth.mockRestore();
    }
  },
);

test.each([
  ["pi", "environment"],
  ["omp", "environment"],
  ["pi", "stored"],
  ["omp", "stored"],
] as const)("%s follows the workspace model provider with %s credentials", async (provider, kind) => {
  const stored = kind === "stored",
    cwd = join(root, "workspace"),
    project = join(cwd, "." + provider),
    launcher = (provider === "pi" ? piLauncher : ompLauncher).open(root);
  mkdirSync(project, { recursive: true });
  if (provider === "pi") {
    writeFileSync(join(root, "settings.json"), '{"defaultProvider":"user","defaultModel":"model"}');
    writeFileSync(join(project, "settings.json"), '{"defaultProvider":"project"}');
    if (stored)
      writeFileSync(
        join(root, "auth.json"),
        JSON.stringify({
          user: { type: "api_key", key: "test-user" },
          project: { type: "api_key", key: "test-project", email: "project@example.com" },
        }),
      );
  } else {
    writeFileSync(join(root, "config.yml"), "modelRoles:\n  default: user/model\n");
    writeFileSync(join(project, "config.yml"), "modelRoles:\n  default: project/model\n");
    if (stored) {
      const db = new Database(join(root, "agent.db"));
      db.run(
        "CREATE TABLE auth_credentials (id INTEGER, provider TEXT, credential_type TEXT, data TEXT, identity_key TEXT, disabled_cause TEXT)",
      );
      for (const [id, provider] of ["user", "project"].entries())
        db.run("INSERT INTO auth_credentials VALUES (?, ?, 'api_key', ?, '', NULL)", [
          id,
          provider,
          JSON.stringify({ key: "test-" + provider, email: provider + "@example.com" }),
        ]);
      db.close();
    }
  }
  const io = new Stdio(),
    resolve = spyOn(discovery, "resolve").mockResolvedValue("/test/" + provider),
    spawn = spyOn(Stdio, "spawn").mockReturnValue(io),
    read = spyOn(io, "read").mockReturnValue([
      {
        type: "response",
        id: "corgi-models",
        success: true,
        data: { models: [{ provider: "project", id: "model", input: ["text"] }] },
      },
    ]),
    auth = spyOn(subprocess, "run").mockResolvedValue(
      new subprocess.Output({ exited: 0 }, Buffer.from('{"provider":"project","status":"ready"}'), Buffer.alloc(0)),
    );
  try {
    const info = await launcher.account(new Quit(), 60, cwd);
    expect(info.signed_in).toBe(true);
    expect(info.account.text()).toBe(stored ? "project@example.com" : "project");
    expect(info.plan.text()).not.toBe("OAuth");
    expect(resolve).toHaveBeenCalledWith(provider, cwd);
  } finally {
    launcher.close();
    io.close();
    resolve.mockRestore();
    spawn.mockRestore();
    read.mockRestore();
    auth.mockRestore();
  }
});

test.each(["pi", "omp"] as const)("unconfigured %s stays out of the launcher", async provider => {
  const available = mockModels(provider, []),
    client = provider === "pi" ? new Pi(root) : new Client(root);
  try {
    const info = await client.preview(new Quit()),
      menu = new Menu();
    expect(info.signed_in).toBe(false);
    expect(info.account.text()).toBe("");
    menu.preview.options[provider].signed_in = info.signed_in;
    expect(menu.shown(provider)).toBe(false);
    expect(menu.manageModel().agents.find(a => a.provider === provider)?.who).toBe("Not signed in");
  } finally {
    available.mockRestore();
    client.close();
  }
});

test.each(["pi", "omp"] as const)("%s keeps native environment keys and custom endpoints available", async provider => {
  const available = mockModels(provider, [
      { id: "custom/local", name: "Local", subscription: false, input_cost: null, output_cost: null },
    ]),
    client = provider === "pi" ? new Pi(root) : new Client(root);
  try {
    const info = await client.preview(new Quit());
    expect(info.signed_in).toBe(true);
    expect(info.account.text()).toBe("custom");
    expect(info.limits).toBe("none");
    // Availability for another provider cannot authenticate the selected one.
    writeFileSync(
      join(root, provider === "pi" ? "settings.json" : "config.yml"),
      provider === "pi" ? '{"defaultProvider":"other"}' : "modelRoles:\n  default: other/model\n",
    );
    expect((await client.preview(new Quit())).signed_in).toBe(false);
    available.mockRejectedValue(Error("ModelsUnavailable"));
    const failed = await client.preview(new Quit()),
      menu = new Menu();
    expect(failed.signed_in).toBeNull();
    menu.preview = preview({
      pending: false,
      installed: byProvider(p => p === "codex" || p === provider),
      configured: byProvider(p => p === "codex" || p === provider),
      options: byProvider(() => ({ pending: false, signed_in: null })),
    });
    menu.preview.options[provider].signed_in = failed.signed_in;
    expect(menu.shown(provider)).toBe(true);
  } finally {
    available.mockRestore();
    client.close();
  }
});

test("omp API credentials establish sign-in without a quota request", async () => {
  const db = new Database(join(root, "agent.db"));
  db.run(
    "CREATE TABLE auth_credentials (id INTEGER, provider TEXT, credential_type TEXT, data TEXT, identity_key TEXT, disabled_cause TEXT)",
  );
  db.run("INSERT INTO auth_credentials VALUES (1, 'custom', 'api_key', ?, '', NULL)", [
    JSON.stringify({ key: "secret" }),
  ]);
  db.close();
  const client = new Client(root),
    available = spyOn(models, "read").mockResolvedValue([]);
  try {
    const info = await client.preview(new Quit());
    expect(info.signed_in).toBe(true);
    expect(info.account.text()).toBe("custom API key");
    expect(info.plan.text()).toBe("API key");
    expect(available).not.toHaveBeenCalled();
  } finally {
    available.mockRestore();
    client.close();
  }
});

test.each(["pi", "omp"] as const)("closing %s cancels its native availability read", async provider => {
  const client = provider === "pi" ? new Pi(root) : new Client(root),
    available = mockModels(provider, []).mockImplementation(
      (_account, quit) =>
        new Promise<never>((_resolve, reject) => {
          quit.abortSignal.addEventListener("abort", () => reject(Error("Cancelled")), { once: true });
        }),
    ),
    quit = new Quit();
  try {
    const pending = client.preview(quit);
    expect(available).toHaveBeenCalled();
    client.close();
    expect((await pending).signed_in).toBeNull();
    expect(quit.aborted).toBe(false);
  } finally {
    available.mockRestore();
    client.close();
  }
});
