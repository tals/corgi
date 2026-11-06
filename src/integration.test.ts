import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as discovery from "./discovery";
import * as integration from "./integration";
import { Provider, adapter } from "./providers";

async function isolated(run: (root: string) => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "corgi-integration-"))),
    keys = [
      "PATH",
      "HOME",
      "CORGI_ENV_BASE",
      "CORGI_TEST_SYSTEM_ROOT",
      "MISE_DATA_DIR",
      "MISE_CONFIG_DIR",
      "MISE_SHIMS_DIR",
      "XDG_DATA_HOME",
      "PI_CODING_AGENT_DIR",
      ...Provider.all.map(p => `CORGI_${p.toUpperCase()}_BIN`),
    ],
    saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.HOME = root;
    process.env.CORGI_ENV_BASE = root;
    process.env.CORGI_TEST_SYSTEM_ROOT = join(root, "system");
    process.env.PATH = join(root, "bin");
    mkdirSync(process.env.PATH);
    await run(root);
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  }
}

function standalone(root: string, provider: "pi" | "omp") {
  writeFileSync(join(root, "bin", provider), `#!/bin/sh\nprintf '${provider === "pi" ? "1.0.0" : "omp/1.0.0"}\\n'\n`, {
    mode: 0o755,
  });
}

function workspaceInstall(root: string, provider: "pi" | "omp") {
  const cwd = join(root, "workspace"),
    executable = join(root, "installed", provider),
    shims = join(root, "shims"),
    ran = join(root, "agent-ran"),
    shim = join(root, "shim-ran");
  for (const path of [cwd, join(root, "installed"), shims]) mkdirSync(path);
  writeFileSync(executable, `#!/bin/sh\n: > '${ran}'\nexit 1\n`, { mode: 0o755 });
  writeFileSync(join(shims, provider), `#!/bin/sh\n: > '${shim}'\nexit 1\n`, { mode: 0o755 });
  writeFileSync(
    join(root, "bin", "mise"),
    `#!/bin/sh\n[ "$PWD" = '${cwd}' ] && [ "$1:$2" = 'which:${provider}' ] || exit 1\n` +
      `if [ "$3" = --version ]; then echo '1.0.0'; else echo '${executable}'; fi\n`,
    { mode: 0o755 },
  );
  process.env.PATH += ":" + shims;
  process.env.MISE_SHIMS_DIR = shims;
  return { cwd, executable, ran, shim };
}

test.each(["pi", "omp"] as const)(
  "standalone %s installs its extension before discovery and updates it on handoff",
  async provider => {
    for (const handoff of [false, true])
      await isolated(async root => {
        standalone(root, provider);
        expect(discovery.installed(provider)).toBe(false);
        const account = join(root, handoff ? "handoff" : "cold"),
          extension = join(account, "extensions", "corgi.js");
        if (handoff) {
          mkdirSync(join(account, "extensions"), { recursive: true });
          writeFileSync(extension, `// Corgi's ${provider === "pi" ? "Pi" : "omp"} integration.\n// old version\n`);
        }
        await integration.prepare(provider, account, handoff);
        expect(readFileSync(extension, "utf8")).toBe(adapter(provider).integration.snippet(""));
      });
  },
);

test.each(["pi", "omp"] as const)(
  "missing %s setup is retried when its standalone installation appears",
  async provider => {
    await isolated(async root => {
      const account = join(root, "account"),
        extension = join(account, "extensions", "corgi.js");
      await integration.prepare(provider, account);
      expect(existsSync(extension)).toBe(false);
      standalone(root, provider);
      await integration.prepare(provider, account);
      expect(readFileSync(extension, "utf8")).toBe(adapter(provider).integration.snippet(""));
    });
  },
);

test.each(["pi", "omp"] as const)("workspace-only %s prepares hooks alongside daemon discovery", async provider => {
  await isolated(async root => {
    const install = workspaceInstall(root, provider),
      account = join(root, "account"),
      extension = join(account, "extensions", "corgi.js");
    await Promise.all([
      integration.prepare(provider, account),
      integration.prepare(provider, account, false, install.cwd),
    ]);
    expect(discovery.installed(provider)).toBe(false);
    expect(discovery.installed(provider, install.cwd)).toBe(true);
    expect(readFileSync(extension, "utf8")).toBe(adapter(provider).integration.snippet(""));
    expect(existsSync(install.ran)).toBe(false);
    expect(existsSync(install.shim)).toBe(false);
  });
});

test.each(["pi", "omp"] as const)("launching workspace-only %s installs hooks before exec", async provider => {
  await isolated(async root => {
    const install = workspaceInstall(root, provider),
      account = join(root, "account"),
      extension = join(account, "extensions", "corgi.js");
    writeFileSync(install.executable, `#!/bin/sh\n[ -f '${extension}' ] || exit 1\nprintf 'extension ready\\n'\n`, {
      mode: 0o755,
    });
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { launch } from ${JSON.stringify(import.meta.filename.replace(/\.test\.ts$/, ".ts"))}; await launch('${provider}', [], '');`,
      ],
      {
        cwd: install.cwd,
        env: { ...process.env, CORGI_PANE: "1", PI_CODING_AGENT_DIR: account },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, output, error }).toEqual({ code: 0, output: "extension ready\n", error: "" });
    expect(readFileSync(extension, "utf8")).toBe(adapter(provider).integration.snippet(""));
    expect(existsSync(install.shim)).toBe(false);
  });
});
