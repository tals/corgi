import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Runtime } from "./runtime";
import { EXE, registerCase, shellJoin, writeExecutable } from "./support";

class ReloadSnapshots extends Runtime {
  async test_large_output_preserves_process_input_and_resize_recovery() {
    await this.check_reload(1, 1025);
  }
  async test_multiple_noisy_panes_use_compact_snapshots() {
    await this.check_reload(4, 800);
  }

  async check_reload(paneCount: number, chunks: number) {
    const sizes = join(this.temp.name, "sizes.jsonl");
    const program = join(this.temp.name, "terminal.ts");
    writeExecutable(
      program,
      `#!/usr/bin/env bun
import { appendFileSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const log = process.argv[2];
function resized() {
  const result = spawnSync('stty', ['size'], { stdio: ['inherit', 'pipe', 'ignore'] });
  const [rows, cols] = result.stdout.toString().trim().split(/\\s+/).map(Number);
  appendFileSync(log, JSON.stringify([cols, rows]) + '\\n');
}
process.on('SIGWINCH', resized);
const chunk = Buffer.alloc(65536, 13);
for (let i = 0; i < Number(process.argv[3]); i++) {
  let offset = 0;
  while (offset < chunk.length) offset += writeSync(1, chunk, offset, chunk.length - offset);
}
console.log('READY', process.pid);
process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', data => {
  input += data;
  while (input.includes('\\n')) {
    const end = input.indexOf('\\n');
    console.log('ALIVE', process.pid, input.slice(0, end).trim());
    input = input.slice(end + 1);
  }
});
`,
    );
    const panes: number[] = [];
    for (let i = 0; i < paneCount; i++) {
      const pane = (
        await this.open_pane({
          command: `exec ${shellJoin(["bun", program, sizes, String(chunks)])}`,
        })
      ).pane;
      panes.push(pane);
      await this.until(
        async () =>
          (
            await this.command("pane.read", { target: pane, view: "screen" })
          ).text.includes("READY"),
        30,
      );
    }
    const pane = panes.at(-1)!;
    const text = async () =>
      (await this.command("pane.read", { target: pane, view: "screen" })).text;
    const before = await this.session();
    const pid = before.panes.find((p: any) => p.id === pane).pid;
    const geometry = before.panes.find((p: any) => p.id === pane);
    await this.rpc({ op: "server.reload", protocol: 1, executable: EXE });
    const after = await this.session();
    this.assertNotEqual(before.server_pid, after.server_pid);
    this.assertEqual(
      before.panes.map((p: any) => [p.id, p.pid]),
      after.panes.map((p: any) => [p.id, p.pid]),
    );
    this.assertEqual(after.panes.find((p: any) => p.id === pane).pid, pid);
    const events = () =>
      existsSync(sizes)
        ? readFileSync(sizes, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
    // A viewer may have resized the pane during startup. Wait for the handoff's
    // complete redraw pair, rather than counting that earlier SIGWINCH.
    await this.until(() => {
      const received = events();
      if (paneCount !== 1) return received.length >= 2 * paneCount;
      const [smaller, restored] = received.slice(-2);
      return smaller?.[0] === geometry.cols - 1 && smaller?.[1] === geometry.rows &&
        restored?.[0] === geometry.cols && restored?.[1] === geometry.rows;
    });
    if (paneCount === 1)
      this.assertEqual(events().slice(-2), [
        [geometry.cols - 1, geometry.rows],
        [geometry.cols, geometry.rows],
      ]);
    this.assertIn("READY", await text());
    await this.command("pane.input", { target: pane, data: "still here\r" });
    await this.until(async () =>
      (await text()).includes(`ALIVE ${pid} still here`),
    );
    await this.rpc({ op: "server.reload", protocol: 1, executable: EXE });
    await this.command("pane.input", { target: pane, data: "twice\r" });
    await this.until(async () => (await text()).includes(`ALIVE ${pid} twice`));
  }
}
registerCase("ReloadSnapshots", ReloadSnapshots);
