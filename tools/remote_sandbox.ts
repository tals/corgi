/** Real SSH and daemons on loopback. No host network configuration is changed. */
import { createServer, createConnection } from "node:net";
import { mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { userInfo } from "node:os";
import { TcpFault } from "../tests/tcp_fault";
import { request, type Command, type Faults } from "../src/remote_lab";
import { shellQuote } from "../src/os";

const args = process.argv.slice(2);
if (args[0] !== "serve") {
  const index = args.indexOf("--socket");
  const socket = index >= 0 ? args.splice(index, 2)[1] : process.env.CORGI_REMOTE_LAB;
  if (!socket) throw Error("Use --socket PATH (shown in the remote sandbox introduction)");
  const [op, machine, value, ...rest] = args;
  const command: Command = { machine };
  switch (op) {
    case "status":
      delete command.machine;
      break;
    case "drop":
      command.drop = true;
      break;
    case "outage":
      command.outage_seconds = Number(value);
      break;
    case "reset":
      Object.assign(command, { latency_ms: 0, bandwidth_kib: 0, outage_seconds: 0 });
      break;
    case "set": {
      const flags = [value, ...rest];
      if (!flags.length || flags.length % 2) throw Error("Expected --latency-ms N and/or --bandwidth-kib N");
      for (let i = 0; i < flags.length; i += 2) {
        if (flags[i] === "--latency-ms") command.latency_ms = Number(flags[i + 1]);
        else if (flags[i] === "--bandwidth-kib") command.bandwidth_kib = Number(flags[i + 1]);
        else throw Error("Unknown fault option");
      }
      break;
    }
    default:
      throw Error(
        "Usage: status | set MACHINE --latency-ms N --bandwidth-kib N | outage MACHINE SECONDS | drop MACHINE | reset MACHINE",
      );
  }
  console.log(JSON.stringify(await request(socket, command), null, 2));
} else {
  await serve(args[1], args[2]);
}

async function serve(dir: string, exe: string): Promise<void> {
  const children: ReturnType<typeof Bun.spawn>[] = [],
    proxies = new Map<string, TcpFault>();
  const states: Record<string, Faults> = {};
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const env = { ...process.env };
  for (const key of ["CORGI_PANE", "CORGI_VIEWER", "CORGI_MACHINE", "CORGI_APP_EXE", "CORGI_ENV_BASE", "CORGI_ENV_DIR"])
    delete env[key];
  const run = async (cmd: string[], custom = env) => {
    const child = Bun.spawn(cmd, { env: custom, stdout: "pipe", stderr: "pipe" });
    const [out, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code) throw Error(`${cmd[0]}: ${error}`);
    return out;
  };
  const control = join(dir, "network.sock");
  rmSync(control, { force: true });
  let stopping = false;
  const server = createServer(client => {
    let input = "";
    client.setTimeout(2000, () => client.destroy());
    client.on("error", () => {});
    client.on("data", bytes => {
      input += bytes.toString();
      if (input.length > 4096) {
        client.destroy();
        return;
      }
      if (!input.includes("\n")) return;
      try {
        const c: Command = JSON.parse(input.slice(0, input.indexOf("\n")));
        const names = c.machine === undefined ? [] : c.machine === "all" ? [...proxies.keys()] : [c.machine];
        for (const [key, max] of [
          ["latency_ms", 2000],
          ["bandwidth_kib", 4096],
          ["outage_seconds", 60],
        ] as const) {
          const n = c[key];
          if (n !== undefined && (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > max))
            throw Error(`Invalid ${key}: expected 0..${max}`);
        }
        if (c.drop !== undefined && typeof c.drop !== "boolean") throw Error("Invalid drop");
        if (!names.length && Object.keys(c).length) throw Error("Machine required");
        for (const name of names) if (!proxies.has(name)) throw Error("Unknown sandbox machine");
        for (const name of names) {
          const proxy = proxies.get(name)!,
            state = states[name];
          if (c.latency_ms !== undefined) state.latency_ms = proxy.latency_ms = c.latency_ms;
          if (c.bandwidth_kib !== undefined) {
            state.bandwidth_kib = c.bandwidth_kib;
            proxy.bytes_per_second = c.bandwidth_kib * 1024;
          }
          if (c.drop) proxy.cut();
          if (c.outage_seconds !== undefined) {
            clearTimeout(timers.get(name));
            state.outage_until = c.outage_seconds ? Date.now() + c.outage_seconds * 1000 : 0;
            proxy.set(c.outage_seconds ? "blackhole" : "healthy");
            if (c.outage_seconds)
              timers.set(
                name,
                setTimeout(() => {
                  proxy.set("healthy");
                  state.outage_until = 0;
                }, c.outage_seconds * 1000),
              );
          }
        }
        for (const [name, proxy] of proxies) states[name].accepted = proxy.accepted;
        client.end(JSON.stringify(states) + "\n");
      } catch (error) {
        client.end(JSON.stringify({ error: (error as Error).message }) + "\n");
      }
    });
  });
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    for (const timer of timers.values()) clearTimeout(timer);
    server.close();
    for (const proxy of proxies.values()) await proxy.close();
    for (const child of children) child.kill();
    await Promise.all(children.map(child => child.exited));
    rmSync(control, { force: true });
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
    process.on(signal, () => void stop().then(() => process.exit()));
  try {
    for (const key of ["host", "client"]) {
      rmSync(join(dir, key), { force: true });
      rmSync(join(dir, key + ".pub"), { force: true });
      await run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", join(dir, key)]);
    }
    const reserve = createServer();
    await new Promise<void>(resolve => reserve.listen(0, "127.0.0.1", resolve));
    const address = reserve.address();
    if (!address || typeof address === "string") throw Error("NoPort");
    const port = address.port;
    await new Promise<void>(resolve => reserve.close(() => resolve()));
    writeFileSync(
      join(dir, "sshd_config"),
      `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${dir}/host\nPidFile ${dir}/sshd.pid\nAuthorizedKeysFile ${dir}/client.pub\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes no\nAllowUsers ${userInfo().username}\nLogLevel ERROR\n`,
    );
    const sshd = Bun.spawn([Bun.which("sshd")!, "-D", "-e", "-f", join(dir, "sshd_config")], {
      stdout: "inherit",
      stderr: "inherit",
    });
    children.push(sshd);
    let connected = false;
    for (let i = 0; i < 100 && !connected; i++) {
      if (sshd.exitCode !== null) throw Error("Sandbox sshd exited");
      connected = await new Promise<boolean>(resolve => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.on("error", () => {
          socket.destroy();
          resolve(false);
        });
        socket.on("connect", () => {
          socket.destroy();
          resolve(true);
        });
      });
      if (!connected) await Bun.sleep(20);
    }
    if (!connected) throw Error("Sandbox sshd startup timed out");
    const profiles = [],
      configs: string[] = [],
      known: string[] = [];
    for (const name of ["atlas", "borealis", "cirrus"]) {
      const home = join(dir, name),
        socket = join(home, "run/control.sock");
      mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
      const remoteEnv = {
        ...env,
        HOME: home,
        CORGI_SOCKET: socket,
        XDG_STATE_HOME: join(home, "state"),
        CODEX_HOME: join(home, ".codex"),
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
      };
      const daemon = Bun.spawn([exe, "serve"], {
        env: remoteEnv,
        stdout: "ignore",
        stderr: Bun.file(join(home, "server.log")),
      });
      children.push(daemon);
      let info;
      for (let i = 0; i < 100; i++) {
        if (daemon.exitCode !== null) throw Error(`${name} daemon exited`);
        try {
          info = JSON.parse(await run([exe, "__remote-info"], remoteEnv));
          break;
        } catch {
          await Bun.sleep(50);
        }
      }
      if (!info) throw Error(`${name} failed to start`);
      const proxy = new TcpFault(port, true);
      await proxy.start();
      proxies.set(name, proxy);
      states[name] = { latency_ms: 0, bandwidth_kib: 0, outage_until: 0, accepted: 0 };
      configs.push(
        `Host ${name}\n HostName 127.0.0.1\n Port ${proxy.port}\n User ${userInfo().username}\n IdentityFile ${dir}/client\n IdentitiesOnly yes\n UserKnownHostsFile ${dir}/known_hosts\n`,
      );
      known.push(`[127.0.0.1]:${proxy.port} ${readFileSync(join(dir, "host.pub"), "utf8").trim()}`);
      profiles.push({ name, target: name, executable: exe, socket, home, bridge: info.bridge });
      const ws = JSON.parse(await run([exe, "workspace", "new", name, "--cwd", home, "--json"], remoteEnv)).result
        .workspace;
      for (const [label, command] of [
        [
          "builder",
          "i=0; while :; do i=$((i+1)); printf 'build step %s: compiling worker and running tests\\n' \"$i\"; sleep 0.15; done",
        ],
        ["agent", "claude --sandbox-state working --sandbox-name testing-network-recovery"],
        ["shell", "cat"],
      ]) {
        const pane = JSON.parse(
          await run(
            [exe, "tab", "new", "--workspace", String(ws), "--name", label, "--command", command, "--json"],
            remoteEnv,
          ),
        ).result.pane;
        if (label === "agent") await run([exe, "pane", "send", String(pane), "work", "--enter"], remoteEnv);
      }
    }
    writeFileSync(join(dir, "ssh_config"), configs.join("\n"));
    writeFileSync(join(dir, "known_hosts"), known.join("\n") + "\n");
    const catalog = join(env.XDG_STATE_HOME!, "corgi/remote/machines.json");
    mkdirSync(dirname(catalog), { recursive: true, mode: 0o700 });
    writeFileSync(catalog, JSON.stringify({ version: 1, machines: profiles }), { mode: 0o600 });
    await new Promise<void>(resolve => server.listen(control, resolve));
    chmodSync(control, 0o600);
    console.log("Remote lab ready: atlas, borealis, cirrus. Prefix + ~ opens connectivity controls.");
    // If a child dies, don't leave a partially alive sandbox behind.
    await Promise.race(children.map(child => child.exited));
  } finally {
    await stop();
  }
}
