import { Remote, startup_ms } from "./daemon_transport";
import { nativeRoot } from "./native_paths";
import * as currentRelease from "./current_release";
import { homedir } from "node:os";
import * as machines from "./machines";
import * as setup from "./machine_setup";
import * as ssh from "./ssh";
import * as protocol from "./protocol";
import * as machine_path from "./machine_path";
import * as json from "./json";
import * as cli from "./cli";
import type * as rpc_http from "./rpc_http";
import * as agentMode from "./agent_mode";
import * as os from "./os";
import { Connection } from "./rpc";

export const help = `
Machines (SSH):
  corgi machine add NAME [SSH_TARGET] [--executable /path/to/corgi]
  corgi machine list
  corgi machine status NAME
  corgi machine reconnect NAME
  corgi machine check NAME
  corgi machine remove NAME
  corgi --machine NAME [attach | open PATH | COMMAND...]
  corgi list --all-machines

SSH_TARGET defaults to NAME. "local" always selects this machine.
Setup upgrades the older Corgi installation. Add uses normal SSH prompts;
viewers reconnect with SSH keys/agent or noninteractive corporate SSH authentication.
In the viewer, Ctrl+] or clicking the machine name opens the machine picker.
`;
export async function manage(args: string[]): Promise<void> {
  switch (args[0]) {
    case "add": {
      const rest = args.slice(1);
      const name = machines.name(rest.shift() ?? "");
      const target = machines.target(rest[0] && !rest[0].startsWith("--") ? rest.shift()! : name);
      let executable = "corgi";
      if (rest[0] === "--executable" && rest.length === 2) executable = rest.splice(0)[1];
      if (rest.length) throw Error("Usage");
      if (machines.read().some(p => p.name === name)) throw Error("MachineExists");
      process.stderr.write(`Checking ${target} through SSH…\n`);
      executable = await setup.reconcile(target, executable, args);
      const info = await machines.discover(target, executable);
      const profile = {
        name,
        target,
        executable: info.executable,
        socket: info.socket,
        home: info.home,
        bridge: info.bridge,
      };
      await check(profile);
      await machines.edit(profiles => {
        if (profiles.some(p => p.name === name)) throw Error("MachineExists");
        return [...profiles, profile];
      });
      process.stdout.write(json.stringify({ ok: true, machine: name, target }) + "\n");
      return;
    }
    case "status":
    case "reconnect": {
      if (args.length !== 2) throw Error("Usage");
      const profile = machines.find(args[1]);
      if (args[0] === "reconnect") {
        const child = Bun.spawn(["ssh", ...ssh.args(profile.target, true), "true"], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        if (await child.exited) throw Error("SshAuthenticationFailed");
      }
      await check(profile);
      process.stdout.write(json.stringify({ ok: true, machine: profile.name, status: "reachable" }) + "\n");
      return;
    }
    case "remove": {
      if (args.length !== 2) throw Error("Usage");
      await machines.edit(profiles => {
        if (!profiles.some(p => p.name === args[1])) throw Error("UnknownMachine");
        return profiles.filter(p => p.name !== args[1]);
      });
      process.stdout.write(json.stringify({ ok: true, machine: args[1] }) + "\n");
      return;
    }
    case "list":
      if (args.length !== 1) throw Error("Usage");
      process.stdout.write(json.stringify({ machines: [{ name: "local" }, ...machines.read()] }) + "\n");
      return;
    case "check": {
      if (args.length !== 2) throw Error("Usage");
      const old = machines.find(args[1]);
      const executable = await setup.reconcile(old.target, old.executable, args, old.socket);
      const info = await machines.discover(old.target, executable, old.socket);
      const refreshed = {
        ...old,
        executable: info.executable,
        socket: old.socket,
        home: old.home,
        bridge: info.bridge,
      };
      await check(refreshed, true);
      await machines.edit(profiles =>
        profiles.map(p => {
          if (p.name !== old.name) return p;
          // Removed and added again for another host meanwhile, it isn't the one checked.
          if (p.target !== old.target || p.socket !== old.socket) throw Error("MachineChanged");
          return refreshed;
        }),
      );
      process.stdout.write(json.stringify({ ok: true, machine: args[1] }) + "\n");
      return;
    }
    default:
      process.stdout.write(help);
      if (args.length && args[0] !== "--help") process.exitCode = 2;
  }
}
async function check(profile: machines.Profile, fresh = false): Promise<void> {
  const tunnel = new Remote(profile, fresh);
  let conn: Connection | null = null;
  try {
    await tunnel.open();
    conn = new Connection(tunnel.socket, startup_ms);
    machine_path.compatible(await conn.call("hello"));
  } catch (error) {
    process.stderr.write(
      `Could not connect to ${profile.name}. Check SSH authentication, the remote daemon, and its native bridge.\n${tunnel.diagnostic()}\n`,
    );
    throw error;
  } finally {
    conn?.close();
    tunnel.close();
  }
}
export function remoteInfo(executable: string): machines.Info {
  return {
    remote_protocol: machines.remote_protocol,
    protocol: protocol.version,
    viewer_protocol: protocol.viewer_version,
    // The launcher an update keeps, not this release, which a later one prunes.
    executable: currentRelease.path(executable),
    socket: os.socketPath(),
    home: homedir(),
    bridge: nativeRoot + "/bin/corgi-remote-bridge",
  };
}
export function remoteCommand(args: string[]): boolean {
  return (
    cli.handles(agentMode.flags(args).args) || ["ping", "rpc", "action", "checkpoint", "shutdown"].includes(args[0])
  );
}
/** Validate and execute on the same daemon connection that negotiated the protocol. */
export async function run(path: string, args: string[], conn: Connection): Promise<void> {
  const choice = agentMode.flags(args);
  if (cli.handles(choice.args)) {
    try {
      // The command goes over the connection that negotiated the protocol.
      const daemon: rpc_http.Daemon = {
        socket: path,
        call: (op, ...rest) => conn.call(op, ...rest),
        request: (op, ...rest) => conn.request(op, ...rest),
      };
      await cli.run(daemon, choice.args, agentMode.enabled(choice.flag, process.env, process.stdout.isTTY === true));
    } catch (error) {
      cli.failure(error instanceof Error ? error.message : String(error), 2, choice.args);
    }
    return;
  }
  let reply: unknown;
  // Replies print as JSON here, so the local CLI's --json changes nothing.
  if (args[0] !== "rpc") args = args.filter(arg => arg !== "--json");
  switch (args[0]) {
    case "ping":
    case "shutdown":
      if (args.length !== 1) throw Error("Usage");
      reply = await conn.call(args[0]);
      break;
    case "checkpoint":
      if (args.length !== 1) throw Error("Usage");
      reply = await conn.call("recovery.save");
      break;
    case "rpc":
      if (args.length !== 2) throw Error("Usage");
      reply = await conn.rawRequest(json.parse(args[1]));
      break;
    case "action": {
      // A trailing `--viewer ID` picks the viewer, as the local CLI reads it.
      const viewer = args.length >= 4 && args.at(-2) === "--viewer" ? Number(args.at(-1)) : null,
        rest = viewer === null ? args : args.slice(0, -2);
      if (rest.length < 2 || rest.length > 3 || (viewer !== null && !(Number.isInteger(viewer) && viewer > 0)))
        throw Error("Usage");
      reply = await conn.call("action", {
        name: rest[1],
        value: rest[2] ?? "",
        ...(viewer === null ? {} : { viewer }),
      });
      break;
    }
    default:
      throw Error("UnsupportedRemoteCommand");
  }
  process.stdout.write(json.stringify(reply) + "\n");
}
export async function all(local: string): Promise<void> {
  const profiles: (machines.Profile | null)[] = [null, ...machines.read()];
  const results = await Promise.all(profiles.map(p => machines.listing(p, local)));
  process.stdout.write(json.stringify({ machines: results }) + "\n");
  if (results.some(r => r && typeof r === "object" && "ok" in r && r.ok === false)) process.exitCode = 1;
}
