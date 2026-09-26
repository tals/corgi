import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Viewers } from "./viewers";
import { registerCase, shellJoin, sleep, writeExecutable } from "./support";

class Selection extends Viewers {
  async test_agent_drag_copies_when_application_enables_mouse() {
    const fixture = join(this.temp.name, "mouse.ts");
    const capture = join(this.temp.name, "mouse.bin");
    writeExecutable(
      fixture,
      `#!/usr/bin/env bun
import { openSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
spawnSync('stty', ['raw', '-echo'], { stdio: 'inherit' });
process.stdout.write('\\x1b[?1002h\\x1b[?1006hSELECT_ME');
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
    await viewer.input("\x1b[<0;29;2M");
    await viewer.input("\x1b[<32;37;2M");
    await viewer.input("\x1b[<0;37;2m");
    const effects = viewer.state.effects;
    this.assertTrue(effects, "agent drag did not copy");
    const encoded = effects[0].write_terminal
      .split("52;c;", 2)[1]
      .split("\x07", 1)[0];
    this.assertEqual(Buffer.from(encoded, "base64").toString(), "SELECT_ME");
    this.assertIn("Copied to clipboard", viewer.state.data);
    this.assertEqual(readFileSync(capture), Buffer.alloc(0));
    await viewer.input("\x1b[<64;29;2M");
    await this.until(() =>
      readFileSync(capture).includes(Buffer.from("\x1b[<64;1;1M")),
    );
    await viewer.input("\x1b[<8;29;2M\x1b[<8;29;2m");
    await this.until(() =>
      readFileSync(capture).includes(Buffer.from("\x1b[<8;1;1m")),
    );
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
    await sleep(2.1);
    this.assertEqual((await a.poll()).data, (await b.poll()).data);
  }
}
registerCase("Selection", Selection, { inherited: false });
