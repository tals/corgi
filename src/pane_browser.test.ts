import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as paneBrowser from "./pane_browser";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
function folder(): string {
  const path = mkdtempSync(join(tmpdir(), "corgi-browser-test-"));
  folders.push(path);
  return path;
}
/** An executable that appends its arguments, and whether it was passed through, to `log`. */
function recorder(path: string, log: string, status = 0): void {
  writeFileSync(
    path,
    `#!/bin/sh\necho "$(basename "$0") $* ${"$"}{${paneBrowser.passthrough}:-}" >> ${JSON.stringify(log)}\nexit ${status}\n`,
  );
  chmodSync(path, 0o755);
}

test("BROWSER names the helper everywhere; Linux also gets an xdg-open ahead of the system's", () => {
  const mac = paneBrowser.scripts("/opt/corgi/bin/corgi", "darwin"),
    linux = paneBrowser.scripts("/opt/corgi/bin/corgi", "linux");
  expect(Object.keys(mac)).toEqual([paneBrowser.helper]);
  expect(mac[paneBrowser.helper]).toBe(`#!/bin/sh\nexec '/opt/corgi/bin/corgi' __browser "$@"\n`);
  expect(Object.keys(linux).sort()).toEqual([paneBrowser.helper, "xdg-open"]);
});

test("a pane's xdg-open hands one web link to Corgi, and anything else to the system's", () => {
  const helpers = folder(),
    system = folder(),
    log = join(folder(), "log");
  recorder(join(helpers, "corgi"), log);
  recorder(join(system, "xdg-open"), log);
  const shim = join(helpers, "xdg-open");
  writeFileSync(shim, paneBrowser.scripts(join(helpers, "corgi"), "linux")["xdg-open"]);
  chmodSync(shim, 0o755);
  const run = (args: string[], env: Record<string, string> = {}) =>
    Bun.spawnSync(["xdg-open", ...args], { env: { PATH: `${helpers}:${system}:/usr/bin:/bin`, ...env } });
  expect(run(["https://example.com/a?b=1"]).exitCode).toBe(0);
  expect(run(["/tmp/report.pdf"]).exitCode).toBe(0);
  expect(run(["https://example.com", "extra"]).exitCode).toBe(0);
  expect(run(["http://localhost:3000"], { [paneBrowser.passthrough]: "1" }).exitCode).toBe(0);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
    `corgi __browser --via ${shim} https://example.com/a?b=1 `,
    "xdg-open /tmp/report.pdf ",
    "xdg-open https://example.com extra ",
    "xdg-open http://localhost:3000 1",
  ]);
  // With no system one, it says so.
  const alone = Bun.spawnSync(["xdg-open", "/tmp/x"], { env: { PATH: `${helpers}:/usr/bin:/bin` } });
  expect(alone.exitCode).toBe(existsSync("/usr/bin/xdg-open") ? alone.exitCode : 3);
});

test("a link goes to the viewer showing the pane, or else where it would have gone", async () => {
  const asked: [string, number][] = [];
  const ask = async (url: string, pane: number) => {
    asked.push([url, pane]);
  };
  expect(await paneBrowser.run(["https://example.com/"], ask, { CORGI_PANE: "7" })).toBe(0);
  expect(asked).toEqual([["https://example.com/", 7]]);
  // Through the stood-in xdg-open, once no viewer took it.
  const tools = folder(),
    log = join(tools, "log"),
    via = join(tools, "xdg-open");
  recorder(via, log);
  const refused = async () => {
    throw Error("NoViewer");
  };
  expect(await paneBrowser.run(["--via", via, "http://localhost:3000/"], refused, { CORGI_PANE: "7" })).toBe(0);
  // Outside a pane, or passed through, the viewer isn't asked.
  expect(await paneBrowser.run(["--via", via, "https://a.example/"], ask, {})).toBe(0);
  expect(
    await paneBrowser.run(["--via", via, "https://b.example/"], ask, {
      CORGI_PANE: "7",
      [paneBrowser.passthrough]: "1",
    }),
  ).toBe(0);
  expect(asked.length).toBe(1);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
    "xdg-open http://localhost:3000/ 1",
    "xdg-open https://a.example/ 1",
    "xdg-open https://b.example/ 1",
  ]);
});

test("a link no viewer takes goes to the pane's own BROWSER, the link at %s or last", async () => {
  const tools = folder(),
    log = join(tools, "log");
  recorder(join(tools, "firefox"), log, 1);
  recorder(join(tools, "lynx"), log);
  const refused = async () => {
    throw Error("NoViewer");
  };
  const env = {
    CORGI_PANE: "3",
    PATH: `${tools}:/usr/bin:/bin`,
    [paneBrowser.original]: "firefox --new-tab:lynx -dump %s",
  };
  expect(await paneBrowser.run(["https://example.com/x"], refused, env)).toBe(0);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
    "firefox --new-tab https://example.com/x 1",
    "lynx -dump https://example.com/x 1",
  ]);
});

test("helpers go beside an installed launcher, else beside the socket, and BROWSER names them", () => {
  const install = folder(),
    cli = join(install, "bin", "corgi"),
    runtime = folder(),
    socket = join(runtime, "control.sock");
  expect(paneBrowser.install(cli, "/opt/releases/1/corgi", socket)).toBe(join(install, "bin"));
  expect(statSync(join(install, "bin", paneBrowser.helper)).mode & 0o777).toBe(0o700);
  expect(paneBrowser.install("/opt/dev/dist/corgi", "/opt/dev/dist/corgi", socket)).toBe(`${socket}.browser`);
  expect(readFileSync(join(`${socket}.browser`, paneBrowser.helper), "utf8")).toContain(
    "'/opt/dev/dist/corgi' __browser",
  );
  // Nowhere beside a socket with no folder of its own.
  expect(paneBrowser.install("/opt/dev/dist/corgi", "/opt/dev/dist/corgi", "")).toBeNull();
  // The daemon's own BROWSER stays for links no viewer takes, unless it's the helper itself.
  const helpers = join(install, "bin");
  expect(paneBrowser.environment(helpers, { BROWSER: "w3m" })).toEqual({
    BROWSER: join(helpers, paneBrowser.helper),
    [paneBrowser.original]: "w3m",
    [paneBrowser.passthrough]: undefined,
  });
  expect(
    paneBrowser.environment(helpers, { BROWSER: join(helpers, paneBrowser.helper), [paneBrowser.original]: "w3m" })[
      paneBrowser.original
    ],
  ).toBe("w3m");
});
