/** Observe the actual viewer PTY; no product transport or render hooks. */
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as terminal from "../../../src/pane/terminal";
import * as ffi from "bun:ffi";

interface Spec {
  cols: number;
  rows: number;
  command: string[];
  cwd: string;
  env: Record<string, string>;
  ansi: string;
}
type Request = { op: "input"; id: number; text: string } | { op: "screen"; id: number } | { op: "exit" };

const spec: Spec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const screen = new terminal.Terminal(spec.cols, spec.rows);
const clock = ffi.dlopen("libc.so.6", { clock_gettime: { args: ["i32", "ptr"], returns: "i32" } });
const stamp = new BigInt64Array(2);
const now = () => {
  clock.symbols.clock_gettime(1, ffi.ptr(stamp));
  return Number(stamp[0]) + Number(stamp[1]) / 1e9;
};
const emit = (value: object) => console.log(JSON.stringify({ at: now(), ...value }));
let last = "";
let bytes = 0;
const tty = new Bun.Terminal({
  cols: spec.cols,
  rows: spec.rows,
  data(_terminal, data) {
    bytes += data.length;
    screen.feed(data);
    const text = screen.text();
    const header = /NETEVAL_(\w+) S(\d+) T(\d+)/.exec(text);
    const end = [...text.matchAll(/END_(\w+) S(\d+) ACK_(\w+)/g)].find(
      match => header && match[1] === header[1] && match[2] === header[2],
    );
    if (header && end && header[1] === end[1] && header[2] === end[2]) {
      const identity = `${header[1]}:${header[2]}:${end[3]}`;
      if (identity !== last) {
        last = identity;
        emit({
          event: "frame",
          machine: header[1],
          seq: Number(header[2]),
          source: Number(header[3]) / 1e9,
          ack: end[3],
          bytes,
        });
      }
    }
    if (spec.ansi) fs.appendFileSync(spec.ansi, data);
  },
});
const launched = now();
const child = Bun.spawn(spec.command, { terminal: tty, cwd: spec.cwd, env: spec.env });
emit({ event: "launch", pid: child.pid, launched });
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request: Request = JSON.parse(line);
  switch (request.op) {
    case "input":
      tty.write(request.text);
      emit({ event: "input", id: request.id, text: request.text });
      break;
    case "screen":
      emit({ event: "screen", id: request.id, text: screen.text(), bytes });
      break;
    case "exit":
      child.kill();
      break;
  }
});
await child.exited;
emit({ event: "screen", id: "exit", text: screen.text(), bytes });
emit({ event: "exit", code: child.exitCode });
tty.close();
screen.destroy();
process.exit(0);
