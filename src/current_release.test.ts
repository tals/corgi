import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as current_release from "./current_release";
/** An installation whose releases print their version and arguments. */
function installation(versions: string[], current: string): string {
  const root = mkdtempSync(join(tmpdir(), "corgi current-'release-"));
  for (const v of versions) {
    mkdirSync(join(root, "releases", v), { recursive: true });
    writeFileSync(join(root, "releases", v, "corgi"), `#!/bin/sh\necho ${v} "$@"\n`, { mode: 0o700 });
  }
  writeFileSync(join(root, "current"), current);
  return root;
}
const run = (bin: string, ...args: string[]) => {
  const p = Bun.spawnSync([bin, ...args], { stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};
test("an installed release gets a fixed path that runs the current release", () => {
  const root = installation(["1.0.0", "1.0.1"], "1.0.0");
  try {
    const bin = current_release.path(join(root, "releases/1.0.0/corgi"));
    expect(bin).toBe(join(root, "bin/corgi"));
    expect(run(bin, "a b", "c").out).toBe("1.0.0 a b c\n");
    writeFileSync(join(root, "current"), "1.0.1");
    expect(run(bin).out).toBe("1.0.1\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("the script refuses a version that isn't one", () => {
  const root = installation(["1.0.0"], "../1.0.0");
  try {
    const result = run(current_release.path(join(root, "releases/1.0.0/corgi")));
    expect(result.code).toBe(1);
    expect(result.err).toBe("Invalid Corgi version\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("a script that lost its mode or text is written again", () => {
  const root = installation(["1.0.0"], "1.0.0"),
    exe = join(root, "releases/1.0.0/corgi");
  try {
    const bin = current_release.path(exe),
      text = readFileSync(bin, "utf8");
    chmodSync(bin, 0o600);
    current_release.path(exe);
    expect(statSync(bin).mode & 0o777).toBe(0o700);
    writeFileSync(bin, "#!/bin/sh\n");
    current_release.path(exe);
    expect(readFileSync(bin, "utf8")).toBe(text);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("a build outside an installation is its own path", () => {
  expect(current_release.path("/opt/corgi/dist/corgi")).toBe("/opt/corgi/dist/corgi");
  const root = installation(["1.0.0"], "1.0.0");
  try {
    rmSync(join(root, "current"));
    expect(current_release.path(join(root, "releases/1.0.0/corgi"))).toBe(join(root, "releases/1.0.0/corgi"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
