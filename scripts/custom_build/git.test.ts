import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runs `body` in its own process with `git` imported; its exit code and output. */
function inProcess(body: string) {
  const script = `
    const git = await import(${JSON.stringify(join(import.meta.dir, "git.ts"))});
    ${body}
  `;
  const p = Bun.spawnSync(["bun", "-e", script], { stdout: "pipe", stderr: "pipe", cwd: import.meta.dir });
  return { code: p.exitCode, out: p.stdout.toString() };
}

test("a git call killed by a signal stops the process right there", () => {
  // Git itself dies of SIGINT, as on a Ctrl-C.
  const killed = inProcess(`
    git.git(process.cwd(), ["-c", "alias.boom=!kill -INT $PPID", "boom"]);
    console.log("went on");
  `);
  expect(killed).toEqual({ code: 130, out: "" });
  // What git runs dies of SIGINT, and git exits with 130.
  const child = inProcess(`
    git.git(process.cwd(), ["-c", "alias.boom=!kill -INT $$", "boom"]);
    console.log("went on");
  `);
  expect(child).toEqual({ code: 130, out: "" });
  const terminated = inProcess(`
    git.git(process.cwd(), ["-c", "alias.boom=!kill -TERM $PPID", "boom"]);
    console.log("went on");
  `);
  expect(terminated).toEqual({ code: 143, out: "" });
});

test("a git call that fails without a signal goes on", () => {
  const failed = inProcess(`
    const out = git.git(process.cwd(), ["-c", "alias.boom=!exit 3", "boom"]);
    console.log("went on", out.code);
  `);
  expect(failed).toEqual({ code: 0, out: "went on 3\n" });
  // Git's usage errors exit with 129, the code a shell gives for SIGHUP.
  const usage = inProcess(`
    const out = git.git(process.cwd(), ["branch", "--no-such-option"]);
    console.log("went on", out.code);
  `);
  expect(usage).toEqual({ code: 0, out: "went on 129\n" });
});

test("a gh call killed by a signal stops the process too", () => {
  const bin = mkdtempSync(join(tmpdir(), "gh-test-"));
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nkill -INT $$\n", { mode: 0o755 });
  const script = `
    const github = await import(${JSON.stringify(join(import.meta.dir, "github.ts"))});
    github.prInfo("tals/corgi", 1, { PATH: ${JSON.stringify(bin)} + ":" + process.env.PATH });
    console.log("went on");
  `;
  const p = Bun.spawnSync(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  expect({ code: p.exitCode, out: p.stdout.toString() }).toEqual({ code: 130, out: "" });
});
