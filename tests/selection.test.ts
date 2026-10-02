import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Viewers } from "./viewers";
import { registerCase, shellJoin, writeExecutable } from "./support";

class Selection extends Viewers {
  async test_agent_gets_mouse_and_shift_drag_selects() {
    const fixture = join(this.temp.name, "mouse.ts");
    const capture = join(this.temp.name, "mouse.bin");
    writeExecutable(
      fixture,
      `#!/usr/bin/env bun
import { openSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
spawnSync('stty', ['raw', '-echo'], { stdio: 'inherit' });
process.stdout.write('\\x1b[?1000h\\x1b[?1002h\\x1b[?1003h\\x1b[?1006hSELECT_ME');
const fd = openSync(process.argv[2], 'w');
process.stdin.on('data', chunk => writeSync(fd, chunk));
process.stdin.resume();
`,
    );
    const pane = await this.new(shellJoin(["bun", fixture, capture]));
    await this.until(async () =>
      (
        await this.command("pane.read", { target: pane, view: "screen" })
      ).text.includes("SELECT_ME"),
    );
    await this.mark_agent(pane, "Mouse agent");
    const viewer = await this.newViewer();
    await viewer.focus(pane);
    // Hover, then a drag released over the sidebar, all reach the agent.
    await viewer.input("\x1b[<35;30;2M");
    await viewer.input("\x1b[<0;29;2M");
    await viewer.input("\x1b[<32;37;2M");
    await viewer.input("\x1b[<32;5;2M");
    await viewer.input("\x1b[<0;5;2m");
    const forwarded =
      "\x1b[<35;2;1M\x1b[<0;1;1M\x1b[<32;9;1M\x1b[<32;1;1M\x1b[<0;1;1m";
    await this.until(() =>
      readFileSync(capture).includes(Buffer.from(forwarded)),
    );
    this.assertNotIn("Copied to clipboard", viewer.state.data);
    // Shift-drag stays with corgi and copies.
    await viewer.input("\x1b[<4;29;2M");
    await viewer.input("\x1b[<36;37;2M");
    await viewer.input("\x1b[<4;37;2m");
    const effects = viewer.state.effects;
    this.assertTrue(effects.length, "shift drag did not copy");
    const encoded = effects[0].write_terminal
      .split("52;c;", 2)[1]
      .split("\x07", 1)[0];
    this.assertEqual(Buffer.from(encoded, "base64").toString(), "SELECT_ME");
    this.assertIn("Copied to clipboard", viewer.state.data);
    await viewer.input("\x1b[<64;29;2M");
    await this.until(() =>
      readFileSync(capture).includes(Buffer.from("\x1b[<64;1;1M")),
    );
    this.assertEqual(
      readFileSync(capture).toString(),
      forwarded + "\x1b[<64;1;1M",
    );
  }

  async test_program_copy_reaches_the_viewer_showing_it() {
    const pane = await this.new("exec /bin/sh");
    const viewer = await this.newViewer();
    await viewer.focus(pane);
    await this.command("pane.input", {
      data: "printf '\\033]52;c;%s\\007' Q09QSUVE\n",
      target: pane,
    });
    const copy = `\x1b]52;c;${Buffer.from("COPIED").toString("base64")}\x07`;
    await this.until(async () =>
      (await viewer.poll()).effects.some(
        (effect: any) => effect.write_terminal === copy,
      ),
    );
    this.assertIn("Copied to clipboard", viewer.state.data);
  }

  async test_drag_freezes_text_and_release_copies_then_resumes() {
    const pane = await this.new("printf 'SELECT_ME\\n'; exec /bin/sh");
    await this.until(async () =>
      (
        await this.command("pane.read", { target: pane, view: "screen" })
      ).text.includes("SELECT_ME"),
    );
    const a = await this.newViewer(),
      b = await this.newViewer();
    await a.focus(pane);
    await b.focus(pane);
    await a.input("\x1b[<0;29;2M\x1b[<32;37;2M");
    const held = a.state.data;
    await this.command("pane.input", {
      data: "printf 'NEW_OUTPUT\\n'\n",
      target: pane,
    });
    await this.until(async () =>
      (
        await this.command("pane.read", { target: pane, view: "screen" })
      ).text.includes("NEW_OUTPUT"),
    );
    this.assertEqual((await a.poll()).data, held);
    this.assertIn("NEW_OUTPUT", (await b.poll()).data);
    await a.input("\x1b[<0;1;3m");
    const effect = a.state.effects[0].write_terminal;
    const encoded = effect.split("52;c;", 2)[1].split("\x07", 1)[0];
    this.assertEqual(Buffer.from(encoded, "base64").toString(), "SELECT_ME");
    this.assertIn("Copied to clipboard", a.state.data);
    this.assertIn("NEW_OUTPUT", a.state.data);
    this.assertNotIn("Copied to clipboard", (await b.poll()).data);
    await a.advance(2.1);
    this.assertEqual((await a.poll()).data, (await b.poll()).data);
  }
}
registerCase("Selection", Selection, { inherited: false });
