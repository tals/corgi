import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
/** An executable that appends its arguments, and the BROWSER it was given, to `log`. */
function recorder(path: string, log: string, status = 0): void {
  writeFileSync(
    path,
    `#!/bin/sh\necho "$(basename "$0") $* \${BROWSER:-}" >> ${JSON.stringify(log)}\nexit ${status}\n`,
  );
  chmodSync(path, 0o755);
}
const refused = async () => {
  throw Error("NoViewer");
};
/** The system's opener's name here. */
const opener = process.platform === "darwin" ? "open" : "xdg-open";

test("BROWSER names a helper that runs Corgi", () => {
  expect(paneBrowser.script("/opt/corgi/bin/corgi")).toBe(`#!/bin/sh\nexec '/opt/corgi/bin/corgi' __browser "$@"\n`);
});

test("a link goes to the viewer showing the pane, or else where it would have gone", async () => {
  const asked: [string, number][] = [];
  const ask = async (url: string, pane: number) => {
    asked.push([url, pane]);
  };
  expect(await paneBrowser.run(["https://example.com/"], ask, { CORGI_PANE: "7" })).toBe(0);
  expect(asked).toEqual([["https://example.com/", 7]]);
  const tools = folder(),
    log = join(tools, "log");
  recorder(join(tools, "w3m"), log);
  const env = { PATH: `${tools}:/usr/bin:/bin`, [paneBrowser.original]: "w3m" };
  // Once no viewer took it; and outside a pane, where no viewer is asked.
  expect(await paneBrowser.run(["http://localhost:3000/"], refused, { ...env, CORGI_PANE: "7" })).toBe(0);
  expect(await paneBrowser.run(["https://a.example/"], ask, env)).toBe(0);
  expect(asked.length).toBe(1);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
    "w3m http://localhost:3000/ w3m",
    "w3m https://a.example/ w3m",
  ]);
});

test("a link no viewer takes goes to the pane's own BROWSER, the link at %s or last", async () => {
  const tools = folder(),
    log = join(tools, "log");
  recorder(join(tools, "firefox"), log, 1);
  recorder(join(tools, "lynx"), log);
  const browsers = "firefox --new-tab:lynx -dump %s";
  const env = { CORGI_PANE: "3", PATH: `${tools}:/usr/bin:/bin`, [paneBrowser.original]: browsers };
  expect(await paneBrowser.run(["https://example.com/x"], refused, env)).toBe(0);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
    `firefox --new-tab https://example.com/x ${browsers}`,
    `lynx -dump https://example.com/x ${browsers}`,
  ]);
});

test("a link the pane's own BROWSER can't open goes to the system's opener, else it's printed", async () => {
  const tools = folder(),
    log = join(tools, "log");
  recorder(join(tools, "w3m"), log, 1);
  recorder(join(tools, opener), log, 1);
  const env = { CORGI_PANE: "7", PATH: `${tools}:/usr/bin:/bin`, [paneBrowser.original]: "w3m" };
  expect(await paneBrowser.run(["https://a.example/"], refused, env)).toBe(1);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
    "w3m https://a.example/ w3m",
    `${opener} https://a.example/ w3m`,
  ]);
});

test("on Linux with no browser of its own, the helper goes beside an installed launcher, else beside the socket, and BROWSER names it", () => {
  const install = folder(),
    cli = join(install, "bin", "corgi"),
    runtime = folder(),
    socket = join(runtime, "control.sock");
  // A Corgi xdg-open an earlier build left there goes; another stays.
  mkdirSync(join(install, "bin"), { mode: 0o700 });
  writeFileSync(join(install, "bin", "xdg-open"), "#!/bin/sh\n# corgi-xdg-open\n");
  expect(paneBrowser.install(cli, "/opt/releases/1/corgi", socket, {}, "linux")).toBe(join(install, "bin"));
  expect(existsSync(join(install, "bin", "xdg-open"))).toBe(false);
  expect(statSync(join(install, "bin", paneBrowser.helper)).mode & 0o777).toBe(0o700);
  expect(paneBrowser.install("/opt/dev/dist/corgi", "/opt/dev/dist/corgi", socket, {}, "linux")).toBe(
    `${socket}.browser`,
  );
  expect(readFileSync(join(`${socket}.browser`, paneBrowser.helper), "utf8")).toContain(
    "'/opt/dev/dist/corgi' __browser",
  );
  writeFileSync(join(`${socket}.browser`, "xdg-open"), '#!/bin/sh\nexec /usr/bin/xdg-open "$@"\n');
  paneBrowser.install("/opt/dev/dist/corgi", "/opt/dev/dist/corgi", socket, {}, "linux");
  expect(existsSync(join(`${socket}.browser`, "xdg-open"))).toBe(true);
  // Not on macOS, where tools open BROWSER as an application.
  expect(paneBrowser.install(cli, "/opt/releases/1/corgi", socket, {}, "darwin")).toBeNull();
  // Nor on a Linux desktop, whose programs open links on its own screen; reached over SSH, it has none.
  expect(paneBrowser.install(cli, "/opt/releases/1/corgi", socket, { DISPLAY: ":0" }, "linux")).toBeNull();
  expect(
    paneBrowser.install(cli, "/opt/releases/1/corgi", socket, { DISPLAY: ":0", SSH_CONNECTION: "a 1 b 2" }, "linux"),
  ).toBe(join(install, "bin"));
  // Nowhere beside a socket with no folder of its own.
  expect(paneBrowser.install("/opt/dev/dist/corgi", "/opt/dev/dist/corgi", "", {}, "linux")).toBeNull();
  // The daemon's own BROWSER stays for links no viewer takes, unless it's the helper itself.
  const helpers = join(install, "bin");
  expect(paneBrowser.environment(helpers, { BROWSER: "w3m" })).toEqual({
    BROWSER: join(helpers, paneBrowser.helper),
    [paneBrowser.original]: "w3m",
  });
  expect(
    paneBrowser.environment(helpers, { BROWSER: join(helpers, paneBrowser.helper), [paneBrowser.original]: "w3m" })[
      paneBrowser.original
    ],
  ).toBe("w3m");
  // Nor is the helper kept in a list a shell added to.
  expect(
    paneBrowser.environment(helpers, { BROWSER: `${join(helpers, paneBrowser.helper)}:w3m` })[paneBrowser.original],
  ).toBe("w3m");
});

test("what Corgi passes a link on to gets the pane's own BROWSER, so an opener reading it doesn't come back", () => {
  const helper = `/opt/corgi/bin/${paneBrowser.helper}`;
  expect(paneBrowser.handed({ BROWSER: helper, [paneBrowser.original]: "w3m" }).BROWSER).toBe("w3m");
  expect(paneBrowser.handed({ BROWSER: helper }).BROWSER).toBeUndefined();
  expect(paneBrowser.handed({ BROWSER: `${helper}:w3m` }).BROWSER).toBe("w3m");
  expect(paneBrowser.handed({ BROWSER: "firefox" }).BROWSER).toBe("firefox");
});

test("a link no viewer takes never goes back to Corgi's helper, even one in the pane's own BROWSER", async () => {
  const tools = folder(),
    log = join(tools, "log");
  recorder(join(tools, paneBrowser.helper), log);
  recorder(join(tools, "w3m"), log);
  const env = {
    CORGI_PANE: "7",
    PATH: `${tools}:/usr/bin:/bin`,
    [paneBrowser.original]: `${join(tools, paneBrowser.helper)} --new:w3m`,
  };
  expect(await paneBrowser.run(["https://a.example/"], refused, env)).toBe(0);
  expect(readFileSync(log, "utf8").trim()).toBe("w3m https://a.example/ w3m");
});

test("a viewer opens links where it has a browser: not over SSH, and on Linux with a display", async () => {
  const { opensLinks } = await import("./web_links");
  expect(opensLinks({}, "darwin")).toBe(true);
  expect(opensLinks({ SSH_CONNECTION: "1 2 3 4" }, "darwin")).toBe(false);
  expect(opensLinks({}, "linux")).toBe(false);
  expect(opensLinks({ DISPLAY: ":0" }, "linux")).toBe(true);
  expect(opensLinks({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(true);
  expect(opensLinks({ WSL_DISTRO_NAME: "Ubuntu" }, "linux")).toBe(true);
  expect(opensLinks({ DISPLAY: ":0", SSH_TTY: "/dev/pts/1" }, "linux")).toBe(false);
});
