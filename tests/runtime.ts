/** Isolated real Corgi runtime used by the integration scenarios. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXE,
  ROOT,
  TestCase,
  JsonSocket,
  run,
  sleep,
  tempDir,
  quote,
  writeExecutable,
} from "./support";
import { Viewer, pump } from "./viewer_client";
import { NATIVE_PROVIDER, write_ordinary_agent } from "./provider_sim";
export { EXE, ROOT, Viewer };
export const FAKE = NATIVE_PROVIDER;

export function screen_text(data: string, cols = 80, rows = 24): string[] {
  let grid = Array.from({ length: rows }, () => Array(cols).fill(" "));
  let x = 0,
    y = 0,
    i = 0,
    saved = [0, 0];
  while (i < data.length) {
    if (data.startsWith("\x1b7", i)) {
      saved = [x, y];
      i += 2;
      continue;
    }
    if (data.startsWith("\x1b8", i)) {
      [x, y] = saved;
      i += 2;
      continue;
    }
    if (data.startsWith("\x1b]", i)) {
      const match = /^\x1b\].*?(?:\x07|\x1b\\)/s.exec(data.slice(i));
      if (!match) throw new Error("Unterminated OSC");
      i += match[0].length;
      continue;
    }
    if (data[i] === "\x1b") {
      const match = /^\x1b\[([0-9;:?]*)([@-~])/.exec(data.slice(i));
      if (!match)
        throw new Error(
          `Unexpected frame escape ${JSON.stringify(data.slice(i, i + 50))}`,
        );
      const [, args, kind] = match;
      if (kind === "H" || kind === "f") {
        const values = args.split(";").map((v) => Number(v || 1));
        y = values[0] - 1;
        x = (values[1] ?? 1) - 1;
      } else if (kind === "J" && args === "2")
        grid = Array.from({ length: rows }, () => Array(cols).fill(" "));
      i += match[0].length;
      continue;
    }
    const char = String.fromCodePoint(data.codePointAt(i)!);
    if (char === "\r") x = 0;
    else if (char === "\n") y++;
    else if (char >= " ") {
      if (x >= 0 && x < cols && y >= 0 && y < rows) grid[y][x] = char;
      x += /\p{Mark}/u.test(char) ? 0 : Bun.stringWidth(char);
    }
    i += char.length;
  }
  return grid.map((row) => row.join(""));
}
/** The agent list's rows of the sidebar border, where its scrollbar thumb shows. */
export function scrollbar(screen: string[]): string {
  const top = Math.floor((screen.length - 1) / 2) + 2;
  return screen
    .slice(top)
    .map((row) => [...row][27])
    .join("");
}
export function layout_tree(workspace: any, tab = 0): any {
  const model = workspace.model;
  function tree(index: number): any {
    const node = model.nodes[index];
    return "pane" in node
      ? node
      : {
          split: {
            ...node.split,
            first: tree(node.split.first),
            second: tree(node.split.second),
          },
        };
  }
  return tree(model.tabs[tab].root);
}
function running(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
export class Runtime extends TestCase {
  temp!: ReturnType<typeof tempDir>;
  path!: string;
  env!: Record<string, string | undefined>;
  extraEnv: Record<string, string | undefined> = {};
  client: Viewer | null = null;
  viewers: Viewer[] = [];
  proc: any = null;
  pty: any = null;
  private started = false;
  // Private names: subclasses define their own `calls()` and `call()`.
  #calls: JsonSocket | null = null;
  #callsSent = 0;
  #callQueue: Promise<unknown> = Promise.resolve();
  #changes: JsonSocket | null = null;
  async setUp() {
    this.temp = tempDir();
    this.path = join(this.temp.name, "control.sock");
    const fake = writeExecutable(join(this.temp.name, "provider"), FAKE);
    this.env = {
      ...process.env,
      HOME: this.temp.name,
      XDG_STATE_HOME: join(this.temp.name, ".local/state"),
      CODEX_HOME: join(this.temp.name, ".codex"),
      CLAUDE_CONFIG_DIR: join(this.temp.name, ".claude"),
      CORGI_SOCKET: this.path,
      CORGI_BELL: "off",
      CORGI_CODEX_BIN: fake,
      CORGI_CLAUDE_BIN: fake,
      // Test builds look for system installs here instead of /usr, /opt and /Applications.
      CORGI_TEST_SYSTEM_ROOT: join(this.temp.name, "system"),
      SHELL: "/bin/sh",
      // Keep pointer expectations independent of the terminal running Bun.
      TERM_PROGRAM: "ghostty",
    };
    delete this.env.CODEX_THREAD_ID;
    delete this.env.CORGI_PANE;
    Object.assign(this.env, this.extraEnv);
    const preferences = join(this.env.XDG_STATE_HOME!, "corgi/viewer.json");
    mkdirSync(join(preferences, ".."), { recursive: true });
    writeFileSync(preferences, JSON.stringify({ onboarding_complete: true }));
    this.client = null;
    this.viewers = [];
    this.proc = null;
    if (this.configure) await this.configure();
    await this.run_cli("start");
    this.started = true;
  }
  async tearDown() {
    const errors: unknown[] = [];
    for (const viewer of this.viewers ?? [])
      try {
        await viewer.close();
      } catch (error) {
        errors.push(error);
      }
    try {
      if (this.pty) await this.pty.close();
      else if (this.proc && this.proc.exitCode === null) {
        this.proc.kill("SIGKILL");
        await this.proc.exited;
      }
    } catch (error) {
      errors.push(error);
    }
    if (this.env) {
      const log = join(this.temp.name, "server.log");
      if (this.started || existsSync(this.path)) {
        // server.log is complete once the daemon has exited, which is after
        // shutdown returns. It may already be gone.
        const pid = await this.rpc({ op: "hello", protocol: 1 }).then(
          (hello) => hello.server_pid as number,
          () => 0,
        );
        try {
          await this.run_cli("shutdown");
        } catch (error) {
          const tail = existsSync(log)
            ? readFileSync(log, "utf8").split("\n").slice(-40).join("\n")
            : "(no server.log)";
          errors.push(new Error(`${error}\nserver.log tail:\n${tail}`));
        }
        if (pid) await this.until(() => !running(pid), 5).catch(() => {});
      }
      this.#disconnect();
      if (existsSync(log))
        try {
          this.assertNotIn("panic:", readFileSync(log, "utf8"));
        } catch (error) {
          errors.push(error);
        }
    }
    this.temp?.cleanup();
    if (errors.length)
      throw new AggregateError(errors, "Runtime cleanup failed");
  }
  async run_cli(...args: string[]) {
    // A daemon that stops takes the kept connections with it.
    if (args[0] === "shutdown") this.#disconnect();
    return (await run([EXE, ...args], { env: this.env })).stdout;
  }
  #disconnect() {
    this.#calls?.close();
    this.#calls = null;
    this.#changes?.close();
    this.#changes = null;
  }
  /** Resolves when the daemon pushes a changed session, or after `ms`. */
  async #changed(ms: number) {
    const end = performance.now() + ms;
    try {
      if (!this.#changes || this.#changes.closed) {
        const socket = await JsonSocket.connect(this.path);
        // Another wait may have subscribed meanwhile.
        if (this.#changes && !this.#changes.closed) socket.close();
        else {
          socket.send({ op: "session.subscribe", protocol: 1 });
          this.#changes = socket;
        }
      }
      // A push is only a wakeup: skip parsing it, and pushes since the last
      // wait mean the state has already changed.
      const lines = this.#changes.lines;
      if (!lines.discard()) await lines.next(ms);
      return;
    } catch {}
    // No daemon to subscribe to (stopped or restarting): wait out the rest.
    await sleep(Math.max(0, end - performance.now()) / 1000);
  }
  async #connection() {
    // The daemon drops a connection 5 s after its last request; replace it
    // before then so a request never races the close.
    if (
      !this.#calls ||
      this.#calls.closed ||
      performance.now() - this.#callsSent > 4000
    ) {
      this.#disconnect();
      this.#calls = await JsonSocket.connect(this.path);
    }
    this.#callsSent = performance.now();
    return this.#calls;
  }
  /** Like `corgi rpc`: a reply with `err` throws. Calls share one kept connection, in order. */
  #call(value: any): Promise<any> {
    const result = this.#callQueue.then(async () => {
      // The replacement daemon answers a reload, so it gets a connection of its own.
      const kept = value.op !== "server.reload";
      const socket = kept
        ? await this.#connection()
        : await JsonSocket.connect(this.path);
      let reply: any;
      try {
        socket.send(value);
        reply = await socket.read(8000);
      } finally {
        // A late reply must not answer the next request.
        if (!kept || reply === undefined) socket.close();
      }
      if (reply.err)
        throw new Error(`rpc ${JSON.stringify(value)}: ${reply.err}`);
      return reply;
    });
    this.#callQueue = result.catch(() => {});
    return result;
  }
  /** Waits until the daemon's workers have read everything written so far and it has applied their results (test builds only). */
  async settle() {
    const result = await this.rpc({ op: "test.settle" });
    this.assertTrue(result.ok, JSON.stringify(result));
  }
  /** Lets `seconds` pass on the daemon's policy clock (cooldowns, retries, rescans) without waiting, and settles before and after. */
  async advance(seconds: number) {
    await this.settle();
    const result = await this.rpc({
      op: "test.advance",
      ms: Math.round(seconds * 1000),
    });
    this.assertTrue(result.ok, JSON.stringify(result));
    await this.settle();
  }
  async rpc(value: any) {
    await pump(this);
    const result = await this.#call(value);
    await pump(this);
    return result;
  }
  async command(operation: string, payload: any = {}) {
    return (
      await this.rpc({
        op: "session.command",
        protocol: 1,
        command: { [operation]: payload },
      })
    ).result;
  }
  async raw_rpc(value: any) {
    const socket = await JsonSocket.connect(this.path);
    try {
      return await socket.request(value);
    } finally {
      socket.close();
    }
  }
  session() {
    return this.rpc({ op: "session.snapshot", protocol: 1 });
  }
  async open_pane(options: any = {}) {
    options = { ...options };
    const views = (await this.rpc({ op: "viewer.list" })).viewers;
    const workspace = views.length
      ? views[0].workspace
      : (await this.session()).workspaces[0].id;
    if (views.length && views[0].pane) options.from ??= views[0].pane;
    const result = await this.command("pane.create", { workspace, ...options });
    if (!views.length) this.client = await Viewer.create(this, 80, 24);
    if ((await this.session()).panes.some((p: any) => p.id === result.pane))
      await this.rpc({ op: "focus", pane: result.pane });
    return result;
  }
  async split_pane(direction = "right", options: any = {}) {
    const view = (await this.rpc({ op: "viewer.list" })).viewers[0];
    const result = await this.command("pane.split", {
      target: view.pane,
      direction,
      ...options,
    });
    await this.rpc({ op: "focus", pane: result.pane, viewer: view.id });
    return result;
  }
  async until<T>(
    predicate: () => T | Promise<T>,
    timeout: number | { timeout: number } = 4,
  ): Promise<T> {
    const end =
      performance.now() +
      (typeof timeout === "number" ? timeout : timeout.timeout) * 1000;
    while (performance.now() < end) {
      await pump(this);
      const value = await predicate();
      if (value) return value;
      await this.#changed(100);
    }
    this.fail("condition timed out");
  }
  /** Like `until`, letting `step` seconds of policy-clock time pass between checks. */
  async untilAdvancing<T>(
    step: number,
    predicate: () => T | Promise<T>,
    timeout = 10,
  ): Promise<T> {
    return this.until(async () => {
      const value = await predicate();
      if (!value) await this.advance(step);
      return value;
    }, timeout);
  }
  async panes() {
    const snapshot = await this.session();
    return snapshot.panes.map((p: any) => ({
      ...p.agent,
      ...p,
      unread: p.agent.observation.completed > p.agent.observation.read,
      completed: p.agent.observation.completed,
      read: p.agent.observation.read,
      pending_stop: p.agent.observation.pending_stop,
      source: p.agent.observation.source,
      focused: this.client !== null && p.id === this.client.state.pane,
    }));
  }
  async tab_count() {
    const snapshot = await this.session();
    return this.client
      ? snapshot.workspaces.find(
          (ws: any) => ws.id === this.client!.state.workspace,
        ).model.tabs.length
      : snapshot.workspaces.reduce(
          (n: number, ws: any) => n + ws.model.tabs.length,
          0,
        );
  }
  async attach() {
    if (!this.client || this.client.closed || this.client.state.detached) {
      if (this.client) await this.client.close();
      this.client = await Viewer.create(this, 80, 24);
    } else await this.client.request({ op: "size", cols: 80, rows: 24 });
  }
  async reconnect() {
    await this.client!.close();
    this.client = null;
    await this.attach();
    await this.get_type("frame");
  }
  write(value: any) {
    return this.client!.request(value);
  }
  async message() {
    if (!this.client!.events.length) {
      await sleep(0.03);
      await this.client!.poll();
    }
    return this.client!.events.shift();
  }
  async get_type(kind: string) {
    for (let i = 0; i < 300; i++) {
      const value = await this.message();
      if (value.type === kind) return value;
    }
    this.fail(`missing message ${kind}`);
  }
  input(text: string) {
    return this.write({ op: "input", data: text });
  }
  async workspaces() {
    return (await this.session()).workspaces.map((ws: any) => ({
      ...ws,
      active: this.client !== null && ws.id === this.client.state.workspace,
    }));
  }
  async new_workspace(args: any = {}) {
    const result = await this.command("workspace.create", {
      cwd: this.temp.name,
      ...args,
    });
    if (this.client)
      await this.client.request({
        op: "workspace",
        workspace: result.workspace,
      });
    return result;
  }
  click(x: number, y: number) {
    return this.input(`\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`);
  }
  async frame_with(
    text: string,
    cols = 80,
    rows = 24,
    row: number | null = null,
  ) {
    for (let i = 0; i < 100; i++) {
      const screen = screen_text(
        (await this.get_type("frame")).data,
        cols,
        rows,
      );
      if (
        (row === null ? screen : screen.slice(row, row + 1)).some((line) =>
          line.includes(text),
        )
      )
        return screen;
    }
    this.fail(`missing visible text ${text}`);
  }
  /** Waits for the agent list's scrollbar, read down the sidebar border, to show `bar`. */
  async scrollbar_with(bar: string, cols = 80, rows = 24) {
    for (let i = 0; i < 100; i++) {
      const screen = screen_text(
        (await this.get_type("frame")).data,
        cols,
        rows,
      );
      if (scrollbar(screen) === bar) return screen;
    }
    this.fail(`missing scrollbar ${bar}`);
  }
  tab_frame(text: string, cols = 80, rows = 24) {
    return this.frame_with(text, cols, rows, 0);
  }
  async agent_frame(
    provider: string,
    icon: string,
    activity = "",
    color: string | null = null,
  ) {
    for (let i = 0; i < 100; i++) {
      const data = (await this.get_type("frame")).data,
        screen = screen_text(data);
      if (color && !data.includes(`\x1b[38;2;${color}m${icon}`)) continue;
      for (let y = 13; y < 21; y += 2) {
        if (!screen[y].slice(0, 27).startsWith(` ${icon} `)) continue;
        const actual = screen[y + 1].slice(1, 4).trim();
        if (
          activity === "thinking"
            ? !"⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏".includes(actual)
            : actual !== activity
        )
          continue;
        if (screen[y].slice(4, 27).trim() === provider) return screen;
      }
    }
    this.fail(`missing two-line agent entry ${provider}`);
  }
  async tabs_are(labels: string) {
    for (let i = 0; i < 100; i++) {
      const screen = screen_text((await this.get_type("frame")).data);
      if (screen[0].slice(28).trim().split(/\s+/).join(" ") === labels + " +")
        return screen;
    }
    this.fail(`missing tab labels ${labels}`);
  }
  async click_text(screen: string[], text: string) {
    for (const [y, row] of screen.entries())
      if (row.includes(text)) {
        await this.click(
          (text === " + " ? row.lastIndexOf(text) : row.indexOf(text)) + 1,
          y + 1,
        );
        return;
      }
    this.fail(`missing mouse target ${text}`);
  }
  right_click_tab(screen: string[], title: string) {
    const x = screen[0].indexOf(title) + 1;
    return this.input(`\x1b[<2;${x};1M\x1b[<2;${x};1m`);
  }
  async viewer(cols = 80, rows = 24) {
    const viewer = await Viewer.create(this, cols, rows);
    return [viewer, viewer];
  }
  async viewer_frame(viewer: Viewer, text: string, cols = 80, rows = 24) {
    for (let i = 0; i < 100; i++) {
      const screen = screen_text((await viewer.poll()).data, cols, rows);
      if (screen.some((row) => row.includes(text))) return screen;
      await sleep(0.03);
    }
    this.fail(`missing viewer frame ${text}`);
  }
  async restart_runtime() {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    await this.run_cli("shutdown");
    await this.until(() => !existsSync(this.path));
    await this.run_cli("start");
  }
  async ordinary_agent(provider: string, hooks = false, initializing = false) {
    write_ordinary_agent(join(this.temp.name, provider));
    if (hooks) {
      mkdirSync(
        this.env[provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]!,
        { recursive: true },
      );
      await this.restart_runtime();
    }
    const pane = (await this.open_pane({ cwd: this.temp.name })).pane;
    await this.command("pane.input", {
      target: pane,
      data: `PATH=${quote(this.temp.name)}:$PATH ${provider}${initializing ? " --loading" : ""}\r`,
    });
    await this.until(async () =>
      (await this.panes()).some(
        (p: any) => p.id === pane && p.provider === provider,
      ),
    );
    return pane;
  }
}
