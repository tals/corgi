import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accounts as piAccounts, credential, identity, signin } from "./accounts";
import { extension } from "./integration";
import { open as history } from "./history";
import { open as launcher } from "./launcher";
import { adapter } from "./index";
import { Store } from "../../launch/history";
import { ResumeHint } from "../../resume_hint";
import { Text } from "../../providers";
import { Quit } from "../../subprocess";
import { Signin } from "../../signin";

test("Pi account credentials select their own auth check and remove only their local login", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-pi-accounts-")),
    executable = process.env.CORGI_PI_BIN;
  process.env.CORGI_PI_BIN = join(root, "missing-pi");
  try {
    const a = join(root, "a"),
      b = join(root, "b");
    mkdirSync(a);
    mkdirSync(b);
    const token = (sub: string, workspace: string) =>
      "header." +
      Buffer.from(
        JSON.stringify({
          sub,
          email: "user@example.com",
          "https://api.openai.com/auth": { chatgpt_account_id: workspace },
        }),
      ).toString("base64url") +
      ".signature";
    for (const [dir, workspace] of [
      [a, "personal"],
      [b, "team"],
    ]) {
      writeFileSync(
        join(dir, "auth.json"),
        JSON.stringify({
          "openai-codex": { type: "oauth", access: token("user", workspace), refresh: "test-refresh" },
        }),
      );
      writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({ defaultProvider: "openai-codex", defaultModel: workspace }),
      );
    }
    expect(identity(a)?.email).toBe("user@example.com");
    expect(identity(a)?.id).not.toBe(identity(b)?.id);
    const view = new Signin(false, false, { changed() {}, done() {} } as any);
    view.provider = "pi";
    view.dir = a;
    expect(view.check).toEqual(["auth", "check", "--provider", "openai-codex"]);
    expect(signin.ready(a)).toBe(true);
    expect((await launcher(a).model(root, new Quit())).model).toBe("openai-codex/personal");
    expect((await launcher(b).model(root, new Quit())).model).toBe("openai-codex/team");
    await view.signOut();
    expect(existsSync(join(a, "auth.json"))).toBe(false);
    expect(identity(b)).not.toBeNull();
    writeFileSync(join(a, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "test-key" } }));
    expect(credential(a)?.provider).toBe("anthropic");
    expect(view.check).toEqual(["auth", "check", "--provider", "anthropic"]);
    expect(identity(a)?.id).not.toContain("test-key");
  } finally {
    if (executable === undefined) delete process.env.CORGI_PI_BIN;
    else process.env.CORGI_PI_BIN = executable;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi account hooks, exact resume files and history stay in their own directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-pi-account-history-")),
    old = process.env.PI_CODING_AGENT_SESSION_DIR,
    oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "default");
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  try {
    const dirs = [join(root, "a"), join(root, "b")],
      store = new Store();
    for (const [i, account] of dirs.entries()) {
      expect(extension("install", account).outcome).toBe("added");
      const transcript = join(root, `outside-${i}.jsonl`),
        session = `account-${i}`;
      writeFileSync(
        transcript,
        [
          { type: "session", id: session, cwd: root },
          { type: "message", message: { role: "user", content: "saved" } },
        ]
          .map(v => JSON.stringify(v))
          .join("\n") + "\n",
      );
      adapter.hook({ event: "SessionStart", session, transcript, cwd: root, account });
      const hint = new ResumeHint();
      hint.provider = "pi";
      hint.session = new Text(session);
      expect(hint.args(account)).toEqual(["--session", transcript]);
      expect(hint.args(dirs[1 - i])).toEqual(["--session", session]);
      const h = history(account);
      expect((await h.list(() => false)).sessions.map(e => [e.account, e.session])).toEqual([[account, session]]);
      await h.changed([], store, () => false);
      h.close();
    }
    expect(store.items.size).toBe(2);
    rmSync(join(root, "outside-0.jsonl"));
    await history(dirs[0]).changed([], store, () => false);
    expect([...store.items.values()].map(i => i.entry.account)).toEqual([dirs[1]]);
    expect(extension("uninstall", dirs[0]).outcome).toBe("removed");
    expect(readFileSync(join(dirs[1], "extensions/corgi.js"), "utf8")).toContain("Corgi's Pi integration");
  } finally {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (old === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = old;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi account integration does not modify a shared extension directory", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-pi-shared-extension-"));
  try {
    const a = join(root, "a"),
      b = join(root, "b");
    expect(piAccounts.shared.dirs).not.toContain("extensions");
    expect(piAccounts.shared.files).not.toContain("settings.json");
    expect(extension("install", a).outcome).toBe("added");
    mkdirSync(b);
    symlinkSync(join(a, "extensions"), join(b, "extensions"));
    expect(extension("status", b).outcome).toBe("present");
    expect(extension("uninstall", b)).toMatchObject({ outcome: "failed", error: "SharedExtensionsDirectory" });
    expect(extension("status", a).outcome).toBe("present");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["environment", "settings"])(
  "Pi shared %s session roots retain the observed account across refreshes",
  async mode => {
    const root = mkdtempSync(join(tmpdir(), "corgi-pi-shared-history-")),
      saved = { ...process.env },
      home = join(root, "default"),
      a = join(root, "a"),
      b = join(root, "b"),
      shared = join(root, "sessions");
    process.env.PI_CODING_AGENT_DIR = home;
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    try {
      for (const dir of [home, a, b, shared]) mkdirSync(dir);
      if (mode === "environment") process.env.PI_CODING_AGENT_SESSION_DIR = shared;
      else {
        writeFileSync(join(home, "settings.json"), JSON.stringify({ sessionDir: shared }));
        for (const dir of [a, b]) symlinkSync(join(home, "settings.json"), join(dir, "settings.json"));
      }
      const readers = [history(), history(a), history(b)];
      for (const [i, account] of [a, b].entries()) {
        const session = `shared-${i}`,
          transcript = join(shared, `${session}.jsonl`);
        writeFileSync(
          transcript,
          [
            { type: "session", id: session, cwd: root },
            { type: "message", message: { role: "user", content: "saved" } },
          ]
            .map(v => JSON.stringify(v))
            .join("\n") + "\n",
        );
        adapter.hook({ event: "SessionStart", session, transcript, cwd: root, account });
      }
      const list = async () =>
        Promise.all(
          readers.map(async h => (await h.list(() => false)).sessions.map(e => [e.account, e.session]).sort()),
        );
      expect(await list()).toEqual([[], [[a, "shared-0"]], [[b, "shared-1"]]]);
      // Resuming the same transcript with another account updates cached readers too.
      adapter.hook({
        event: "SessionStart",
        session: "shared-0",
        transcript: join(shared, "shared-0.jsonl"),
        cwd: root,
        account: b,
      });
      expect(await list()).toEqual([
        [],
        [],
        [
          [b, "shared-0"],
          [b, "shared-1"],
        ],
      ]);
      expect(adapter.launch.resume("shared-0", a)).toEqual(["--session", "shared-0"]);
      expect(adapter.launch.resume("shared-0", b)).toEqual(["--session", join(shared, "shared-0.jsonl")]);
      for (const h of readers) h.close();
    } finally {
      for (const key of ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"])
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      rmSync(root, { recursive: true, force: true });
    }
  },
);
