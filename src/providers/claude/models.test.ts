import { expect, spyOn, test } from "bun:test";
import * as commandLine from "../command_line";
import { Client } from "./account";
import { read } from "./models";
import { Quit } from "../../subprocess";
import { Info } from "../../usage/account";
import { Stdio } from "../stdio";
import { Claude, summaryArgs } from "./headless";

test("Claude lists the complete read-only initialization catalog for the selected account", async () => {
  const quit = new Quit(),
    models = spyOn(Client.prototype, "models").mockImplementation(async function (this: Client, stopping) {
      expect(stopping).toBe(quit);
      expect(this.env.CLAUDE_CONFIG_DIR).toBe("/claude/nvidia");
      return {
        info: Object.assign(new Info(), { signed_in: true, limits: "metered" }),
        models: [
          { value: "default", resolvedModel: "claude-opus-5-5[1m]" },
          { value: "opus", displayName: "Opus", resolvedModel: "claude-opus-5-5" },
          { value: "haiku", displayName: "Haiku 5.5", resolvedModel: "claude-haiku-5-5" },
        ],
      };
    }),
    close = spyOn(Client.prototype, "close");
  try {
    const result = await read("/claude/nvidia", quit);
    expect(result.map(m => m.id)).toEqual(["claude-opus-5-5[1m]", "claude-opus-5-5", "claude-haiku-5-5"]);
    expect(result.every(m => !m.subscription)).toBe(true);
    expect(close).toHaveBeenCalled();
  } finally {
    models.mockRestore();
    close.mockRestore();
  }
});

test("malformed Claude catalogs don't replace a cached model list", async () => {
  const models = spyOn(Client.prototype, "models").mockResolvedValue({ info: new Info(), models: null }),
    close = spyOn(Client.prototype, "close");
  try {
    await expect(read("", new Quit())).rejects.toThrow("InvalidModels");
    expect(close).toHaveBeenCalled();
  } finally {
    models.mockRestore();
    close.mockRestore();
  }
});

test("Claude inference starts with the same account directory used for its catalog", () => {
  const spawn = spyOn(Stdio, "spawn").mockImplementation(() => new Stdio());
  try {
    const args = summaryArgs({ instructions: "Summarize", model: "claude-haiku-5-5", schema: null }),
      client = Claude.start({ account: "/claude/nvidia", cwd: "/tmp", executable: "claude" }, args, { schema: false });
    expect(spawn.mock.calls[0][1]?.env?.CLAUDE_CONFIG_DIR).toBe("/claude/nvidia");
    expect(spawn.mock.calls[0][0]).toContain("claude-haiku-5-5");
    client.close();
  } finally {
    spawn.mockRestore();
  }
});

test("Claude catalogs label the saved native default effort only for supported models", async () => {
  const info = new Info();
  info.signed_in = true;
  const models = spyOn(Client.prototype, "models").mockResolvedValue({
      info,
      models: [
        { value: "opus", resolvedModel: "claude-opus", supportedEffortLevels: ["low", "high"] },
        { value: "haiku", resolvedModel: "claude-haiku" },
      ],
    }),
    settings = spyOn(commandLine, "cached").mockImplementation((root, name) => {
      expect(root).toBe("/claude/effort");
      expect(name).toBe("settings.json");
      return { effortLevel: "high" };
    });
  try {
    const values = await read("/claude/effort", new Quit());
    expect(values[0].default_effort).toBe("high");
    expect(values[1].default_effort).toBeUndefined();
  } finally {
    models.mockRestore();
    settings.mockRestore();
  }
});
