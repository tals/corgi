import { test, expect } from "bun:test";
import { publish, releaseVersion, installer, loadCredentials, cleanCommit, timestampVersion, publishedVersion, versionParts, releaseOptions, releasePaths, releaseCommit, withReleaseCheckout, releaseEnvironment, macosSdk, validateBinary, type Store } from "../scripts/release.ts";
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, stat, symlink } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { n, pair, readUntil, write } from "../src/native_ffi";
import { nativeRoot } from "../src/native_paths";
import { launcher } from "../src/updates";
const bytes = (s: string) => new TextEncoder().encode(s);
class MemoryStore implements Store {
  files = new Map<string, Uint8Array>();
  writes: string[] = [];
  fail = "";
  async get(key: string) { return this.files.get(key) ?? null; }
  async put(key: string, value: Uint8Array) { this.writes.push(key); this.files.set(key, value); }
  async publicGet(key: string) { if (key === this.fail) throw new Error("Offline"); return this.files.get(key)!; }
}
const testInstaller = () => installer("https://example.invalid", "1.2.3", { "macos-aarch64": { sha256: "mac", size: 1 }, "linux-x86_64": { sha256: "linux", size: 2 } });
const assets = ["macos", "linux", "manifest.json"].map(name => ({ key: `releases/1.2.3/${name}`, bytes: bytes(name), type: "application/octet-stream" }));
test("publication verifies every platform before advancing the channel", async () => {
  const store = new MemoryStore();
  await publish(store, assets, bytes("signed feed"), bytes("installer"));
  expect(store.writes.at(-1)).toBe("channels/stable.json");
  expect(store.writes.slice(0, 3)).toEqual(assets.map(a => a.key));
});
test("failed public download leaves channel untouched; retry reuses identical uploads", async () => {
  const store = new MemoryStore();
  store.files.set("channels/stable.json", bytes("old"));
  store.fail = assets[1].key;
  await expect(publish(store, assets, bytes("new"), bytes("installer"))).rejects.toThrow("Offline");
  expect(store.files.get("channels/stable.json")).toEqual(bytes("old"));
  store.fail = "";
  await publish(store, assets, bytes("new"), bytes("installer"));
  expect(store.writes.filter(k => k === assets[0].key).length).toBe(1);
});
test("immutable release collision never changes the channel", async () => {
  const store = new MemoryStore();
  store.files.set(assets[0].key, bytes("different"));
  await expect(publish(store, assets, bytes("new"), bytes("installer"))).rejects.toThrow("Refusing to overwrite");
  expect(store.writes).toEqual([]);
});
test("versions are stable semantic versions and cannot become paths", () => {
  for (const v of ["../1.0.0", "v1.0.0", "01.2.3", "1.0.0-beta", "1.2.3/4"]) expect(() => releaseVersion(v)).toThrow();
  expect(releaseVersion("1.2.3")).toBe("1.2.3");
});
test("installer pins both checksums and shell-quotes the base URL", () => {
  const script = installer("https://example.com/a'b", "1.2.3", { "macos-aarch64": { sha256: "mac", size: 1 }, "linux-x86_64": { sha256: "linux", size: 2 } });
  expect(script).toContain("'https://example.com/a'\\''b'");
  expect(script).toContain("${CORGI_INSTALL_ROOT:-$HOME/.local/share/corgi}");
  const p = Bun.spawnSync(["/bin/sh", "-n"], { stdin: Buffer.from(script) });
  expect(p.exitCode).toBe(0);
});
test("private file credentials work without exporting secrets into the shell", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corgi-credentials-test-"));
  const path = join(dir, "credentials.json");
  try {
    await writeFile(path, JSON.stringify({ accessKeyId: "test-id", secretAccessKey: "test-secret" }), { mode: 0o600 });
    expect(await loadCredentials({ credentialsFile: path }, {})).toEqual({ accessKeyId: "test-id", secretAccessKey: "test-secret" });
    expect(await loadCredentials({ credentialsFile: path }, { AWS_ACCESS_KEY_ID: "env-id", AWS_SECRET_ACCESS_KEY: "env-secret" })).toEqual({ accessKeyId: "env-id", secretAccessKey: "env-secret" });
    await expect(loadCredentials({ credentialsFile: path }, { AWS_ACCESS_KEY_ID: "partial" })).rejects.toThrow("Set both");
    await chmod(path, 0o644);
    await expect(loadCredentials({ credentialsFile: path }, {})).rejects.toThrow("private");
    await chmod(path, 0o600);
    await writeFile(path, '{"secretAccessKey":"sensitive-malformed-value');
    await expect(loadCredentials({ credentialsFile: path }, {})).rejects.toThrow("must contain valid JSON");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("timestamp versions include the commit and sort chronologically", () => {
  const v = timestampVersion("a".repeat(40), new Date("2026-09-25T00:30:12Z"));
  expect(v).toBe("20260925T003012Z-aaaaaaaaaaaa");
  expect(versionParts(v)).toEqual([20260925, 3012, 0]);
  expect(() => releaseVersion("20260925T003012Z-../../foo")).toThrow();
});
test("release checkout validation refuses unstaged, staged and untracked changes anywhere", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corgi-clean-test-"));
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(["git", ...args], {cwd: dir});
    if (p.exitCode) throw new Error(p.stderr.toString());
  };
  try {
    git("init"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
    await writeFile(join(dir, "tracked"), "original");
    git("add", "."); git("commit", "-m", "initial");
    expect(cleanCommit(dir)).toMatch(/^[a-f0-9]{40}$/);
    await writeFile(join(dir, "outside-source"), "untracked");
    expect(() => cleanCommit(dir)).toThrow("dirty");
    await rm(join(dir, "outside-source"));
    await writeFile(join(dir, "tracked"), "changed");
    expect(() => cleanCommit(dir)).toThrow("dirty");
    git("add", "tracked");
    expect(() => cleanCommit(dir)).toThrow("dirty");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("publishing only accepts valid timestamp IDs tied to HEAD", () => {
  const commit = "a".repeat(40);
  expect(publishedVersion("20260925T003012Z-aaaaaaaaaaaa", commit)).toBe("20260925T003012Z-aaaaaaaaaaaa");
  for (const v of ["1.2.3", "20260925T003012Z-aaaaaaa", "20260925T003012Z-bbbbbbbbbbbb", "20260230T003012Z-aaaaaaaaaaaa"]) expect(() => publishedVersion(v, commit)).toThrow();
});

test("release modes accept an explicit version and reject ambiguous arguments", () => {
  const version = timestampVersion("a".repeat(40));
  for (const mode of ["--dry-run", "--build-only", "--publish-only"]) {
    expect(releaseOptions([mode, version])).toEqual({ mode, version });
    expect(releaseOptions([version, mode])).toEqual({ mode, version });
  }
  expect(releaseOptions([])).toEqual({ mode: "", version: undefined });
  for (const args of [["--dry-run", "--dry-run"], ["--dry-run", "--build-only"], ["--unknown"], ["--publish-only"], [version, version]]) {
    expect(() => releaseOptions(args)).toThrow();
  }
});

async function releaseFixture(run: (dir: string, git: (...args: string[]) => string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "corgi release test "));
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(["git", "--no-optional-locks", ...args], { cwd: dir });
    if (p.exitCode) throw new Error(p.stderr.toString());
    return p.stdout.toString().trim();
  };
  try {
    git("init"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
    await writeFile(join(dir, "tracked"), "committed");
    await writeFile(join(dir, ".gitignore"), "zig-out/\n.zig-cache/\n.tools/\ndist/\nnode_modules/\n");
    git("add", "."); git("commit", "-m", "initial");
    await run(dir, git);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("isolated release pins HEAD and preserves dirty files, index and development outputs", async () => {
  await releaseFixture(async (dir, git) => {
    const options = releaseOptions([]);
    const paths = releasePaths(dir);
    const commit = await releaseCommit(dir, options, paths.releases);
    await writeFile(join(dir, "tracked"), "staged"); git("add", "tracked");
    await writeFile(join(dir, "tracked"), "unstaged");
    await writeFile(join(dir, "untracked"), "keep me");
    await mkdir(join(dir, "zig-out"));
    await writeFile(join(dir, "zig-out/development"), "running build");
    const index = await readFile(join(dir, ".git/index"));
    const status = git("status", "--porcelain");
    const worktrees = git("worktree", "list", "--porcelain");
    let sourcePath = "";
    await withReleaseCheckout(dir, commit, async source => {
      sourcePath = source;
      expect(cleanCommit(source)).toBe(commit);
      expect(await Bun.file(join(source, "tracked")).text()).toBe("committed");
      expect(await Bun.file(join(source, "untracked")).exists()).toBe(false);
      expect(await Bun.file(join(source, "zig-out/development")).exists()).toBe(false);
      expect(releasePaths(source)).toEqual(paths);
      expect(git("status", "--porcelain")).toBe(status);
      expect(await readFile(join(dir, ".git/index"))).toEqual(index);
      // The user can keep committing and building while this release runs.
      git("commit", "-m", "next development commit");
      expect(git("rev-parse", "HEAD")).not.toBe(commit);
      expect(cleanCommit(source)).toBe(commit);
      await mkdir(join(source, "zig-out"));
      await writeFile(join(source, "zig-out/development"), "release build");
    });
    expect(await Bun.file(join(sourcePath, "tracked")).exists()).toBe(false);
    expect(git("worktree", "list", "--porcelain").split("worktree ").length).toBe(worktrees.split("worktree ").length);
    expect(await Bun.file(join(dir, "tracked")).text()).toBe("unstaged");
    expect(await Bun.file(join(dir, "untracked")).text()).toBe("keep me");
    expect(await Bun.file(join(dir, "zig-out/development")).text()).toBe("running build");
  });
});

test("failed isolated builds remove their worktree and leave staging untouched", async () => {
  await releaseFixture(async (dir, git) => {
    const commit = git("rev-parse", "HEAD");
    await writeFile(join(dir, "tracked"), "staged"); git("add", "tracked");
    const index = await readFile(join(dir, ".git/index"));
    const worktrees = git("worktree", "list", "--porcelain");
    let sourcePath = "";
    await expect(withReleaseCheckout(dir, commit, async source => {
      sourcePath = source;
      await writeFile(join(source, "tracked"), "failed build changed its source");
      throw new Error("build failed");
    })).rejects.toThrow("build failed");
    expect(await Bun.file(join(sourcePath, "tracked")).exists()).toBe(false);
    expect(git("worktree", "list", "--porcelain")).toBe(worktrees);
    expect(await readFile(join(dir, ".git/index"))).toEqual(index);
    expect(await Bun.file(join(dir, "tracked")).text()).toBe("staged");
  });
});

test("resume uses the saved commit after HEAD moves and retains artifacts", async () => {
  await releaseFixture(async (dir, git) => {
    const commit = git("rev-parse", "HEAD");
    const version = timestampVersion(commit);
    const paths = releasePaths(dir);
    const out = join(paths.releases, version);
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "prepared.json"), JSON.stringify({ commit, version }));
    await writeFile(join(out, "artifact"), "signed bytes");
    await writeFile(join(dir, "tracked"), "next commit");
    git("add", "tracked"); git("commit", "-m", "next");
    await writeFile(join(dir, "tracked"), "more pending changes");
    const options = releaseOptions([version, "--publish-only"]);
    const saved = await releaseCommit(dir, options, paths.releases);
    expect(saved).toBe(commit);
    expect(publishedVersion(version, saved)).toBe(version);
    await withReleaseCheckout(dir, saved, async source => {
      expect(cleanCommit(source)).toBe(commit);
      expect(await Bun.file(join(source, "tracked")).text()).toBe("committed");
    });
    expect(await Bun.file(join(out, "artifact")).text()).toBe("signed bytes");
    await writeFile(join(out, "prepared.json"), JSON.stringify({ commit: "../../invalid", version }));
    await expect(releaseCommit(dir, options, paths.releases)).rejects.toThrow("Invalid prepared");
  });
});

test("isolated builds reuse a local compiler with a separate local cache", () => {
  const env = releaseEnvironment("/repo", "/isolated", { ZIG: ".tools/zig", ZIG_LOCAL_CACHE_DIR: "/repo/native/.zig-cache" });
  expect(env.ZIG).toBe("/repo/.tools/zig");
  expect(env.ZIG_LOCAL_CACHE_DIR).toBe("/isolated/native/.zig-cache");
  const host = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "macos" : process.platform}`;
  expect(releaseEnvironment("/repo", "/isolated", { PATH: "/nonexistent" }).ZIG).toBe(`/repo/.tools/zig-${host}-0.16.0/zig`);
});

test("macOS builds use the configured SDK, else the copy in .tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corgi-sdk-test-"));
  try {
    expect(macosSdk(dir, { macosSdk: "sdk" })).toBe(join(dir, "sdk"));
    expect(() => macosSdk(dir, {}, "linux")).toThrow("No macOS SDK");
    await mkdir(join(dir, ".tools/macos-sdk"), { recursive: true });
    await writeFile(join(dir, ".tools/macos-sdk/SDKSettings.json"), "{}");
    expect(macosSdk(dir, {}, "linux")).toBe(join(dir, ".tools/macos-sdk"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("binaries must match their platform", () => {
  const mach = Buffer.alloc(64); mach.writeUInt32LE(0xfeedfacf, 0); mach.writeUInt32LE(0x0100000c, 4);
  const elf = Buffer.alloc(64); elf.write("7f454c46", "hex"); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(62, 18); elf.writeBigUInt64LE(64n, 32); elf.writeUInt16LE(56, 54);
  validateBinary("macos-aarch64", mach);
  validateBinary("linux-x86_64", elf);
  expect(() => validateBinary("macos-aarch64", elf)).toThrow("Mach-O");
  expect(() => validateBinary("linux-x86_64", mach)).toThrow("ELF");
});

test("CLI dry run accepts dirty HEAD without creating release state", async () => {
  await releaseFixture(async (dir, git) => {
    await mkdir(join(dir, "scripts"));
    for (const name of ["release.ts", "install.sh.in"]) await writeFile(join(dir, "scripts", name), await Bun.file(join(import.meta.dir, "../scripts", name)).text());
    git("add", "scripts"); git("commit", "-m", "publisher");
    const commit = git("rev-parse", "HEAD");
    await writeFile(join(dir, "tracked"), "pending"); git("add", "tracked");
    const index = await readFile(join(dir, ".git/index"));
    const worktrees = git("worktree", "list", "--porcelain");
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, "run", "scripts/release.ts", ...args], { cwd: dir });
    const dry = run("--dry-run");
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout.toString()).toContain(`Source: ${commit} (isolated committed tree; pending edits excluded)`);
    expect(await stat(join(dir, ".git/corgi-publish.lock")).catch(() => null)).toBeNull();
    expect(await stat(join(dir, ".git/corgi-releases")).catch(() => null)).toBeNull();
    expect(git("worktree", "list", "--porcelain")).toBe(worktrees);
    expect(await readFile(join(dir, ".git/index"))).toEqual(index);
  });
});

test("CLI runs the committed build script and cleans up after failure", async () => {
  await releaseFixture(async (dir, git) => {
    await mkdir(join(dir, "scripts"));
    for (const name of ["release.ts", "install.sh.in"]) await writeFile(join(dir, "scripts", name), await Bun.file(join(import.meta.dir, "../scripts", name)).text());
    await writeFile(join(dir, "build.ts"), 'console.log("COMMITTED BUILD: " + process.cwd());\nif (await Bun.file("tracked").text() !== "committed") process.exit(1);\nif (process.env.ZIG_LOCAL_CACHE_DIR !== process.cwd() + "/native/.zig-cache") process.exit(1);\nconsole.log("ISOLATION VERIFIED");\nprocess.exit(37);\n');
    git("add", "."); git("commit", "-m", "publisher fixture");
    await writeFile(join(dir, "build.ts"), 'console.log("DIRTY BUILD RAN");\nprocess.exit(1);\n');
    await writeFile(join(dir, "tracked"), "pending"); git("add", "tracked");
    const index = await readFile(join(dir, ".git/index"));
    const status = git("status", "--porcelain");
    const worktrees = git("worktree", "list", "--porcelain");
    // Fixture keys/config stay in Git metadata and never reach a service.
    const keyPath = join(dir, ".git/test-key.pem");
    await writeFile(keyPath, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
    const configPath = join(dir, ".git/test-config.json");
    await writeFile(configPath, JSON.stringify({ publicBaseUrl: "https://example.invalid", endpoint: "https://example.invalid", region: "auto", bucket: "fixture", signingKey: keyPath, codesignIdentity: "-" }));
    const child = Bun.spawn([process.execPath, "run", "scripts/release.ts", "--build-only"], { cwd: dir, env: { ...process.env, CORGI_RELEASE_CONFIG: configPath }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(1);
    expect(stdout).toContain("ISOLATION VERIFIED");
    expect(stdout).not.toContain("DIRTY BUILD RAN");
    expect(stderr).toContain(`Command failed: ${process.execPath} build.ts --test`);
    expect(git("worktree", "list", "--porcelain")).toBe(worktrees);
    expect(git("status", "--porcelain")).toBe(status);
    expect(await readFile(join(dir, ".git/index"))).toEqual(index);
    expect(await stat(join(dir, ".git/corgi-publish.lock")).catch(() => null)).toBeNull();

    // Ad-hoc builds are never publishable, and stop before any network access.
    const commit = git("rev-parse", "HEAD");
    const version = timestampVersion(commit);
    const out = join(dir, ".git/corgi-releases", version);
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "prepared.json"), JSON.stringify({ commit, version, publishable: false }));
    git("commit", "--allow-empty", "-m", "new development commit");
    const resumed = Bun.spawn([process.execPath, "run", "scripts/release.ts", version, "--publish-only"], { cwd: dir, env: { ...process.env, CORGI_RELEASE_CONFIG: configPath, AWS_ACCESS_KEY_ID: "fixture", AWS_SECRET_ACCESS_KEY: "fixture" }, stdout: "pipe", stderr: "pipe" });
    const [resumeOut, resumeErr, resumeCode] = await Promise.all([new Response(resumed.stdout).text(), new Response(resumed.stderr).text(), resumed.exited]);
    expect(resumeCode).toBe(1);
    expect(resumeErr).toContain("Ad-hoc signing is only allowed with --build-only");
    expect(resumeOut).not.toContain("COMMITTED BUILD");
    expect(await stat(join(dir, ".git/corgi-publish.lock")).catch(() => null)).toBeNull();
  });
});

test("PATH setup handles shell configs, spaces, duplicates and opting out", async () => {
  const base = await mkdtemp(join(tmpdir(), "corgi path test "));
  const script = testInstaller().replace(/\nmain "\$@"\n$/, "\nsetup_path\n");
  const run = (home: string, shell: string, setup: string, path = "/usr/bin:/bin") => {
    const p = Bun.spawnSync(["/bin/sh", "-c", script], {env: {...process.env, HOME:home, SHELL:shell, PATH:path, CORGI_INSTALL_BIN:home+"/.local/bin/corgi", CORGI_UPDATE_PATH:setup, ZDOTDIR:home+"/zsh config", XDG_CONFIG_HOME:home+"/config"}});
    expect(p.exitCode).toBe(0);
    return p.stdout.toString();
  };
  try {
    const bashHome = join(base, "bash");
    await import("node:fs/promises").then(fs => fs.mkdir(bashHome));
    await writeFile(join(bashHome, ".bash_profile"), '# existing\n. "$HOME/.bashrc"\n');
    expect(run(bashHome, "/bin/bash", "1")).toContain("✓ Added ~/.local/bin to PATH in ~/.bashrc and ~/.bash_profile\n");
    expect(run(bashHome, "/bin/bash", "1")).toContain("✓ Added ~/.local/bin to PATH in ~/.bashrc and ~/.bash_profile (already done)\n");
    const profile = await Bun.file(join(bashHome, ".bash_profile")).text();
    expect(profile.startsWith("# existing\n")).toBe(true);
    expect(profile.match(/export PATH/g)?.length).toBe(1);
    const shell = Bun.spawnSync(["/bin/bash", "--noprofile", "--norc", "-c", '. "$HOME/.bash_profile"; . "$HOME/.bashrc"; printf "%s" "$PATH"'], {env:{HOME:bashHome, PATH:"/usr/bin:/bin"}});
    expect(shell.exitCode).toBe(0);
    expect(shell.stdout.toString().split(":").filter(p => p === bashHome+"/.local/bin").length).toBe(1);
    expect(await Bun.file(join(bashHome, ".bashrc")).text()).toContain('export PATH="$HOME/.local/bin:$PATH"');
    expect(await Bun.file(join(bashHome, ".profile")).exists()).toBe(false);
    const zshHome = join(base,"zsh"); run(zshHome,"/bin/zsh","1");
    expect(await Bun.file(join(zshHome,"zsh config/.zshrc")).text()).toContain("export PATH");
    const fishHome = join(base,"fish"); run(fishHome,"/usr/bin/fish","1");
    expect(await Bun.file(join(fishHome,"config/fish/conf.d/corgi.fish")).text()).toContain("fish_add_path");
    const skipHome = join(base,"skip");
    expect(run(skipHome,"/bin/bash","0")).toContain("Left PATH alone");
    expect(await Bun.file(join(skipHome,".bashrc")).exists()).toBe(false);
    expect(run(skipHome,"/bin/bash","1",skipHome+"/.local/bin:/usr/bin:/bin")).toContain("✓ Added ~/.local/bin to PATH (already done)\n");
    expect(await Bun.file(join(skipHome,".bashrc")).exists()).toBe(false);
  } finally { await rm(base,{recursive:true,force:true}); }
});

test("rerunning the installer skips finished steps without downloading", async () => {
  const home = await mkdtemp(join(tmpdir(), "corgi reinstall test "));
  try {
    const root = join(home, ".local/share/corgi"), bin = join(home, ".local/bin/corgi");
    await mkdir(root, { recursive: true }); await mkdir(join(home, ".local/bin"));
    await writeFile(join(root, "current"), "1.2.3"); await writeFile(bin, "#!/bin/sh\n"); await chmod(bin, 0o755);
    const env: Record<string, string | undefined> = {...process.env, HOME:home, SHELL:"/bin/bash", PATH:join(home, ".local/bin")+":/usr/bin:/bin"};
    delete env.CORGI_PANE;
    const p = Bun.spawnSync(["/bin/sh", "-c", testInstaller()], {env});
    expect(p.stderr.toString()).toBe("");
    expect(p.exitCode).toBe(0);
    const out = p.stdout.toString();
    for (const line of ["✓ Downloaded corgi (already done)", "✓ Installed corgi 1.2.3 at ~/.local/bin/corgi (already done)", "✓ Added ~/.local/bin to PATH (already done)", "Run corgi to start."]) expect(out).toContain(line);
    expect(out).not.toContain("\x1b");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("the installer updates an older installation and leaves a newer one", async () => {
  const home = await mkdtemp(join(tmpdir(), "corgi update test "));
  try {
    const root = join(home, ".local/share/corgi"), bin = join(home, ".local/bin/corgi"), stub = join(home, "stub");
    await mkdir(root, { recursive: true }); await mkdir(join(home, ".local/bin")); await mkdir(stub);
    await writeFile(join(root, "current"), "1.2.4"); await writeFile(bin, "#!/bin/sh\n"); await chmod(bin, 0o755);
    // A failing curl shows whether it downloads, without the network.
    await writeFile(join(stub, "curl"), "#!/bin/sh\necho stubbed >&2\nexit 22\n"); await chmod(join(stub, "curl"), 0o755);
    const env: Record<string, string | undefined> = {...process.env, HOME:home, SHELL:"/bin/bash", PATH:`${stub}:${join(home, ".local/bin")}:/usr/bin:/bin`};
    delete env.CORGI_PANE;
    const run = () => { const p = Bun.spawnSync(["/bin/sh", "-c", testInstaller()], {env}); return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }; };
    const newer = run();
    expect(newer.code).toBe(0);
    expect(newer.out).toContain("✓ Installed corgi 1.2.4 at ~/.local/bin/corgi (already done)");
    await writeFile(join(root, "current"), "1.2.2");
    const older = run();
    expect(older.code).toBe(1);
    expect(older.out).not.toContain("already done");
    expect(older.err).toMatch(/Couldn't download corgi-\S+: stubbed/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("the launch button gives corgi the terminal device, not /dev/tty", async () => {
  // Bun can't wait for input on /dev/tty on macOS, so a corgi reading it ignores every key.
  const home = await mkdtemp(join(tmpdir(), "corgi launch test "));
  const [master, slave] = pair(true);
  try {
    const root = join(home, ".local/share/corgi"), bin = join(home, ".local/bin/corgi");
    await mkdir(root, { recursive: true }); await mkdir(join(home, ".local/bin"));
    await writeFile(join(root, "current"), "1.2.3"); await writeFile(bin, '#!/bin/sh\necho "stdin is $(tty)."\n'); await chmod(bin, 0o755);
    const env: Record<string, string | undefined> = {...process.env, HOME:home, SHELL:"/bin/bash", TERM:"xterm-256color", PATH:join(home, ".local/bin")+":/usr/bin:/bin"};
    delete env.CORGI_PANE; delete env.NO_COLOR;
    const p = Bun.spawn([`${nativeRoot}/bin/pty-exec`, "/bin/sh", "-c", testInstaller()], {env, stdin:slave, stdout:slave, stderr:slave});
    await readUntil(master, "esc to skip", 10_000);
    write(master, "\r");
    const out = await readUntil(master, ".\r\n", 10_000);
    expect(out).toMatch(/stdin is \/dev\/(ttys\d+|pts\/\d+)\./);
    expect(await p.exited).toBe(0);
  } finally { n.probe_close(master); n.probe_close(slave); await rm(home, { recursive: true, force: true }); }
});

// A home with an installed Corgi, the installer's PATH lines, Ghostty keybindings and saved state.
async function installedHome(name: string) {
  const home = await mkdtemp(join(tmpdir(), `corgi ${name} test `));
  const root = join(home, ".local/share/corgi"), bin = join(home, ".local/bin/corgi");
  await mkdir(join(root, "releases/1.2.3"), { recursive: true }); await mkdir(join(home, ".local/bin"));
  await writeFile(join(root, "current"), "1.2.3"); await writeFile(join(root, "releases/1.2.3/corgi"), "");
  await writeFile(bin, launcher(root)); await chmod(bin, 0o755);
  const path = 'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac';
  await writeFile(join(home, ".bashrc"), `# mine\nalias ll='ls -l'\n\n# Corgi\n${path}\n`);
  await mkdir(join(home, ".config/fish/conf.d"), { recursive: true });
  await writeFile(join(home, ".config/fish/conf.d/corgi.fish"), '\n# Corgi\nfish_add_path "$HOME/.local/bin"\n');
  const ghostty = join(home, "Library/Application Support/com.mitchellh.ghostty/config");
  await mkdir(join(ghostty, ".."), { recursive: true });
  await writeFile(ghostty, "font-size = 13\n# BEGIN CORGI GHOSTTY INTEGRATION\nkeybind = super+t=text:\\x02c\n# END CORGI GHOSTTY INTEGRATION\ntheme = dark\n");
  await mkdir(join(home, ".local/state/corgi"), { recursive: true });
  return { home, root, bin, ghostty };
}
function uninstall(home: string) {
  const env: Record<string, string | undefined> = {...process.env, HOME:home, SHELL:"/bin/bash", PATH:"/usr/bin:/bin"};
  for (const name of ["CORGI_PANE", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "ZDOTDIR", "CORGI_INSTALL_ROOT", "CORGI_INSTALL_BIN"]) delete env[name];
  const p = Bun.spawnSync(["/bin/sh", "-c", testInstaller(), "sh", "uninstall"], {env});
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}
test("uninstall removes what the installer added and keeps saved sessions", async () => {
  const { home, root, bin, ghostty } = await installedHome("uninstall");
  try {
    const first = uninstall(home);
    expect(first.err).toBe("");
    expect(first.code).toBe(0);
    for (const line of ["✓ Removed ~/.local/bin/corgi\n", "✓ Removed ~/.local/share/corgi\n", "✓ Removed ~/.local/bin from PATH in ~/.bashrc and ~/.config/fish/conf.d/corgi.fish\n", "✓ Removed Corgi's keybindings from ~/Library/Application Support/com.mitchellh.ghostty/config", "– Kept saved sessions and settings in ~/.local/state/corgi"]) expect(first.out).toContain(line);
    expect(await Bun.file(bin).exists()).toBe(false);
    expect(await stat(root).catch(() => null)).toBeNull();
    expect(await Bun.file(join(home, ".bashrc")).text()).toBe("# mine\nalias ll='ls -l'\n");
    expect(await Bun.file(join(home, ".config/fish/conf.d/corgi.fish")).exists()).toBe(false);
    expect(await Bun.file(ghostty).text()).toBe("font-size = 13\ntheme = dark\n");
    expect(await stat(join(home, ".local/state/corgi")).catch(() => null)).not.toBeNull();
    const again = uninstall(home);
    expect(again.code).toBe(0);
    for (const line of ["✓ Removed ~/.local/bin/corgi (already done)", "✓ Removed ~/.local/share/corgi (already done)", "✓ Removed ~/.local/bin from PATH (already done)"]) expect(again.out).toContain(line);
    expect(again.out).not.toContain("Ghostty");
  } finally { await rm(home, { recursive: true, force: true }); }
});
test("uninstall keeps ~/.local/bin on PATH while other programs live there", async () => {
  const { home } = await installedHome("shared bin");
  try {
    await writeFile(join(home, ".local/bin/claude"), "");
    const result = uninstall(home);
    expect(result.code).toBe(0);
    expect(result.out).toContain("– Kept ~/.local/bin on PATH for claude");
    expect(await Bun.file(join(home, ".bashrc")).text()).toContain("# Corgi\n");
    expect(await Bun.file(join(home, ".config/fish/conf.d/corgi.fish")).exists()).toBe(true);
  } finally { await rm(home, { recursive: true, force: true }); }
});
test("uninstall refuses while Corgi runs from the install", async () => {
  const { home, root, bin } = await installedHome("running");
  const running = join(root, "releases/1.2.3/corgi");
  await rm(running); await symlink("/bin/sleep", running);
  const p = Bun.spawn([running, "30"]);
  const pane = Bun.spawn(["/bin/sh", "-c", `sleep 30; : ${running}`]);
  try {
    await Bun.sleep(100);
    const result = uninstall(home);
    expect(result.code).toBe(1);
    expect(result.err).toContain(`Corgi is running from ~/.local/share/corgi (PIDs ${p.pid}).`);
    expect(await Bun.file(bin).exists()).toBe(true);
  } finally { p.kill(); pane.kill(); await rm(home, { recursive: true, force: true }); }
});
