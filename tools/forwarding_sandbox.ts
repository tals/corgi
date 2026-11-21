#!/usr/bin/env bun
/**
 * The forwarding sandbox's machine, `devbox`: a second Corgi on this computer,
 * which the sandbox's viewer reaches through a fake `ssh` (see
 * sandboxes/forwarding.ts), and the programs its panes run.
 *
 * Devbox's servers listen `offset` ports above the ones they print, and the
 * fake `ssh -W` adds it back, so this computer's own ports stay as free as
 * they would be with devbox elsewhere.
 *
 *   serve DIR EXE   start devbox and its workspace, then this computer's docs
 *                   server and the sign-in provider; ends when devbox does
 *   app             devbox's dev server (5173) and docs (4321)
 *   signin DIR      a CLI sign-in that opens its page through $BROWSER and
 *                   waits on a localhost callback (1455)
 *   relay PORT      `ssh -W`'s end on devbox: stdio to the port there
 */
import { connect, createServer } from "node:net";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { networkInterfaces } from "node:os";
import { randomUUID } from "node:crypto";

export const offset = 20_000;
export const ports = { app: 5173, docs: 4321, callback: 1455, auth: 8711 } as const;
/** Where devbox keeps its Corgi: its HOME, state and socket. */
export function devbox(dir: string) {
  const root = join(dir, "devbox");
  return {
    root,
    home: join(root, "home"),
    socket: join(root, "run", "control.sock"),
    state: join(root, "state"),
    env: join(root, "env"),
    /** The sign-in provider's address, for the sign-in CLI. */
    auth: join(root, "auth-url"),
  };
}
/** The environment devbox's Corgi and the commands run on it have. */
export function devboxEnv(dir: string, base: Record<string, string | undefined> = process.env) {
  const box = devbox(dir);
  const env: Record<string, string | undefined> = {
    ...base,
    HOME: box.home,
    CORGI_SOCKET: box.socket,
    XDG_STATE_HOME: box.state,
    CORGI_ENV_DIR: box.env,
  };
  for (const key of ["CORGI_PANE", "CORGI_VIEWER", "CORGI_MACHINE", "CORGI_BIN", "BROWSER", "CORGI_HOST_BROWSER"])
    delete env[key];
  return env;
}

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`,
  bold = (text: string) => `\x1b[1m${text}\x1b[0m`,
  green = (text: string) => `\x1b[32m${text}\x1b[0m`,
  cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;

function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html><meta charset=utf-8><title>${title}</title>` +
      `<body style="font:16px/1.5 system-ui;max-width:40em;margin:4em auto;padding:0 1em">${body}</body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
const escape = (text: string) => text.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

/** A server on devbox's `port`, which listens `offset` above it. */
function serveOn(port: number, name: string, handle: (request: Request, url: URL) => Response) {
  let count = 0;
  Bun.serve({
    hostname: "127.0.0.1",
    port: port + offset,
    fetch(request) {
      const url = new URL(request.url);
      count++;
      process.stdout.write(
        dim(`  ${new Date().toLocaleTimeString()}  ${name}  ${request.method} ${url.pathname}${url.search}\n`),
      );
      return handle(request, url);
    },
  });
  return () => count;
}

function app(): void {
  const requests = serveOn(ports.app, "app", (request, url) =>
    page(
      "devbox · webapp",
      `<h1>Hello from devbox 👋</h1>` +
        `<p>This page is served on <b>devbox</b>, port ${ports.app}, and reached here through Corgi's forward.</p>` +
        `<table><tr><td>Host</td><td><code>${escape(request.headers.get("host") ?? "")}</code></td></tr>` +
        `<tr><td>Path</td><td><code>${escape(url.pathname + url.search)}</code></td></tr>` +
        `<tr><td>Requests</td><td>${requests()}</td></tr></table>` +
        `<p><a href="/dashboard?tab=metrics#top">Dashboard</a> · <a href="/">Home</a></p>`,
    ),
  );
  serveOn(ports.docs, "docs", (_request, url) =>
    page(
      "devbox · docs",
      `<h1>devbox docs</h1><p>Served on devbox at port ${ports.docs}. This computer has its own server on ` +
        `${ports.docs}, so the forward took the next port up.</p><p><code>${escape(url.pathname)}</code></p>`,
    ),
  );
  process.stdout.write(
    [
      "",
      `  ${bold(green("VITE"))} ${green("v6.0.0")}  ${dim("ready in 312 ms")}`,
      "",
      `  ${green("➜")}  ${bold("Local")}:   ${cyan(`http://localhost:${ports.app}/`)}`,
      `  ${green("➜")}  ${bold("Network")}: ${dim("use --host to expose")}`,
      "",
      `  ${dim("also")}     http://127.0.0.1:${ports.app}/dashboard?tab=metrics#top`,
      `  ${dim("wildcard")} http://0.0.0.0:${ports.app}/`,
      `  ${dim("docs")}     http://localhost:${ports.docs}/guide/intro`,
      "",
    ].join("\n"),
  );
}

async function signin(dir: string): Promise<void> {
  const callback = `http://localhost:${ports.callback}/auth/callback`;
  let waiting: { state: string; done: () => void } | null = null;
  Bun.serve({
    hostname: "127.0.0.1",
    port: ports.callback + offset,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/auth/callback" || !waiting || url.searchParams.get("state") !== waiting.state)
        return page("Sandbox Cloud", "<p>Nothing is waiting for this sign-in.</p>");
      waiting.done();
      return page("Sandbox Cloud", "<h1>Signed in ✓</h1><p>You can close this tab and go back to the terminal.</p>");
    },
  });
  const lines = console[Symbol.asyncIterator]();
  for (;;) {
    process.stdout.write(`\n  ${bold("sandbox-cloud login")}\n  Press Enter to sign in. `);
    await lines.next();
    const state = randomUUID().slice(0, 8),
      base = existsSync(devbox(dir).auth)
        ? readFileSync(devbox(dir).auth, "utf8").trim()
        : `http://localhost:${ports.auth}`,
      url = `${base}/authorize?client_id=corgi-sandbox&redirect_uri=${encodeURIComponent(callback)}&state=${state}`;
    process.stdout.write(`\n  Opening your browser. If it doesn't open, open this link:\n  ${url}\n\n`);
    const done = new Promise<void>(resolve => (waiting = { state, done: resolve }));
    if (process.env.BROWSER)
      Bun.spawn(["/bin/sh", "-c", '$BROWSER "$1"', "sh", url], { stdio: ["ignore", "inherit", "inherit"] });
    else process.stdout.write(dim("  (no BROWSER here)\n"));
    process.stdout.write(dim(`  Waiting for the browser to come back to localhost:${ports.callback}…\n`));
    await done;
    waiting = null;
    process.stdout.write(`  ${green("✓")} Signed in as ${bold("sandbox@example.com")}\n`);
  }
}

function relay(port: number): void {
  const socket = connect({ host: "127.0.0.1", port: port + offset });
  socket.once("error", () => {
    process.stderr.write("channel 0: open failed: connect failed: Connection refused\nstdio forwarding failed\n");
    process.exit(255);
  });
  socket.once("connect", () => {
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  });
  socket.once("close", () => process.exit(0));
}

/** A non-loopback address of this computer, which a link from devbox reaches as it is. */
function lanAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces()))
    for (const a of addresses ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  return null;
}

async function serve(dir: string, exe: string): Promise<void> {
  const box = devbox(dir),
    env = devboxEnv(dir);
  mkdirSync(dirname(box.socket), { recursive: true, mode: 0o700 });
  mkdirSync(box.home, { recursive: true });
  // devbox's own prompt, so its shells say where they run.
  writeFileSync(join(box.home, ".zshrc"), "PROMPT='%F{magenta}devbox%f %1~ %# '\nbindkey -e\n");
  writeFileSync(join(box.home, ".bashrc"), "PS1='devbox \\W $ '\n");
  const daemon = Bun.spawn([exe, "serve"], { env, stdout: "ignore", stderr: Bun.file(join(box.root, "server.log")) });
  let info: { bridge?: string } | null = null;
  for (let i = 0; i < 200 && !info; i++) {
    if (daemon.exitCode !== null) throw Error("devbox's Corgi exited; see devbox/server.log");
    const out = Bun.spawnSync([exe, "__remote-info"], { env });
    if (out.exitCode === 0) info = JSON.parse(out.stdout.toString());
    else await Bun.sleep(50);
  }
  if (!info) throw Error("devbox's Corgi didn't start");
  const corgi = (args: string[]) =>
    JSON.parse(Bun.spawnSync([exe, ...args, "--json"], { env }).stdout.toString()).result;
  // A devbox that comes back keeps the tabs it had.
  if (!(corgi(["workspace", "list"])?.workspaces ?? []).some((w: any) => w.model?.tabs?.length)) {
    const cwd = join(box.home, "webapp");
    mkdirSync(cwd, { recursive: true });
    const made = corgi(["workspace", "new", "webapp", "--cwd", cwd]);
    corgi(["tab", "rename", String(made.tab), "shell"]);
    const tab = (name: string, command: string) =>
      corgi(["tab", "new", "--workspace", String(made.workspace), "--name", name, "--cwd", cwd, "--command", command]);
    const self = [process.execPath, import.meta.path].map(arg => `'${arg}'`).join(" ");
    const server = tab("dev server", `${self} app`);
    tab("sign in", `${self} signin '${dir}'`);
    corgi(["tab", "move", String(made.tab), "--after", String(server.tab)]);
  }
  for (const w of corgi(["workspace", "list"])?.workspaces ?? [])
    if (!w.model?.tabs?.length) corgi(["workspace", "close", String(w.id)]);
  // This computer's own server on the docs port, which a forward of devbox's must step around.
  Bun.serve({
    hostname: "127.0.0.1",
    port: ports.docs,
    fetch: () => page("this computer's docs", `<h1>This computer's own server on ${ports.docs}</h1>`),
  });
  // The sign-in provider, reached as it is, not forwarded: as a real one on the internet.
  const lan = lanAddress(),
    provider = (request: Request) => {
      const url = new URL(request.url),
        back = url.searchParams.get("redirect_uri") ?? "",
        state = url.searchParams.get("state") ?? "";
      if (url.pathname === "/continue")
        return Response.redirect(
          `${back}?code=sandbox-${randomUUID().slice(0, 6)}&state=${encodeURIComponent(state)}`,
          302,
        );
      return page(
        "Sign in to Sandbox Cloud",
        `<h1>Sign in to Sandbox Cloud</h1><p>Signing in as <b>sandbox@example.com</b>.</p>` +
          `<p>Continuing sends your browser back to <code>${escape(back)}</code>, the CLI on devbox.</p>` +
          `<p><a href="/continue?redirect_uri=${encodeURIComponent(back)}&state=${encodeURIComponent(state)}"` +
          ` style="font-size:1.2em">Continue →</a></p>`,
      );
    };
  if (lan) Bun.serve({ hostname: lan, port: ports.auth, fetch: provider });
  // Without one, a link to it is devbox's localhost and goes through a forward too.
  Bun.serve({ hostname: "127.0.0.1", port: ports.auth + offset, fetch: provider });
  writeFileSync(box.auth, lan ? `http://${lan}:${ports.auth}` : `http://localhost:${ports.auth}`);
  const catalog = join(process.env.XDG_STATE_HOME!, "corgi/remote/machines.json");
  mkdirSync(dirname(catalog), { recursive: true, mode: 0o700 });
  writeFileSync(
    catalog,
    JSON.stringify({
      version: 1,
      machines: [
        { name: "devbox", target: "devbox", executable: exe, socket: box.socket, home: box.home, bridge: info.bridge },
      ],
    }),
    { mode: 0o600 },
  );
  console.log(
    `devbox is up: a second Corgi here, its ports ${offset} up. This computer serves its own docs on ${ports.docs}.`,
  );
  console.log(dim("Keep this tab open; --restart rebuilds devbox."));
  await daemon.exited;
  console.log("devbox's Corgi exited.");
  process.exit(0);
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "serve":
      try {
        await serve(args[0], args[1]);
      } catch (error) {
        // The tab stays to say why; the log keeps it for the sandbox's own message.
        const text = `devbox didn't start: ${error instanceof Error ? (error.stack ?? error.message) : error}\n`;
        writeFileSync(join(devbox(args[0]).root, "supervisor.log"), text);
        process.stderr.write(text + "Press Enter to close.\n");
        for await (const _ of console) break;
        process.exit(1);
      }
      break;
    case "app":
      app();
      break;
    case "signin":
      await signin(args[0]);
      break;
    case "relay":
      relay(Number(args[0]));
      break;
    default:
      console.error("usage: forwarding_sandbox.ts serve DIR EXE | app | signin DIR | relay PORT");
      process.exit(2);
  }
}
