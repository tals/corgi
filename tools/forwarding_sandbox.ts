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
 *                   server; ends when devbox does
 *   app             devbox's dev server (5173) and docs (4321)
 *   relay PORT      `ssh -W`'s end on devbox: stdio to the port there
 */
import { connect, createServer } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { shellQuote } from "../src/os";

export const offset = 20_000;
export const ports = { app: 5173, docs: 4321 } as const;
/** Where devbox keeps its Corgi: its HOME, state and socket. */
export function devbox(dir: string) {
  const root = join(dir, "devbox");
  return {
    root,
    home: join(root, "home"),
    socket: join(root, "run", "control.sock"),
    state: join(root, "state"),
    env: join(root, "env"),
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

async function serve(dir: string, exe: string): Promise<void> {
  const box = devbox(dir),
    env = devboxEnv(dir);
  mkdirSync(dirname(box.socket), { recursive: true, mode: 0o700 });
  mkdirSync(box.home, { recursive: true });
  // devbox's own prompt, so its shells say where they run.
  writeFileSync(join(box.home, ".zshrc"), "PROMPT='%F{magenta}devbox%f %1~ %# '\nbindkey -e\n");
  writeFileSync(join(box.home, ".bashrc"), "PS1='devbox \\W $ '\n");
  // Corgi sets its panes' BROWSER only on Linux; devbox plays one here.
  const helper = join(box.home, "bin", "corgi-browser");
  mkdirSync(dirname(helper), { recursive: true });
  writeFileSync(helper, `#!/bin/sh\nexec ${shellQuote(exe)} __browser "$@"\n`, { mode: 0o700 });
  const daemon = Bun.spawn([exe, "serve"], {
    env: { ...env, BROWSER: helper },
    stdout: "ignore",
    stderr: Bun.file(join(box.root, "server.log")),
  });
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
    case "relay":
      relay(Number(args[0]));
      break;
    default:
      console.error("usage: forwarding_sandbox.ts serve DIR EXE | app | relay PORT");
      process.exit(2);
  }
}
