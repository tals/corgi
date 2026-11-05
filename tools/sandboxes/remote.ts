import { join } from "node:path";
import { chmodSync, existsSync } from "node:fs";
import { table, type World } from "../sandbox";
import { request } from "../../src/remote_lab";
import { shellQuote } from "../../src/os";

export const world: World = {
  configure(s) {
    s.env.CORGI_REMOTE_LAB = join(s.dir, "network.sock");
  },
  seed(s) {
    chmodSync(s.dir, 0o700);
    for (const tool of ["ssh", "sshd", "ssh-keygen"])
      if (!Bun.which(tool)) throw Error(`remote sandbox requires ${tool}`);
    s.write(
      join(s.home, "bin/ssh"),
      `#!/bin/sh\nexec ${shellQuote(Bun.which("ssh")!)} -F ${shellQuote(join(s.dir, "ssh_config"))} "$@"\n`,
    );
    chmodSync(join(s.home, "bin/ssh"), 0o700);
  },
  async arrange(s) {
    const workspace = s.corgi(["workspace", "new", "Local lab", "--cwd", s.dir]);
    s.corgi([
      "tab",
      "new",
      "--workspace",
      String(workspace.workspace),
      "--name",
      "network supervisor",
      "--command",
      [process.execPath, join(s.root, "tools/remote_sandbox.ts"), "serve", s.dir, s.exe].map(shellQuote).join(" "),
    ]);
    s.corgi([
      "tab",
      "new",
      "--workspace",
      String(workspace.workspace),
      "--name",
      "local agent",
      "--command",
      "claude --sandbox-state working --sandbox-name keeping-local-work-responsive",
    ]);
    s.corgi([
      "tab",
      "new",
      "--workspace",
      String(workspace.workspace),
      "--name",
      "local ticker",
      "--command",
      "i=0; while :; do i=$((i+1)); printf 'local tick %s\\n' \"$i\"; sleep 0.2; done",
    ]);
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      if (existsSync(s.env.CORGI_REMOTE_LAB)) {
        try {
          if (Object.keys(await request(s.env.CORGI_REMOTE_LAB)).length === 3) return;
        } catch {}
      }
      await Bun.sleep(100);
    }
    throw Error("Remote sandbox did not start; inspect the network supervisor pane");
  },
  intro(s) {
    return [
      "Local + atlas, borealis, cirrus: real daemons and SSH, synthetic workloads.",
      ...table([
        [`${s.prefixName} ~`, "connectivity history and sandbox network sliders"],
        ["CLI", `bun tools/remote_sandbox.ts --socket ${s.env.CORGI_REMOTE_LAB} status`],
        ["Faults", "set atlas --latency-ms 120 --bandwidth-kib 128; outage atlas 5; drop atlas"],
        ["Lifetime", "keep the network supervisor pane open; --restart rebuilds the lab"],
      ]),
    ];
  },
};
