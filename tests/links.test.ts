import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Runtime, screen_text } from "./runtime";
import { Viewer } from "./viewer_client";
import {
  EXE,
  Pty,
  quote,
  registerCase,
  shellJoin,
  sleep,
  writeExecutable,
} from "./support";

class Links extends Runtime {
  async setUp() {
    await super.setUp();
    for (const key of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "CORGI_PANE"])
      delete this.env[key];
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
    const executable = join(
      bindir,
      process.platform === "darwin" ? "open" : "xdg-open",
    );
    writeFileSync(
      executable,
      `#!/bin/sh\nprintf "%s" "$1" > ${quote(opened)}\n`,
    );
    chmodSync(executable, 0o700);
    this.env.PATH = bindir + ":" + this.env.PATH;
  }
  async test_named_link_survives_real_server_and_viewer() {
    const url = "https://example.com/corgi-link-test";
    const output = `\x1b]8;id=docs;${url}\x1b\\\x1b[4mNamed docs\x1b]8;;\x1b\\\x1b[0m ordinary\r\n`;
    const pane = await this.new(`printf %s ${quote(output)}; exec /bin/sh`);
    await this.until(async () =>
      (
        await this.command("pane.read", { target: pane, view: "screen" })
      ).text.includes("Named docs"),
    );
    const surface = (await this.rpc({ op: "pane.surface", protocol: 1, pane }))
      .surface;
    this.assertIn(`;${url}\x1b\\`, surface.lines.join(""));
    const viewer = await Viewer.create(this);
    this.assertIn(`;${url}\x1b\\`, (await viewer.poll()).data);
    const rows = screen_text(viewer.state.data, 100, 30);
    const y = rows.findIndex((row) => row.includes("Named docs")),
      x = rows[y].indexOf("Named docs");
    this.assertIn(
      "\x1b]22;pointer\x1b\\",
      (await viewer.input(`\x1b[<35;${x + 1};${y + 1}M`)).data,
    );
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
    for (const [viewer, shape] of [[ghostty, "pointer"], [iterm, "hand2"]] as const) {
      const rows = screen_text(viewer.state.data, 100, 30);
      const y = rows.findIndex((row) => row.includes(url));
      const x = rows[y].indexOf(url);
      this.assertIn(
        `\x1b]22;${shape}\x1b\\`,
        (await viewer.input(`\x1b[<35;${x + 1};${y + 1}M`)).data,
      );
      this.assertIn(`\x1b]22;${shape}\x1b\\`, (await viewer.poll()).data);
      this.assertIn("\x1b]22;default\x1b\\", (await viewer.input("\x1b[<35;90;25M")).data);
    }
  }
  async test_plain_terminal_link_click_and_drag() {
    const opened = join(this.temp.name, "opened");
    this.opener(opened);
    const url = "https://example.com/plain";
    const pane = await this.new(
      `printf %s ${quote(url + "\r\n")}; exec /bin/sh`,
    );
    await this.until(async () =>
      (
        await this.command("pane.read", { target: pane, view: "screen" })
      ).text.includes(url),
    );
    const viewer = await Viewer.create(this),
      other = await Viewer.create(this);
    let frame = (await viewer.poll()).data;
    this.assertIn(`;${url}\x1b\\`, frame);
    frame = frame.replace(/\x1b\]8;[^\x1b]*\x1b\\/g, "");
    const rows = screen_text(frame, 120, 40);
    const y = rows.findIndex((row) => row.includes(url)),
      x = rows[y].indexOf(url);
    const mouse = (code: number, dx = 0, release = false) =>
      viewer.input(
        `\x1b[<${code};${x + dx + 1};${y + 1}${release ? "m" : "M"}`,
      );
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
    this.assertFalse(
      viewer.state.effects.some((effect: any) => "open_url" in effect),
    );
    await mouse(0);
    await mouse(32, 5);
    await mouse(32);
    await mouse(0, 0, true);
    this.assertFalse(
      viewer.state.effects.some((effect: any) => "open_url" in effect),
    );
    await mouse(0, url.length + 2);
    await mouse(32, url.length + 1);
    await mouse(32, 3);
    await mouse(0, 3, true);
    this.assertFalse(
      viewer.state.effects.some((effect: any) => "open_url" in effect),
    );
    await mouse(0);
    await mouse(0, 0, true);
    this.assertEqual(viewer.state.effects, [{ open_url: url }]);
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
  async test_plain_port_click_invokes_system_opener_in_attached_client() {
    const ready = join(this.temp.name, "port"),
      opened = join(this.temp.name, "opened"),
      fixture = join(this.temp.name, "serve_fixture.ts");
    writeExecutable(
      fixture,
      `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('OK') });
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
      const frames = [
        ...pty.output.matchAll(/\x1b\[\?2026h([\s\S]*?)\x1b\[\?2026l/g),
      ];
      if (!frames.length) return null;
      const rows = screen_text(frames.at(-1)![1], 80, 24);
      for (const [y, row] of rows.entries())
        if (row.includes("Open Link"))
          return [row.indexOf("Open Link") + 2, y + 1];
      return null;
    };
    const [x, y] = (await this.until(frame, 8))!;
    pty.write(`\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`);
    await this.until(() => existsSync(opened));
    this.assertEqual(readFileSync(opened, "utf8"), `http://localhost:${port}`);
  }
}
registerCase("Links", Links, { inherited: false });
