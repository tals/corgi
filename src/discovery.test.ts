import { test, expect } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as build_id from "./build_id";
import { check, considered, installed, onDemand, onPath, outdated, rescan, resolve as find } from "./discovery";
import { Provider } from "./providers";
test("provider discovery follows current files, permissions and symlink targets", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-discovery-")),
    command = join(root, "agent"),
    target = join(root, "target");
  try {
    expect(onPath("agent", root)).toBeNull();
    mkdirSync(command);
    expect(onPath("agent", root)).toBeNull();
    rmSync(command, { recursive: true });
    symlinkSync(target, command);
    expect(onPath("agent", root)).toBeNull();
    writeFileSync(target, "#!/bin/sh\n", { mode: 0o644 });
    expect(onPath("agent", root)).toBeNull();
    chmodSync(target, 0o755);
    expect(onPath("agent", root)).toBe(command);
    rmSync(target);
    expect(onPath("agent", root)).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function isolated(run: (root: string, script: (name: string, body: string) => string) => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "corgi-discovery-"))),
    keys = [
      "PATH",
      "HOME",
      "XDG_DATA_HOME",
      "MISE_DATA_DIR",
      "MISE_SHIMS_DIR",
      "CORGI_TEST_SYSTEM_ROOT",
      ...Provider.all.map(p => `CORGI_${p.toUpperCase()}_BIN`),
    ],
    saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.HOME = root;
    process.env.PATH = join(root, "bin");
    process.env.CORGI_TEST_SYSTEM_ROOT = join(root, "system");
    await run(root, (name, body) => {
      const path = join(root, name);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return path;
    });
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  }
}

test("mise resolves every provider without executing its shim or agent", async () => {
  await isolated(async (root, script) => {
    const versions = { codex: "0.166.0", claude: "2.1.318", pi: "1.20.0", opencode2: "2.1.2", omp: "12.0.0" },
      called = join(root, "agent-called"),
      shims = join(root, ".local/share/mise/shims");
    for (const p of Provider.all) {
      script(`.local/share/mise/shims/${p}`, `echo called >> '${called}'; exit 1`);
      script(`installed/${p}`, `echo called >> '${called}'; exit 1`);
    }
    script(
      "bin/mise",
      `
echo "$PWD $*" >> '${root}/mise-called'
case "$1:$2" in
${Provider.all.map(p => `  which:${p}) if [ "$3" = --version ]; then echo '${versions[p]}'; else echo '${root}/installed/${p}'; fi ;;`).join("\n")}
  *) exit 1 ;;
esac`,
    );
    process.env.PATH += ":" + shims;
    await check(root);
    for (const p of Provider.all) {
      expect(installed(p, root)).toBe(true);
      expect(await find(p, root)).toBe(join(root, "installed", p));
    }
    expect(existsSync(called)).toBe(false);
    expect(readFileSync(join(root, "mise-called"), "utf8")).toContain(`${root} which opencode2\n`);
    expect(considered("opencode2", root)[0].version).toBe("opencode v2.1.2");
  });
});

test("a missing mise tool is hidden and its shim is never executed", async () => {
  await isolated(async (root, script) => {
    const shims = join(root, "custom-shims"),
      called = join(root, "shim-called");
    process.env.MISE_SHIMS_DIR = shims;
    process.env.PATH += ":" + shims;
    script("custom-shims/opencode", `echo called > '${called}'; echo 'opencode v2.1.2'`);
    script("bin/mise", "exit 1");
    expect(installed("opencode2", root)).toBe(false);
    await expect(find("opencode2", root)).rejects.toThrow("ProviderNotFound");
    expect(onDemand("opencode2", root)).toBe(true);
    expect(await find("opencode2", root, { stubs: true })).toBe(join(shims, "opencode"));
    expect(installed("opencode2", root)).toBe(false);
    expect(existsSync(called)).toBe(false);
  });
});

test("mise selection follows the workspace and refreshes when its configuration changes", async () => {
  await isolated(async (root, script) => {
    const first = script("first/pi", "exit 1"),
      second = script("second/pi", "exit 1");
    script(
      "bin/mise",
      `
[ "$2" = pi ] || exit 1
if [ "$3" = --version ]; then echo 1.20.0
elif [ "$PWD" = '${root}/first' ]; then echo '${first}'
else echo '${second}'; fi`,
    );
    expect(await find("pi", join(root, "first"))).toBe(first);
    expect(await find("pi", join(root, "second"))).toBe(second);
    expect(considered("pi", join(root, "first"))[0].path).toBe(first);
    script("bin/mise", `if [ "$3" = --version ]; then echo 1.21.0; else echo '${second}'; fi`);
    expect(await find("pi", join(root, "first"))).toBe(second);
  });
});

test("mise's old OpenCode version is rejected without running OpenCode", async () => {
  await isolated(async (root, script) => {
    const called = join(root, "agent-called"),
      path = script("installed/opencode", `echo called > '${called}'; exit 1`);
    script(
      "bin/mise",
      `[ "$2" = opencode ] || exit 1
if [ "$3" = --version ]; then echo 1.2.3; else echo '${path}'; fi`,
    );
    await expect(find("opencode2", root)).rejects.toThrow("ProviderTooOld");
    await expect(find("opencode2", root, { stubs: true })).rejects.toThrow("ProviderTooOld");
    expect(installed("opencode2", root)).toBe(false);
    expect(existsSync(called)).toBe(false);
  });
});

test("rescanning a workspace replaces its missing-tool shim with the installed agent", async () => {
  await isolated(async (root, script) => {
    const shims = join(root, "custom-shims"),
      workspace = join(root, "workspace"),
      called = join(root, "shim-called"),
      ready = join(root, "installed-ready"),
      executable = script("installed/pi", `echo called > '${called}'; exit 1`);
    mkdirSync(workspace);
    process.env.MISE_SHIMS_DIR = shims;
    process.env.PATH += ":" + shims;
    script("custom-shims/pi", `echo called > '${called}'; exit 1`);
    script(
      "bin/mise",
      `
[ "$PWD" = '${workspace}' ] && [ "$2" = pi ] && [ -f '${ready}' ] || exit 1
if [ "$3" = --version ]; then echo 1.20.0; else echo '${executable}'; fi`,
    );
    await rescan(["pi"], workspace);
    expect(onDemand("pi", workspace)).toBe(true);
    writeFileSync(ready, "");
    await rescan(["pi"], workspace);
    expect(installed("pi", workspace)).toBe(true);
    expect(onDemand("pi", workspace)).toBe(false);
    expect(installed("pi", root)).toBe(false);
    expect(onDemand("pi", root)).toBe(true);
    expect(existsSync(called)).toBe(false);
  });
});

test("package metadata identifies npm agents and observes package-only updates", async () => {
  await isolated(async (root, script) => {
    const called = join(root, "agent-called"),
      path = script("node_modules/@opencode/cli/bin/opencode.cjs", `echo called > '${called}'; exit 1`),
      file = join(root, "node_modules/@opencode/cli/package.json");
    mkdirSync(join(root, "bin"));
    symlinkSync(path, join(root, "bin/opencode2"));
    writeFileSync(file, JSON.stringify({ name: "@opencode/cli", version: "2.1.2" }));
    expect(await find("opencode2", root)).toBe(join(root, "bin/opencode2"));
    writeFileSync(file, JSON.stringify({ name: "@opencode/cli", version: "1.2.30" }));
    expect(installed("opencode2", root)).toBe(false);
    await expect(find("opencode2", root)).rejects.toThrow("ProviderTooOld");
    expect(existsSync(called)).toBe(false);
  });
});

test("unmanaged installs still work when mise has no matching tool", async () => {
  await isolated(async (root, script) => {
    script("bin/mise", "exit 1");
    const path = script("bin/codex", "echo 'codex-cli 0.166.0'");
    expect(await find("codex", root)).toBe(path);
  });
});

test("a failed standalone version check does not leave a phantom installed agent", async () => {
  await isolated(async (root, script) => {
    script("bin/opencode", "exit 1");
    await expect(find("opencode2", root)).rejects.toThrow("ProviderNotFound");
    expect(installed("opencode2", root)).toBe(false);
    script("bin/opencode", "echo 'opencode v2.1.2'");
    expect(await find("opencode2", root)).toBe(join(root, "bin/opencode"));
    expect(installed("opencode2", root)).toBe(true);
  });
});
test("a bare provider name resolves past Corgi's own alias on PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-discovery-")),
    alias = join(root, "alias"),
    real = join(root, "real");
  try {
    const self = build_id.executablePath(
      import.meta.filename,
      process.execPath,
      resolve(import.meta.dir, "../corgi"),
      process.env.CORGI_APP_EXE,
    );
    mkdirSync(alias);
    mkdirSync(real);
    symlinkSync(self, join(alias, "claude"));
    expect(onPath("claude", alias)).toBeNull();
    writeFileSync(join(real, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    expect(onPath("claude", `${alias}:${real}`)).toBe(join(real, "claude"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("an install too old for Corgi isn't installed once a probe turns it down", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-discovery-")),
    pi = join(root, "pi"),
    saved = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CORGI_PI_BIN: process.env.CORGI_PI_BIN,
      CORGI_TEST_SYSTEM_ROOT: process.env.CORGI_TEST_SYSTEM_ROOT,
    };
  try {
    process.env.PATH = root;
    process.env.HOME = root;
    // Keep system installs, such as a Homebrew pi, out of the candidates.
    process.env.CORGI_TEST_SYSTEM_ROOT = root;
    delete process.env.CORGI_PI_BIN;
    writeFileSync(pi, "#!/bin/sh\necho 0.84.2\n", { mode: 0o755 });
    expect(installed("pi")).toBe(false);
    await expect(find("pi")).rejects.toThrow("ProviderTooOld");
    expect(outdated("pi")).toBe("0.84.2");
    expect(installed("pi")).toBe(false);
    // An update is probed afresh.
    writeFileSync(pi, "#!/bin/sh\necho 1.20.0\n", { mode: 0o755 });
    expect(installed("pi")).toBe(false);
    expect(await find("pi")).toBe(pi);
    expect(installed("pi")).toBe(true);
    expect(outdated("pi")).toBeNull();
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  }
});
test.each(["failure", "timeout", "missing interpreter"])(
  "a shim with %s is not an installed provider",
  async failure => {
    const root = mkdtempSync(join(tmpdir(), "corgi-discovery-")),
      shim = join(root, "opencode"),
      ready = join(root, "ready"),
      saved = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CORGI_OPENCODE2_BIN: process.env.CORGI_OPENCODE2_BIN,
        CORGI_TEST_SYSTEM_ROOT: process.env.CORGI_TEST_SYSTEM_ROOT,
      };
    try {
      process.env.PATH = root;
      process.env.HOME = root;
      process.env.CORGI_TEST_SYSTEM_ROOT = root;
      delete process.env.CORGI_OPENCODE2_BIN;
      writeFileSync(
        shim,
        failure === "missing interpreter"
          ? "#!/nonexistent/interpreter\n"
          : `#!/bin/sh
[ "$MISE_AUTO_INSTALL:$MISE_EXEC_AUTO_INSTALL:$MISE_NOT_FOUND_AUTO_INSTALL" = "0:0:0" ] || exit 3
if [ -f '${ready}' ]; then echo 'opencode v2.2.5'; exit; fi
${failure === "timeout" ? "exec /bin/sleep 5" : "echo 'missing install' >&2; exit 1"}
`,
        { mode: 0o755 },
      );
      expect(installed("opencode2")).toBe(false);
      await expect(find("opencode2")).rejects.toThrow("ProviderNotFound");
      expect(installed("opencode2")).toBe(false);
      expect(outdated("opencode2")).toBeNull();
      if (failure !== "missing interpreter") {
        // Installing the target doesn't change the shim: failed probes must retry.
        writeFileSync(ready, "");
        expect(await find("opencode2")).toBe(shim);
        expect(installed("opencode2")).toBe(true);
      }
    } finally {
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
