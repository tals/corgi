import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Runtime, screen_text } from "./runtime";
import { Viewer } from "./viewer_client";
import {
  EXE,
  Pty,
  clicks,
  copied,
  highlighted as highlightedIn,
  quote,
  registerCase,
  shellJoin,
  writeExecutable,
} from "./support";

const cols = 120,
  rows = 40;
const opens = (state: any) => state.effects.some((effect: any) => "open_url" in effect);
/** The text drawn selected; see `highlightedIn`. */
const highlighted = (data: string, left: number, plain: { x: number; y: number }) =>
  highlightedIn(data, { cols, rows }, left, plain);

class Links extends Runtime {
  async setUp() {
    await super.setUp();
    for (const key of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "CORGI_PANE"]) delete this.env[key];
  }
  async new(command = "sleep 60") {
    return (
      await this.command("pane.create", {
        workspace: (await this.session()).workspaces[0].id,
        cwd: this.temp.name,
        command,
      })
    ).pane;
  }
  opener(opened: string) {
    const bindir = join(this.temp.name, "bin");
    mkdirSync(bindir, { recursive: true });
    const executable = join(bindir, process.platform === "darwin" ? "open" : "xdg-open");
    writeFileSync(executable, `#!/bin/sh\nprintf "%s" "$1" > ${quote(opened)}\n`);
    chmodSync(executable, 0o700);
    this.env.PATH = bindir + ":" + this.env.PATH;
  }
  async test_named_link_survives_real_server_and_viewer() {
    const url = "https://example.com/corgi-link-test";
    const output = `\x1b]8;id=docs;${url}\x1b\\\x1b[1;4;38;5;33mNamed docs\x1b]8;;\x1b\\\x1b[0m ordinary\r\n`;
    const pane = await this.new(`printf %s ${quote(output)}; exec /bin/sh`);
    await this.until(async () =>
      (await this.command("pane.read", { target: pane, view: "screen" })).text.includes("Named docs"),
    );
    const surface = (await this.rpc({ op: "pane.surface", protocol: 3, pane })).surface;
    this.assertIn(`;${url}\x1b\\`, surface.lines.join(""));
    const viewer = await Viewer.create(this);
    this.assertIn(`;${url}\x1b\\`, (await viewer.poll()).data);
    const rows = screen_text(viewer.state.data, 100, 30);
    const y = rows.findIndex(row => row.includes("Named docs")),
      x = rows[y].indexOf("Named docs");
    this.assertIn("\x1b]22;pointer\x1b\\", (await viewer.input(`\x1b[<35;${x + 1};${y + 1}M`)).data);
    this.assertIn("Copy link", (await viewer.advance(0.15)).data);
    await viewer.input(`\x1b[<35;${x + 3};${y + 3}M\x1b[<0;${x + 3};${y + 3}M`);
    const copied = await viewer.input(`\x1b[<0;${x + 3};${y + 3}m`);
    this.assertEqual(copied.effects, [{ write_terminal: `\x1b]52;c;${Buffer.from(url).toString("base64")}\x07` }]);
    this.assertIn("Copied", copied.data);
  }
  async test_pointer_names_follow_each_viewers_terminal() {
    const url = "https://example.com/pointer";
    const pane = await this.new(`printf %s ${quote(url + "\r\n")}; exec /bin/sh`);
    await this.until(async () =>
      (await this.command("pane.read", { target: pane, view: "screen" })).text.includes(url),
    );
    const ghostty = await Viewer.create(this);
    this.env.TERM_PROGRAM = "iTerm.app";
    const iterm = await Viewer.create(this);
    for (const [viewer, shape] of [
      [ghostty, "pointer"],
      [iterm, "hand2"],
    ] as const) {
      const rows = screen_text(viewer.state.data, 100, 30);
      const y = rows.findIndex(row => row.includes(url));
      const x = rows[y].indexOf(url);
      this.assertIn(`\x1b]22;${shape}\x1b\\`, (await viewer.input(`\x1b[<35;${x + 1};${y + 1}M`)).data);
      this.assertIn(`\x1b]22;${shape}\x1b\\`, (await viewer.poll()).data);
      this.assertIn("\x1b]22;default\x1b\\", (await viewer.input("\x1b[<35;90;25M")).data);
    }
  }
  async test_plain_terminal_link_click_and_drag() {
    const opened = join(this.temp.name, "opened");
    this.opener(opened);
    const url = "https://example.com/plain";
    const pane = await this.new(`printf %s ${quote(url + "\r\n")}; exec /bin/sh`);
    await this.until(async () =>
      (await this.command("pane.read", { target: pane, view: "screen" })).text.includes(url),
    );
    const viewer = await Viewer.create(this),
      other = await Viewer.create(this);
    let frame = (await viewer.poll()).data;
    this.assertIn(`;${url}\x1b\\`, frame);
    frame = frame.replace(/\x1b\]8;[^\x1b]*\x1b\\/g, "");
    const rows = screen_text(frame, 120, 40);
    const y = rows.findIndex(row => row.includes(url)),
      x = rows[y].indexOf(url);
    const mouse = (code: number, dx = 0, release = false) =>
      viewer.input(`\x1b[<${code};${x + dx + 1};${y + 1}${release ? "m" : "M"}`);
    this.assertIn("\x1b[?1003h", viewer.state.data);
    await mouse(35);
    this.assertIn("\x1b]22;pointer\x1b\\", viewer.state.data);
    this.assertIn("\x1b]22;default\x1b\\", (await other.poll()).data);
    this.assertIn("\x1b[4m", viewer.state.data);
    this.assertNotIn("\x1b[4m", (await other.poll()).data);
    await mouse(51);
    this.assertIn("\x1b[4m", viewer.state.data);
    await mouse(35, url.length + 2);
    this.assertIn("\x1b]22;default\x1b\\", viewer.state.data);
    this.assertNotIn("\x1b[4m", viewer.state.data);
    await mouse(0);
    await mouse(32, 5);
    this.assertIn("38;2;0;0;0;48;2;255;255;255m", viewer.state.data);
    await mouse(0, 5, true);
    // A plain click opens only once the double-click window has passed.
    this.assertFalse(opens(viewer.state));
    this.assertFalse(opens(await viewer.advance(0.31)));
    await mouse(0);
    await mouse(32, 5);
    await mouse(32);
    await mouse(0, 0, true);
    this.assertFalse(opens(viewer.state));
    this.assertFalse(opens(await viewer.advance(0.31)));
    await mouse(0, url.length + 2);
    await mouse(32, url.length + 1);
    await mouse(32, 3);
    await mouse(0, 3, true);
    this.assertFalse(opens(viewer.state));
    this.assertFalse(opens(await viewer.advance(0.31)));
    // A plain click opens once the double-click window has passed.
    await mouse(0);
    await mouse(0, 0, true);
    this.assertEqual(viewer.state.effects, []);
    this.assertEqual((await viewer.advance(0.31)).effects, [{ open_url: url }]);
    this.assertEqual((await viewer.advance(0.4)).effects, []);
    // Ctrl+click opens at once.
    await mouse(16);
    await mouse(16, 0, true);
    this.assertEqual(viewer.state.effects, [{ open_url: url }]);
    await viewer.close();
    await other.close();
    const pty = await Pty.spawn([EXE, "attach"], {
      env: this.env,
      cwd: this.temp.name,
      cols: 80,
      rows: 24,
    });
    this.pty = pty;
    await pty.waitFor(`;${url}\x1b\\`);
    pty.write("\x1b[<35;30;2M\x1b[<16;30;2M\x1b[<16;30;2m");
    await this.until(() => existsSync(opened));
    this.assertEqual(readFileSync(opened, "utf8"), url);
  }
  async test_double_click_on_a_link_copies_it_and_never_opens_it() {
    const pane = await this.new("exec /bin/sh");
    const viewer = await Viewer.create(this, cols, rows);
    await viewer.focus(pane);
    // Sized for this viewer, not the daemon's default.
    let width = 0;
    await this.until(async () => {
      const shown = (await this.session()).panes.find((p: any) => p.id === pane);
      width = shown?.cols ?? 0;
      return shown?.rows > 30;
    });
    // The lines sit below the "Copied to clipboard" toast's rows.
    const lines = [
      "MARKER_TOP",
      "",
      "",
      "",
      "see https://example.com/a for details",
      "wiki https://en.wikipedia.org/wiki/Foo_(bar) end",
      "read \x1b]8;;https://example.com/docs\x1b\\docs\x1b]8;;\x1b\\ here",
      "wrap".padEnd(width - 12) + "https://example.com/wrapped/long/path end",
      "MARKER_END",
    ];
    const file = join(this.temp.name, "links.txt");
    writeFileSync(file, lines.join("\n"));
    await this.command("pane.input", { target: pane, data: `printf '\\033[H\\033[2J'; cat ${file}; echo\n` });
    let screen: string[] = [];
    await this.until(async () => {
      const frame = (await viewer.poll()).data.replace(/\x1b\]8;[^\x1b]*\x1b\\/g, "");
      screen = screen_text(frame, cols, rows);
      return screen.some(row => row.includes("MARKER_TOP")) && screen.some(row => row.includes("MARKER_END"));
    });
    const top = screen.findIndex(row => row.includes("MARKER_TOP"));
    const origin = { x: screen[top].indexOf("MARKER_TOP"), y: top };
    const wrapped = "https://example.com/wrapped/long/path";
    // Where to double-click, what that copies and what it highlights.
    const cases: [number, number, string, string][] = [
      [origin.x + 10, origin.y + 4, "https://example.com/a", "https://example.com/a"],
      [
        origin.x + 40,
        origin.y + 5,
        "https://en.wikipedia.org/wiki/Foo_(bar)",
        "https://en.wikipedia.org/wiki/Foo_(bar)",
      ],
      // A link whose text isn't its target copies the text.
      [origin.x + 6, origin.y + 6, "docs", "docs"],
      [origin.x + width - 5, origin.y + 7, wrapped, wrapped],
      [origin.x + 5, origin.y + 8, wrapped, wrapped],
    ];
    for (const [x, y, copy, cells] of cases) {
      await viewer.advance(0.4);
      const state = await clicks(viewer, x, y, 2);
      this.assertEqual(copied(state), copy);
      this.assertEqual(highlighted(state.data, origin.x, origin), cells);
      this.assertFalse(opens(state), copy);
      this.assertFalse(opens(await viewer.advance(0.4)), copy);
    }
    const [x, y] = cases[0];
    // A triple-click copies the line and doesn't open the link either.
    let state = await clicks(viewer, x, y, 3);
    this.assertEqual(copied(state), "see https://example.com/a for details");
    this.assertFalse(opens(state));
    this.assertFalse(opens(await viewer.advance(0.4)));
    // A press dragged off the link, onto "for", never opens it.
    await viewer.input(`\x1b[<0;${x + 1};${y + 1}M\x1b[<32;${x + 18};${y + 1}M\x1b[<0;${x + 18};${y + 1}m`);
    this.assertFalse(opens(viewer.state));
    this.assertFalse(opens(await viewer.advance(0.4)));
    // A double-click on a link dragged within it keeps the link; dragged out
    // of it, onto "for" or back onto "see", it extends by words.
    for (const [dx, copy] of [
      [3, "https://example.com/a"],
      [17, "https://example.com/a for"],
      [-9, "see https://example.com/a"],
    ] as const) {
      await viewer.advance(0.4);
      const at = `${x + 1};${y + 1}`;
      await viewer.input(`\x1b[<0;${at}M\x1b[<0;${at}m\x1b[<0;${at}M`);
      await viewer.input(`\x1b[<32;${x + dx + 1};${y + 1}M`);
      state = await viewer.input(`\x1b[<0;${x + dx + 1};${y + 1}m`);
      this.assertEqual(copied(state), copy);
      this.assertEqual(highlighted(state.data, origin.x, origin), copy);
      this.assertFalse(opens(state));
      this.assertFalse(opens(await viewer.advance(0.4)));
    }
    // A single click does.
    state = await clicks(viewer, x, y, 1);
    this.assertFalse(opens(state));
    this.assertEqual((await viewer.advance(0.31)).effects, [{ open_url: "https://example.com/a" }]);
  }
  async test_plain_port_click_invokes_system_opener_in_attached_client() {
    const ready = join(this.temp.name, "port"),
      opened = join(this.temp.name, "opened"),
      fixture = join(this.temp.name, "serve_fixture.ts");
    writeExecutable(
      fixture,
      `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('OK') });
console.log('Listening on port ' + server.port);
writeFileSync(process.argv[2], String(server.port));
`,
    );
    await this.new(`exec ${shellJoin(["bun", fixture, ready])}`);
    await this.until(() => existsSync(ready));
    const port = Number(readFileSync(ready, "utf8"));
    await this.until(
      async () =>
        (await this.session()).ports.workspaces.some((w: any) =>
          w.endpoints.some((e: any) => e.port === port && e.scheme === "http"),
        ),
      20,
    );
    this.opener(opened);
    const pty = await Pty.spawn([EXE, "attach"], {
      env: this.env,
      cwd: this.temp.name,
      cols: 80,
      rows: 24,
    });
    this.pty = pty;
    const frame = () => {
      const frames = [...pty.output.matchAll(/\x1b\[\?2026h([\s\S]*?)\x1b\[\?2026l/g)];
      if (!frames.length) return null;
      const rows = screen_text(frames.at(-1)![1], 80, 24);
      for (const [y, row] of rows.entries())
        if (row.includes("Open Link")) return [row.indexOf("Open Link") + 2, y + 1];
      return null;
    };
    const [x, y] = (await this.until(frame, 8))!;
    pty.write(`\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`);
    await this.until(() => existsSync(opened));
    this.assertEqual(readFileSync(opened, "utf8"), `http://localhost:${port}`);
  }
  async test_link_popover_appears_while_idle_and_copies_in_attached_client() {
    const url = "https://example.com/copy-this-link";
    const pane = await this.new(`printf %s ${quote(url + "\r\n")}; exec /bin/sh`);
    await this.until(async () =>
      (await this.command("pane.read", { target: pane, view: "screen" })).text.includes(url),
    );
    const other = await Viewer.create(this);
    const pty = await Pty.spawn([EXE, "attach"], {
      env: this.env,
      cwd: this.temp.name,
      cols: 100,
      rows: 30,
    });
    this.pty = pty;
    const [x, y] = (await this.until(() => {
      const frame = [...pty.output.matchAll(/\x1b\[\?2026h([\s\S]*?)\x1b\[\?2026l/g)].at(-1);
      if (!frame) return null;
      const rows = screen_text(frame[1], 100, 30);
      const y = rows.findIndex(row => row.includes(url));
      return y < 0 ? null : [rows[y].indexOf(url) + 2, y];
    }))!;
    // No more input or polling: the hover deadline must wake the actual viewer.
    pty.write(`\x1b[<35;${x + 1};${y + 1}M`);
    await pty.waitFor("Copy link");
    this.assertNotIn("Copy link", (await other.poll()).data);
    pty.write(`\x1b[<35;${x + 1};${y + 2}M\x1b[<35;${x + 3};${y + 3}M`);
    pty.write(`\x1b[<0;${x + 3};${y + 3}M\x1b[<0;${x + 3};${y + 3}m`);
    await pty.waitFor(`\x1b]52;c;${Buffer.from(url).toString("base64")}\x07`);
    await pty.waitFor("Copied");
  }
}
registerCase("Links", Links, { inherited: false });
