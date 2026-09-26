/** Ask the host terminal for three colors, preserving partial replies on timeout. */
import { writeFileSync } from "node:fs";

if (process.stdin.isTTY) process.stdin.setRawMode(true);
let data = "";
await new Promise<void>((resolve) => {
  const timer = setTimeout(finish, 2000);
  function finish() {
    clearTimeout(timer);
    process.stdin.off("data", receive);
    process.stdin.pause();
    resolve();
  }
  function receive(chunk: Buffer) {
    data += chunk.toString("utf8");
    if (data.split("\x1b\\").length - 1 >= 3) finish();
  }
  process.stdin.on("data", receive);
  process.stdout.write("\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b]4;2;?\x1b\\");
});
writeFileSync(process.argv[2], JSON.stringify(data));
process.stdout.write("\x1b[48;2;57;57;57m COMPOSER \x1b[0m");
setInterval(() => {}, 1000);
