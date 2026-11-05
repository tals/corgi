import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as settings from "./settings_command";
import type { Connection } from "./rpc";

/** A runtime that answers `session.list` and records what else it's sent. */
function runtime(snapshot: Record<string, unknown> = {}) {
  const sent: [string, unknown][] = [];
  let closed = 0;
  const conn = {
    async call(op: string, payload: unknown) {
      if (op === "session.list")
        return {
          ok: true,
          result: {
            inference: { choice: "auto", provider: "claude", uses: { activity: true, worktrees: false } },
            shell: { setting: "", path: "/bin/zsh", source: "fallback", default: "/bin/zsh" },
            smart_links: true,
            ...snapshot,
          },
        };
      sent.push([op, payload]);
      if (op === "inference.configure") return { ok: true, saved: true, inference: {} };
      return { ok: true };
    },
    close() {
      closed++;
    },
  } as unknown as Connection;
  return { connect: () => conn, sent, closed: () => closed };
}
function folder(): { file: string; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), "corgi-settings-"));
  return { file: join(root, "viewer.json"), done: () => rmSync(root, { recursive: true, force: true }) };
}
const offline = () => {
  throw Error("NotConnected");
};

test("set takes one setting and a value; only Clever Corgi takes a model", () => {
  expect(settings.parse([])).toEqual({ json: false, change: null });
  expect(settings.parse(["--json"])).toEqual({ json: true, change: null });
  expect(settings.parse(["set", "language", "ja"]).change).toEqual({
    name: "language",
    value: "ja",
    model: null,
    account: null,
  });
  expect(settings.parse(["set", "clever-corgi", "claude", "--model", "m", "--account", "work"]).change).toMatchObject({
    model: "m",
    account: "work",
  });
  expect(() => settings.parse(["set", "colour", "red"])).toThrow("UnknownSetting");
  for (const args of [
    ["set", "language"],
    ["set", "language", "ja", "extra"],
    ["get", "language"],
    ["set", "language", "ja", "--model", "m"],
    ["set", "clever-corgi", "auto", "--model", "m"],
    ["set", "clever-corgi", "claude", "--model"],
    ["--yolo"],
  ])
    expect(() => settings.parse(args)).toThrow("Usage");
});

test("viewer settings parse to what viewer.json saves", () => {
  const change = (name: settings.Name, value: string) =>
    settings.viewerChange({ name, value, model: null, account: null });
  expect(change("language", "ja")).toEqual({ language: "ja" });
  expect(change("language", "auto")).toEqual({ language: undefined });
  expect(change("theme", "animal_style")).toEqual({ theme: "animal_style" });
  expect(change("prefix", "ctrl+a")).toEqual({ prefix: "ctrl_a" });
  expect(change("flourishes", "0")).toEqual({ corgi_intensity: 0 });
  expect(change("resources", "off")).toEqual({ resources: { enabled: false } });
  expect(change("worktree-folder", "$HOME/wt/$NAME")).toEqual({ worktree_folder: "$HOME/wt/$NAME" });
  expect(change("worktree-folder", "default")).toEqual({ worktree_folder: "$PROJECT_ROOT/.worktrees/$NAME" });
  expect(change("shell", "fish")).toBeNull();
  for (const [name, value] of [
    ["language", "japanese"],
    ["theme", "dark"],
    ["keymap", "cmux"],
    ["prefix", "ctrl+c"],
    ["flourishes", "101"],
    ["flourishes", "-1"],
    ["resources", "yes"],
    ["worktree-folder", "$HOME/wt"],
  ] as [settings.Name, string][])
    expect(() => change(name, value)).toThrow("BadValue");
});

test("a viewer setting saves to viewer.json without the runtime, keeping the rest of the file", async () => {
  const { file, done } = folder();
  try {
    writeFileSync(file, JSON.stringify({ onboarding_complete: true, sidebar_width: 40, theme: "corgi" }));
    expect(await settings.run(offline, ["set", "language", "ja"], file)).toBe("language ja\n");
    expect(await settings.run(offline, ["set", "theme", "auto", "--json"], file)).toBe(
      JSON.stringify({
        ok: true,
        setting: {
          name: "theme",
          applies: "viewers",
          value: "auto",
          choices: ["auto", "corgi", "animal_style"],
          hint: "",
        },
        saved: true,
      }) + "\n",
    );
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved).toMatchObject({ onboarding_complete: true, sidebar_width: 40, language: "ja" });
    expect("theme" in saved).toBe(false);
  } finally {
    done();
  }
});

test("runtime settings go to the daemon the way setup sends them", async () => {
  const { file, done } = folder(),
    r = runtime();
  try {
    expect(await settings.run(r.connect, ["set", "shell", "default"], file)).toBe("shell default\n");
    await settings.run(r.connect, ["set", "smart-links", "off"], file);
    await settings.run(r.connect, ["set", "worktree-briefs", "on"], file);
    await settings.run(r.connect, ["set", "clever-corgi", "codex", "--model", "gpt-5-mini"], file);
    expect(r.sent).toEqual([
      ["shell.configure", { shell: "" }],
      ["smart_links.configure", { enabled: false }],
      ["inference.configure", { worktrees: true }],
      ["inference.configure", { choice: "codex", model: "gpt-5-mini", account: null }],
    ]);
    expect(r.closed()).toBe(4);
    await expect(settings.run(r.connect, ["set", "clever-corgi", "gemini"], file)).rejects.toThrow("BadValue");
  } finally {
    done();
  }
});

test("the list gives each setting's value and what it takes", async () => {
  const { file, done } = folder();
  try {
    writeFileSync(file, JSON.stringify({ language: "ja", prefix: "ctrl_a", corgi_intensity: 20 }));
    const shown = await settings.run(runtime().connect, [], file);
    expect(shown.split("\n").slice(0, 3)).toEqual([
      "Viewers on this machine:",
      "  language            ja                              auto, en, zh, ja, ko, ru",
      "  theme               auto                            auto, corgi, animal_style",
    ]);
    expect(shown).toContain("  prefix              ctrl+a ");
    expect(shown).toContain("  flourishes          20                              0-100");
    expect(shown).toContain("Runtime, for every viewer:");
    expect(shown).toContain("  shell               default                         default or a shell's name or path;");
    expect(shown).toContain("  clever-corgi        auto (following claude)");
    expect(shown).toContain("  worktree-briefs     off ");
    const listed = JSON.parse(
      await settings.run(
        runtime({
          inference: {
            choice: "claude",
            selection: { provider: "claude", model: "claude-haiku-4-5", account: "" },
            available: [{ provider: "claude", model: "claude-haiku-4-5", account: "", name: "Haiku 4.5" }],
          },
        }).connect,
        ["--json"],
        file,
      ),
    );
    expect(listed.settings.map((s: settings.Row) => s.name)).toEqual(settings.names);
    expect(listed.settings.find((s: settings.Row) => s.name === "clever-corgi").value).toBe(
      "claude --model claude-haiku-4-5",
    );
    expect(listed.models).toEqual([{ provider: "claude", model: "claude-haiku-4-5", account: "", name: "Haiku 4.5" }]);
  } finally {
    done();
  }
});
