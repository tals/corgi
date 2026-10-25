import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { png_base64 } from "../../src/assets/corgi_badge";

const [root, terminal, executable] = process.argv.slice(2);
mkdirSync(root, { recursive: true });
const replies: string[] = [];
const listen = (bytes: Buffer) => replies.push(bytes.toString());
process.stdin.setRawMode(true);
process.stdin.on("data", listen);
process.stdin.resume();
const png = await new Bun.Image(Buffer.from(png_base64, "base64")).resize(32, 32).png().buffer();
const pixels = Buffer.alloc(32 * 32 * 3);
for (let i = 0; i < pixels.length; i += 3) pixels.set([224, 32, 224], i);
process.stdout.write(
  `\x1b[2J\x1b[H\x1b[?25lCorgi GUI probe: ${terminal}\r\n` +
    "\x1b[48;2;255;0;0m        \x1b[48;2;0;255;0m        \x1b[48;2;0;0;255m        \x1b[0m" +
    `\x1b[4;3H\x1b_Ga=T,f=24,s=32,v=32,i=731001,C=1;${pixels.toString("base64")}\x1b\\` +
    `\x1b[4;12H\x1b_Ga=T,f=100,i=731002,C=1;${png.toString("base64")}\x1b\\` +
    "\x1b[14t\x1b[16t\x1b[>0q\x1b[c",
);
const deadline = Date.now() + 3000;
while (Date.now() < deadline && !/\x1b\[\?[\d;]*c/.test(replies.join(""))) await Bun.sleep(20);
await Bun.write(join(root, "terminal.json"), JSON.stringify({ terminal, replies }, null, 2));
await Bun.write(join(root, "ready"), "ready");
while (!existsSync(join(root, "continue"))) await Bun.sleep(50);
process.stdin.off("data", listen);
process.stdin.pause();
process.stdin.setRawMode(false);
process.stdout.write("\x1b_Ga=d,d=A,q=2\x1b\\\x1b[?25h");
const state = join(root, "state"),
  config = join(root, "config"),
  project = join(root, "badge-demo");
for (const path of [join(state, "corgi"), config, project, join(root, "env")])
  mkdirSync(path, { recursive: true, mode: 0o700 });
await Bun.write(
  join(state, "corgi", "viewer.json"),
  JSON.stringify({ onboarding_complete: true, preset: "corgi", prefix: "ctrl_b" }),
);
const child = Bun.spawn([executable, "--no-update"], {
  cwd: project,
  env: {
    ...process.env,
    XDG_STATE_HOME: state,
    XDG_CONFIG_HOME: config,
    CORGI_SOCKET: join(root, "control.sock"),
    CORGI_ENV_DIR: join(root, "env"),
    CORGI_TEST_OWNER: String(process.pid),
    CORGI_BELL: "off",
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
await Bun.write(join(root, "corgi-started"), String(child.pid));
process.exitCode = await child.exited;
