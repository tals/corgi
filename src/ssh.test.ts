import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ssh from "./ssh";

test("pane data, forwarded ports and control cannot share an SSH master, while each lane reuses its own", () => {
  const control = ssh.args("example", false, false),
    data = ssh.args("example", false, false, "data"),
    forward = ssh.args("example", false, false, "forward");
  const socket = (args: string[]) => args[args.indexOf("-S") + 1];
  expect(socket(control)).not.toBe(socket(data));
  expect(new Set([control, data, forward].map(socket)).size).toBe(3);
  expect(socket(forward)).toBe(socket(ssh.args("example", false, false, "forward")));
  expect(forward).toContain("Compression=yes");
  // A command, interactive or not, rides the viewer's control master.
  expect(socket(control)).toBe(socket(ssh.args("example", true)));
  expect(socket(data)).toBe(socket(ssh.args("example", false, false, "data")));
  expect(control).toContain("Compression=yes");
  expect(control).toContain("ClearAllForwardings=yes");
  expect(data).toContain("Compression=no");
  for (const lane of ["control", "data", "forward"] as const) {
    const fresh = ssh.args("example", false, true, lane);
    expect(socket(fresh)).toBe("none");
    expect(fresh).toContain("ControlMaster=no");
  }
});
test("an SSH config's hosts are its plain Host aliases, through Includes, less patterns and forges", () => {
  const home = mkdtempSync(join(tmpdir(), "corgi-ssh-config-")),
    folder = join(home, ".ssh");
  try {
    mkdirSync(join(folder, "config.d"), { recursive: true });
    mkdirSync(join(home, ".orbstack"));
    writeFileSync(
      join(folder, "config"),
      [
        "# Hosts",
        "Include ~/.orbstack/ssh_config",
        "Host devbox gpu-box *.internal !bastion",
        "  HostName 10.0.0.5",
        "Host=nocap",
        "Host github.com",
        "  User git",
        'Host "quoted" # a comment',
        "Match host spark",
        "  User git",
        "Host *",
        "  ServerAliveInterval 30",
        "Include config.d/*.conf",
        "Include ~/.ssh/hosts/*/config",
      ].join("\n"),
    );
    writeFileSync(join(home, ".orbstack/ssh_config"), "Host orb\n  Hostname localhost\n");
    writeFileSync(join(folder, "config.d/b.conf"), "Host pi\nHost devbox\n");
    writeFileSync(join(folder, "config.d/a.conf"), "host lab\nInclude config.d/a.conf\n");
    writeFileSync(join(folder, "config.d/skipped.txt"), "Host skipped\n");
    // A wildcard can name folders too, and a config can be a link, as dotfiles keep them.
    for (const name of ["work", "home"]) mkdirSync(join(folder, "hosts", name), { recursive: true });
    writeFileSync(join(folder, "hosts/work/config"), "Host build\n");
    writeFileSync(join(home, "linked"), "Host nas\n");
    symlinkSync(join(home, "linked"), join(folder, "hosts/home/config"));
    expect(ssh.configHosts(home)).toEqual(["orb", "devbox", "gpu-box", "nocap", "quoted", "lab", "pi", "nas", "build"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  expect(ssh.configHosts(join(tmpdir(), "corgi-no-such-home"))).toEqual([]);
});

test("a failed SSH command's reason is the system's, from OpenSSH's last complaint", () => {
  expect(ssh.reason("Checking…\nssh: connect to host 10.0.0.9 port 22: Operation timed out\n")).toBe(
    "Operation timed out",
  );
  expect(ssh.reason("ssh: Could not resolve hostname pi: nodename nor servname provided, or not known")).toBe(
    "Could not resolve hostname",
  );
  expect(ssh.reason("Permission denied (publickey).")).toBeNull();
});
