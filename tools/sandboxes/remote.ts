import { join } from "node:path";
import { chmodSync, existsSync } from "node:fs";
import { table, type World } from "../sandbox";
import { request } from "../../src/remote_lab";
import { shellQuote } from "../../src/os";
import { workloads } from "../remote_workloads";

export const world: World = {
  configure(s) {
    s.env.CORGI_REMOTE_LAB = join(s.dir, "network.sock");
    for (const provider of ["claude", "codex"] as const) {
      const binary = process.env[`CORGI_LAB_${provider.toUpperCase()}`] ?? Bun.which(provider);
      if (!binary || binary.startsWith(s.home + "/bin/"))
        throw Error(`The remote sandbox needs the real ${provider} installed`);
      s.env[`CORGI_LAB_${provider.toUpperCase()}`] = binary;
    }
  },
  seed(s) {
    chmodSync(s.dir, 0o700);
    for (const tool of ["ssh", "sshd", "ssh-keygen"])
      if (!Bun.which(tool)) throw Error(`remote sandbox requires ${tool}`);
    s.write(
      join(s.home, ".claude/.claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "sandbox@example.com" } }),
    );
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
    for (const [name, command] of workloads(join(s.root, "tools"), "local"))
      s.corgi([
        "tab",
        "new",
        "--workspace",
        String(workspace.workspace),
        "--name",
        name,
        ...(command ? ["--command", command] : []),
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
  async shutdown(s) {
    const control = join(s.dir, "network.sock");
    const sockets = ["slowloris", "finnicky", "goodboy"].map(name => join(s.dir, name, "run/control.sock"));
    // A daemon's exit also stops the supervisor and its other children. Wait
    // for that cleanup before --restart removes files they can still checkpoint.
    await Promise.all(
      sockets.map(async socket => {
        if (!existsSync(socket)) return;
        const child = Bun.spawn([s.exe, "shutdown"], {
          env: { ...s.env, CORGI_SOCKET: socket },
          stdout: "ignore",
          stderr: "ignore",
        });
        await child.exited;
      }),
    );
    const until = Date.now() + 30000;
    while ([control, ...sockets].some(socket => existsSync(socket))) {
      if (Date.now() >= until) throw Error("Remote sandbox shutdown timed out; its files were kept");
      await Bun.sleep(25);
    }
  },
  intro(s) {
    return [
      "Local + slowloris (800 ms), finnicky (5 s hang / 30 s), goodboy (100 ms).",
      ...table([
        [`${s.prefixName} ~`, "Developer → Remote: history, stats and network policies"],
        ["CLI", `bun tools/remote_sandbox.ts --socket ${s.env.CORGI_REMOTE_LAB} status`],
        ["Faults", "set slowloris --latency-ms 120; outage goodboy 5; drop finnicky"],
        ["Lifetime", "keep the network supervisor pane open; --restart rebuilds the lab"],
      ]),
    ];
  },
};
