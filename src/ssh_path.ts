//! A daemon on another machine, reached over SSH. Each connection gets its
//! own tunnel, which runs Corgi's bridge on the host; connections share an
//! SSH master unless the path is fresh.
import { Connection } from "./rpc";
import { Remote, startup_ms } from "./daemon_transport";
import { image, type Profile } from "./machines";
import * as ssh from "./ssh";
import type * as machine_path from "./machine_path";
import { Endpoint } from "./machine_connection";
import type { Probe } from "./terminal_info";
import type { Host } from "./host";

export function sshPath(profile: Profile): machine_path.Factory {
  return (fresh, race) => {
    const tunnels: Remote[] = [],
      opened: Connection[] = [];
    let control: Remote | null = null;
    return {
      races: true,
      home: profile.home,
      get socket() {
        return control?.socket ?? null;
      },
      upload: (path, mime, instance, signal, progress) => image(profile, path, mime, instance, signal, progress),
      async open(kind, stats, trace) {
        // A race gives up sooner than a first connection, which may wait on a login.
        const patience = () => (race ? Math.min(startup_ms, stats.timeoutMs) : startup_ms);
        const tunnel = new Remote(profile, fresh, patience(), kind);
        tunnels.push(tunnel);
        if (kind === "control") control = tunnel;
        await tunnel.open();
        let established = false;
        const connection = new Connection(tunnel.socket, {
          compression: true,
          timeout_ms: () => (established ? stats.timeoutMs : patience()),
          stats,
          trace,
        });
        opened.push(connection);
        const hello = await connection.call("hello");
        established = true;
        return { connection, hello };
      },
      stallMs: stats => stats.stallMs,
      diagnose() {
        const detail = control?.diagnostic() ?? "";
        return { issue: ssh.failure(detail), detail };
      },
      progress: () => control?.progress() ?? "opening SSH connection",
      close() {
        for (const connection of opened) connection.close();
        for (const tunnel of tunnels) tunnel.close();
      },
    };
  };
}
/** The endpoint for an SSH machine. */
export function sshEndpoint(profile: Profile, probe: Probe, host: Host): Endpoint {
  const identity = [profile.name, profile.target, profile.executable, profile.socket, profile.home];
  return new Endpoint(profile.name, true, identity, sshPath(profile), probe, host);
}
