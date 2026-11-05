import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Quit } from "../subprocess";
import * as discovery from "../discovery";
import * as codex from "./codex/launcher";
import * as claude from "./claude/launcher";
import * as opencode from "./opencode2/launcher";
import { API } from "./opencode2/api";

async function isolated(run: (root: string) => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "corgi-workspace-launcher-"))),
    keys = [
      "PATH",
      "HOME",
      "XDG_STATE_HOME",
      "XDG_DATA_HOME",
      "MISE_DATA_DIR",
      "MISE_CONFIG_DIR",
      "MISE_SHIMS_DIR",
      "CORGI_TEST_SYSTEM_ROOT",
      "CORGI_CODEX_BIN",
      "CORGI_CLAUDE_BIN",
      "CODEX_HOME",
      "CLAUDE_CONFIG_DIR",
      "ANTHROPIC_MODEL",
    ],
    saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.HOME = root;
    process.env.XDG_STATE_HOME = join(root, "state");
    process.env.CORGI_TEST_SYSTEM_ROOT = join(root, "system");
    process.env.MISE_SHIMS_DIR = join(root, "shims");
    process.env.PATH = join(root, "bin") + ":" + process.env.MISE_SHIMS_DIR;
    for (const name of ["bin", "shims", "first", "second", "shared"]) mkdirSync(join(root, name));
    await run(root);
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  }
}

test.each(["codex", "claude"] as const)(
  "%s launcher uses each workspace's mise installation without executing its shim",
  async provider => {
    await isolated(async root => {
      const calls = join(root, "calls"),
        shim = join(root, "shim-called"),
        launcher = provider === "codex" ? codex.open("") : claude.open(""),
        quit = new Quit();
      writeFileSync(join(root, "shims", provider), `#!/bin/sh\n: > '${shim}'\nexit 1\n`, { mode: 0o755 });
      writeFileSync(
        join(root, "bin", "mise"),
        `#!/bin/sh
[ "$1:$2" = 'which:${provider}' ] || exit 1
case "$PWD" in '${root}/first'|'${root}/second'|'${root}/shared') ;; *) exit 1 ;; esac
if [ "$3" = --version ]; then echo '${provider === "codex" ? "0.166.0" : "2.1.318"}'
elif [ "$PWD" = '${root}/shared' ]; then echo '${root}/first/agent'
else echo "$PWD/agent"; fi
`,
        { mode: 0o755 },
      );
      for (const name of ["first", "second"])
        writeFileSync(
          join(root, name, "agent"),
          `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ name: ${JSON.stringify(name)}, cwd: process.cwd() }) + "\\n");
if (process.argv.includes("auth")) {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "api_key" }));
  process.exit(0);
}
for await (const line of console) {
  const q = JSON.parse(line);
  if (q.id !== undefined) {
    const result = q.method === "account/read" ? { account: { type: "apiKey" } }
      : q.method === "config/read" ? { config: { model: ${JSON.stringify(name)} } } : {};
    console.log(JSON.stringify({ id: q.id, result }));
  } else if (q.type === "control_request") {
    console.log(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: q.request_id,
      response: { models: [{ value: "default", resolvedModel: ${JSON.stringify(name)} }] } } }));
  }
}
`,
          { mode: 0o755 },
        );
      try {
        for (const name of ["first", "shared", "second", "first"]) {
          const cwd = join(root, name),
            model = name === "shared" ? "first" : name,
            before = name === "shared" ? readFileSync(calls, "utf8") : null;
          expect(await discovery.resolve(provider, cwd)).toBe(join(root, model, "agent"));
          expect((await launcher.account(quit, 0, cwd)).signed_in).toBe(true);
          expect(await launcher.model(cwd, quit)).toMatchObject({ model });
          if (before !== null) expect(readFileSync(calls, "utf8")).toBe(before);
          if (provider === "claude" && name === "second") {
            const cached = readFileSync(calls, "utf8");
            for (const folder of ["first", "shared", "second"])
              expect(await launcher.model(join(root, folder), quit)).toMatchObject({
                model: folder === "shared" ? "first" : folder,
              });
            expect(readFileSync(calls, "utf8")).toBe(cached);
            const missing = join(root, "missing");
            await launcher.account(quit, 0, missing);
            expect(await launcher.model(missing, quit)).toMatchObject({ model: "" });
          }
        }
        expect(existsSync(shim)).toBe(false);
        const ran = readFileSync(calls, "utf8")
          .trim()
          .split("\n")
          .map(line => JSON.parse(line));
        expect(new Set(ran.map(call => call.name))).toEqual(new Set(["first", "second"]));
        expect(ran.every(call => realpathSync(call.cwd) === realpathSync("/tmp"))).toBe(true);
      } finally {
        launcher.close();
        quit.signal();
      }
    });
  },
);

test("OpenCode account and model reads use the requested workspace", async () => {
  await isolated(async () => {
    const peek = spyOn(API, "peek").mockImplementation((cwd, read) => read(new API("unused", cwd))),
      call = spyOn(API.prototype, "call").mockImplementation(async (_method, path) => ({
        data: path.includes(encodeURIComponent("/workspace/first"))
          ? { id: "free", providerID: "opencode", cost: [{ input: 0, output: 0 }] }
          : { id: "paid", providerID: "opencode", cost: [{ input: 1, output: 1 }] },
      })),
      launcher = opencode.open(),
      quit = new Quit();
    try {
      for (const [cwd, plan, model] of [
        ["/workspace/first", "Free", "opencode/free"],
        ["/workspace/second", "OpenCode", "opencode/paid"],
      ]) {
        expect((await launcher.account(quit, 0, cwd)).plan.text()).toBe(plan);
        expect(peek.mock.calls.at(-1)?.[0]).toBe(cwd);
        expect(await launcher.model(cwd, quit)).toMatchObject({ model });
      }
    } finally {
      launcher.close();
      peek.mockRestore();
      call.mockRestore();
    }
  });
});
