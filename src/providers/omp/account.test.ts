import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Client } from "./account";
import * as models from "./models";
import { Client as Pi } from "../pi/account";
import * as piModels from "../pi/models";
import { Quit } from "../../subprocess";
import { Menu } from "../../agent_launcher";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "corgi-omp-account-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test.each(["pi", "omp"] as const)("unconfigured %s stays out of the launcher", async provider => {
  const available = spyOn(provider === "pi" ? piModels : models, "read").mockResolvedValue([]),
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
  const available = spyOn(provider === "pi" ? piModels : models, "read").mockResolvedValue([
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
    expect((await client.preview(new Quit())).signed_in).toBe(false);
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
    available = spyOn(provider === "pi" ? piModels : models, "read").mockImplementation(
      (_account, quit) =>
        new Promise((_resolve, reject) => {
          quit.abortSignal.addEventListener("abort", () => reject(Error("Cancelled")), { once: true });
        }),
    ),
    quit = new Quit();
  try {
    const pending = client.preview(quit);
    expect(available).toHaveBeenCalled();
    client.close();
    expect((await pending).signed_in).toBe(false);
    expect(quit.aborted).toBe(false);
  } finally {
    available.mockRestore();
    client.close();
  }
});
