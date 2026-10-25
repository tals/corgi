import { mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve("gui-artifacts"),
  executable = resolve("dist/corgi-test");
const fixture = resolve("tools/ci/macos_terminal_fixture.ts"),
  capture = resolve("tools/ci/macos_capture.swift");
mkdirSync(root, { recursive: true });
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
async function run(args: string[], timeout = 30000, env = process.env) {
  const p = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill("SIGKILL"), timeout);
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}
async function checked(args: string[]) {
  const result = await run(args);
  if (result.code) throw Error(`${args[0]} exited ${result.code}: ${result.stderr}`);
  return result.stdout;
}
async function waitFor(check: () => boolean | Promise<boolean>, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await Bun.sleep(200);
  }
  throw Error("Timed out waiting for terminal readiness");
}

await Bun.write(
  join(root, "environment.json"),
  JSON.stringify(
    {
      macOS: await run(["sw_vers"]),
      console: await run(["stat", "-f", "%Su", "/dev/console"]),
      display: await run(["system_profiler", "SPDisplaysDataType"]),
      initialWindows: await run(["swift", capture]),
    },
    null,
    2,
  ),
);

const results = [];
for (const terminal of ["ghostty", "iterm2"]) {
  const dir = join(root, terminal);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const app = terminal === "ghostty" ? "/Applications/Ghostty.app" : "/Applications/iTerm.app";
  const processName = terminal === "ghostty" ? "ghostty" : "iTerm2";
  const result: Record<string, unknown> = { terminal, app };
  try {
    result.version = await checked(["defaults", "read", join(app, "Contents/Info"), "CFBundleShortVersionString"]);
    const command = [process.execPath, fixture, dir, terminal, executable];
    if (terminal === "ghostty") {
      await checked([
        "open",
        "-na",
        app,
        "--args",
        "--font-family=Menlo",
        "--font-size=14",
        "--window-width=100",
        "--window-height=30",
        "-e",
        ...command,
      ]);
    } else {
      const guid = "41a23afe-c40e-4c01-aede-7f4338e47b63";
      const profile = join(dir, "preferences.json");
      await Bun.write(
        profile,
        JSON.stringify({
          "New Bookmarks": [
            {
              Guid: guid,
              Name: "Corgi CI",
              "Custom Command": "Yes",
              Command: command.map(quote).join(" "),
              Rows: 30,
              Columns: 100,
              "Normal Font": "Menlo 14",
              Transparency: 0,
            },
          ],
          "Default Bookmark Guid": guid,
          PromptOnQuit: false,
          SUEnableAutomaticChecks: false,
        }),
      );
      await checked(["plutil", "-convert", "xml1", profile]);
      await checked(["defaults", "import", "com.googlecode.iterm2", profile]);
      await checked(["open", "-na", app]);
    }
    await waitFor(() => existsSync(join(dir, "ready")));
    const info = JSON.parse(await checked(["swift", capture]));
    await Bun.write(join(dir, "windows.json"), JSON.stringify(info, null, 2));
    const owner = terminal === "ghostty" ? /ghostty/i : /iterm/i;
    const window = info.windows.find(
      (w: { kCGWindowOwnerName: string; kCGWindowLayer: number; kCGWindowBounds: { Width: number } }) =>
        owner.test(w.kCGWindowOwnerName) && w.kCGWindowLayer === 0 && w.kCGWindowBounds.Width > 300,
    );
    if (!window) throw Error("No terminal window was visible to CoreGraphics");
    result.screenCaptureAllowed = info.screenCaptureAllowed;
    result.windowId = window.kCGWindowNumber;
    const screenshot = join(dir, "graphics.png");
    await checked(["screencapture", "-x", "-o", "-l", String(window.kCGWindowNumber), screenshot]);
    const pixels = JSON.parse(await checked(["swift", capture, "inspect", screenshot]));
    result.pixels = pixels;
    if (pixels.magentaSamples < 100) throw Error("Screenshot did not contain the raster test image");
    await Bun.write(join(dir, "continue"), "continue");
    await waitFor(() => existsSync(join(dir, "corgi-started")));
    await waitFor(async () => {
      const response = await run([executable, "rpc", '{"op":"bugreport"}'], 3000, {
        ...process.env,
        CORGI_SOCKET: join(dir, "control.sock"),
      });
      await Bun.write(join(dir, "corgi-report-attempt.json"), JSON.stringify(response));
      return response.code === 0 && response.stdout.includes("this viewer");
    }, 10000);
    await checked(["screencapture", "-x", "-o", "-l", String(window.kCGWindowNumber), join(dir, "corgi.png")]);
    result.ok = true;
  } catch (error) {
    result.ok = false;
    result.error = String(error);
    await Bun.write(join(dir, "failure-windows.json"), JSON.stringify(await run(["swift", capture])));
    result.desktopCapture = await run(["screencapture", "-x", join(dir, "desktop.png")]);
  } finally {
    await run(["pkill", "-x", processName]);
    await Bun.sleep(300);
  }
  results.push(result);
  await Bun.write(join(root, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(result));
}
if (results.some(r => !r.ok)) process.exitCode = 1;
