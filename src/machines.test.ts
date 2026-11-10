import * as machine_path from "./machine_path";
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as ssh from "./ssh";
import * as machines from "./machines";
import * as protocol from "./protocol";

test("machine catalogs stay private and reject ambiguous names and damaged data", async () => {
  const dir = mkdtempSync("/tmp/corgi-machines-");
  const file = dir + "/state/machines.json";
  const p: machines.Profile = {
    name: "work",
    target: "user@work",
    executable: "/opt/corgi",
    socket: "/tmp/corgi-1/control.sock",
    home: "/home/user",
  };
  try {
    expect(machines.read(file)).toEqual([]);
    await machines.edit(() => [p], file);
    expect(machines.read(file)).toEqual([p]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir + "/state").mode & 0o777).toBe(0o700);
    await Promise.all([
      machines.edit(profiles => [...profiles, { ...p, name: "two" }], file),
      machines.edit(profiles => [...profiles, { ...p, name: "three" }], file),
    ]);
    expect(
      machines
        .read(file)
        .map(p => p.name)
        .sort(),
    ).toEqual(["three", "two", "work"]);
    for (const value of ["local", "", "../work", "work\n", "a b"]) expect(() => machines.name(value)).toThrow();
    for (const value of ["-oProxyCommand=touch /tmp/bad", "", "host\ncmd", "host name"])
      expect(() => machines.target(value)).toThrow();
    writeFileSync(file, '{"version":2,"machines":[]}');
    expect(() => machines.read(file)).toThrow("InvalidMachineCatalog");
    writeFileSync(file, JSON.stringify({ version: 1, machines: [p, p] }));
    expect(() => machines.read(file)).toThrow("InvalidMachineCatalog");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remote commands keep shell metacharacters literal and remove inherited pane targeting", async () => {
  const value = "' ; $(printf INJECTED) `printf WRONG` $HOME \" \\ /tmp/a b\nnext";
  const child = Bun.spawn(["/bin/sh", "-c", ssh.command("/usr/bin/printf", ["%s", value])], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await new Response(child.stdout).text()).toBe(value);
  expect(await child.exited).toBe(0);
  const env = Bun.spawn(["/bin/sh", "-c", ssh.command("/usr/bin/env", [])], {
    env: { ...process.env, CORGI_PANE: "1", CORGI_MACHINE: "other" },
    stdout: "pipe",
  });
  const output = await new Response(env.stdout).text();
  expect(output).not.toContain("CORGI_PANE=");
  expect(output).not.toContain("CORGI_MACHINE=");
  expect(await env.exited).toBe(0);
});

test("a bridge an update or a reboot took away, someone else's, or one finding no daemon, is asked of the Corgi there", async () => {
  const dir = mkdtempSync("/tmp/corgi-bridge-");
  try {
    const bridge = dir + "/native/hash/bin/corgi-remote-bridge",
      corgi = dir + "/corgi";
    mkdirSync(dirname(bridge), { recursive: true });
    writeFileSync(bridge, '#!/bin/sh\necho "bridge $*"\n', { mode: 0o700 });
    writeFileSync(corgi, '#!/bin/sh\necho "corgi $*"\n', { mode: 0o700 });
    let start = true;
    const run = async (saved: string) => {
      const child = Bun.spawn(["/bin/sh", "-c", ssh.bridge(corgi, saved, "/run/corgi.sock", start)], {
        stdout: "pipe",
      });
      return (await new Response(child.stdout).text()).trim();
    };
    expect(await run(bridge)).toBe("bridge /run/corgi.sock");
    expect(await run(dir + "/gone")).toBe("corgi __remote-bridge /run/corgi.sock");
    // No daemon listening: the Corgi there starts it.
    const idle = dir + "/native/hash/bin/idle";
    writeFileSync(idle, "#!/bin/sh\nexit 3\n", { mode: 0o700 });
    expect(await run(idle)).toBe("corgi __remote-bridge /run/corgi.sock");
    // Another user's folder in /tmp, as one made after a reboot cleared it.
    expect(await run("/usr/bin/env")).toBe("corgi __remote-bridge /run/corgi.sock");
    symlinkSync(dir + "/native", dir + "/link");
    expect(await run(dir + "/link/hash/bin/corgi-remote-bridge")).toBe("corgi __remote-bridge /run/corgi.sock");
    // Asked not to start one, as after a deliberate shutdown: nothing listening stays so.
    start = false;
    expect(await run(idle)).toBe("");
    expect(await run(bridge)).toBe("bridge /run/corgi.sock");
    expect(await run(dir + "/gone")).toBe("corgi __remote-bridge --running /run/corgi.sock");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remote discovery refuses a mismatched viewer and missing incarnation", () => {
  const info = {
    remote_protocol: 1,
    protocol: protocol.version,
    viewer_protocol: protocol.viewer_version,
    executable: "/bin/corgi",
    home: "/home/t",
    socket: "/tmp/corgi/s",
  };
  expect(machines.info(info)).toEqual(info);
  expect(() => machines.info({ ...info, viewer_protocol: 99 })).toThrow("IncompatibleRemoteCorgi");
  expect(() => machines.info({ ...info, socket: "../s" })).toThrow();
  expect(() => machines.info({ ...info, socket: "/tmp/a:b" })).toThrow();
  expect(() =>
    machine_path.compatible({
      type: "hello",
      protocol: 1,
      capabilities: [],
      server_pid: 1,
      build_id: "",
      executable: "",
      release_version: "",
      update_abi: "",
    }),
  ).toThrow("IncompatibleRemoteCorgi");
});
