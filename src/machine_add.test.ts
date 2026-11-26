import { expect, test } from "bun:test";
import { Adds, Listing, note } from "./machine_add";
import * as machineUpdate from "./machine_update";
import type { Profile } from "./machines";
import type { Report } from "./machine_progress";
import type * as ssh from "./ssh";

const profile = (name: string, target = name): Profile => ({
  name,
  target,
  executable: "/corgi",
  socket: "/socket",
  home: "/home",
});
interface Run {
  name: string;
  target: string;
  progress: Report;
  resolve: (p: Profile) => void;
  reject: (e: unknown) => void;
}
interface ProbeRun {
  target: string;
  stage: (stage: ssh.Stage) => void;
  signal: AbortSignal;
  resolve: (found: ssh.Probed | null) => void;
}
/** Adds over a config naming `hosts` and a catalog of `saved`, whose adds
 * and probes wait to be settled; probes start as soon as typing stops. */
function adds(hosts: string[], saved: Profile[] = []) {
  const runs: Run[] = [],
    probes: ProbeRun[] = [];
  const a = new Adds({
    hosts: () => hosts,
    saved: () => saved,
    add: (name, target, options) => {
      const { promise, resolve, reject } = Promise.withResolvers<Profile>();
      runs.push({ name, target, progress: options!.progress!, resolve, reject });
      return promise;
    },
    probe: (target, stage, signal) => {
      const { promise, resolve } = Promise.withResolvers<ssh.Probed | null>();
      probes.push({ target, stage, signal, resolve });
      return promise;
    },
    rest_ms: 0,
  });
  const added: string[] = [];
  a.added = p => void added.push(p.name);
  return { a, runs, probes, added };
}
const rest = () => Bun.sleep(5);

test("the hosts to add leave out machines shown or saved, by name or target, and names a machine can't have", () => {
  const { a } = adds(
    ["devbox", "nocap", "local", "box@work", "pi", "old-name-target"],
    [profile("other", "old-name-target")],
  );
  expect(a.candidates([])).toEqual([]);
  a.refresh();
  expect(a.candidates(["local", "nocap"])).toEqual(["devbox", "pi"]);
  // A config or catalog that can't be read offers nothing from it.
  const broken = new Adds({
    hosts: () => {
      throw Error("EACCES");
    },
    saved: () => [],
  });
  broken.refresh();
  expect(broken.candidates([])).toEqual([]);
});

test("an add shows its progress, hands over the machine, and a failure says why and tries again", async () => {
  const { a, runs, added } = adds(["devbox", "pi"]);
  a.refresh();
  let changes = 0;
  a.changed = () => changes++;
  a.start("devbox");
  a.start("devbox");
  expect(runs.map(r => [r.name, r.target])).toEqual([["devbox", "devbox"]]);
  expect(note(a.state("devbox"), null, false)).toEqual({ text: "Checking…", tone: "warm" });
  runs[0].progress("Uploading", { compact: "↑", metrics: "40% 2.0 MiB/s" });
  expect(note(a.state("devbox"), null, true)).toEqual({ text: "↑ 40% 2.0 MiB/s", tone: "warm" });
  runs[0].resolve(profile("devbox"));
  await rest();
  expect([added, a.state("devbox")]).toEqual([["devbox"], null]);
  a.start("pi", "tal@pi");
  expect(runs[1].target).toBe("tal@pi");
  runs[1].reject(new machineUpdate.Failure("tal@pi: Permission denied (publickey).", "MachineSetupCommandFailed"));
  await rest();
  expect(note(a.state("pi"), null, false)).toEqual({ text: "can't log in", tone: "hot" });
  a.start("pi");
  runs[2].reject(new machineUpdate.Failure("Host key verification failed.", "MachineSetupCommandFailed"));
  await rest();
  expect(note(a.state("pi"), null, false)).toEqual({ text: "unknown host key", tone: "hot" });
  a.start("pi");
  const refused = "Checking pi through SSH…\nssh: connect to host 10.0.0.9 port 22: Connection refused\n";
  runs[3].reject(new machineUpdate.Failure(refused, "MachineSetupCommandFailed"));
  await rest();
  expect(note(a.state("pi"), null, false)).toEqual({ text: "Connection refused", tone: "hot" });
  a.start("pi");
  runs[4].reject(Error("RemoteDiscoveryFailed"));
  await rest();
  expect(note(a.state("pi"), null, false)).toEqual({ text: "RemoteDiscoveryFailed", tone: "hot" });
  expect(changes).toBeGreaterThan(6);
  // A host not being added says ↵ adds it only while hovered.
  expect([note(null, null, false).text, note(null, null, true).text]).toEqual(["", "add"]);
});

test("an add stopped as the viewer leaves reports nothing more", async () => {
  const { a, runs, added } = adds(["devbox"]);
  a.start("devbox");
  a.close();
  runs[0].resolve(profile("devbox"));
  await rest();
  expect(added).toEqual([]);
});

const machine = (name: string) => ({ name });
/** A list of `local` and `work`, with "all" first, over `hosts` from the SSH config. */
function listing(hosts = ["devbox", "pi-lab"]) {
  const shown = [machine("local"), machine("work")];
  const world = adds(hosts);
  const list = new Listing(() => shown, world.a, true);
  list.open();
  const labels = () =>
    list.rows().map(row => {
      switch (row.kind) {
        case "all":
          return "all";
        case "machine":
          return row.machine.name;
        case "divider":
          return "──";
        case "host":
          return row.typed ? "+ " + row.target : row.name;
      }
    });
  const type = (text: string) => {
    for (const byte of Buffer.from(text)) list.key(byte);
  };
  return { ...world, shown, list, labels, type };
}

test("typing narrows the machines and hosts, and offers a host nothing names", () => {
  const { list, labels, type } = listing();
  expect(labels()).toEqual(["all", "local", "work", "──", "devbox", "pi-lab"]);
  // A space doesn't start a search; a letter does.
  expect(list.key(32)).toBe(false);
  type("o");
  expect(labels()).toEqual(["local", "work", "──", "devbox", "+ o"]);
  expect(list.cursor).toBe(0);
  type("rk");
  expect(labels()).toEqual(["work", "──", "+ ork"]);
  // ^U clears it; a host named just as typed takes the highlight, with no offer.
  list.key(21);
  type("pi-lab");
  expect([labels(), list.cursor]).toEqual([["──", "pi-lab"], 1]);
  type("2");
  expect([labels(), list.cursor]).toEqual([["──", "+ pi-lab2"], 1]);
  // A user goes before the host it names; the machine takes the host's name.
  list.key(23);
  type("tal@gpu");
  expect(list.row()).toEqual({ kind: "host", name: "gpu", target: "tal@gpu", typed: true });
  // What can't name a machine isn't offered, nor what names one already.
  list.key(21);
  type("x y");
  expect(labels()).toEqual([]);
  list.key(21);
  type("work");
  expect(labels()).toEqual(["work"]);
});

test("the list keeps the rows any search needs, and leaving a search returns to the row it was on", () => {
  const { list, labels, type } = listing();
  const reserved = list.reserve();
  expect(reserved).toBe(6);
  for (const text of ["o", "x", "pi"]) {
    list.key(21);
    type(text);
    expect(list.rows().length).toBeLessThanOrEqual(reserved);
  }
  // With no hosts in the config, it keeps a row for the divider and one typed.
  expect(listing([]).list.reserve()).toBe(4);
  list.leave();
  list.cursor = 2;
  type("w");
  expect(list.cursor).toBe(0);
  // ⌫ edits, and once emptied, leaves the search for the row it was on.
  list.key(127);
  expect([list.query, labels()[0]]).toEqual(["", "all"]);
  list.key(127);
  expect(list.query).toBeNull();
  expect(list.leave()).toBe(false);
  expect(list.row()).toEqual({ kind: "machine", machine: { name: "work" } });
  // Moving steps over the divider, and stops at the ends.
  list.cursor = 2;
  list.move(1);
  expect(list.row()).toMatchObject({ kind: "host", name: "devbox" });
  list.move(-1);
  expect(list.cursor).toBe(2);
  list.move(-10);
  expect(list.cursor).toBe(0);
  // Searched down to hosts, the divider leads, and up stays on the first.
  type("dev");
  expect([labels(), list.cursor]).toEqual([["──", "devbox", "+ dev"], 1]);
  list.move(-1);
  expect(list.cursor).toBe(1);
});

test("a host the typing rests on is probed, and typing on stops it for the next", async () => {
  const { a, list, type, probes } = listing();
  type("pi-l");
  type("a");
  expect(probes).toEqual([]);
  await rest();
  // Only the host typing rested on.
  expect(probes.map(p => p.target)).toEqual(["pi-la"]);
  const started = a.probe("pi-la") as { stage: ssh.Stage; since: number };
  expect(started.stage).toBe("connecting");
  expect(note(null, started, false, started.since + 2500)).toEqual({ text: "connecting… 2s", tone: "warm" });
  probes[0].stage("authenticating");
  expect(note(null, a.probe("pi-la"), false, started.since)).toEqual({ text: "logging in…", tone: "warm" });
  // Typing on stops it, and it leaves nothing behind.
  type("b");
  expect(probes[0].signal.aborted).toBe(true);
  probes[0].resolve(null);
  expect(a.probe("pi-la")).toBeNull();
  await rest();
  // pi-lab, from the config, named just as typed is probed too.
  expect(probes.map(p => p.target)).toEqual(["pi-la", "pi-lab"]);
  probes[1].resolve({ system: "Linux x86_64" });
  await rest();
  expect(note(null, a.probe("pi-lab"), false)).toEqual({ text: "✓ Linux x86_64", tone: "accent" });
  // Back on a host probed since the list opened, it isn't probed again.
  list.key(127);
  type("b");
  await rest();
  expect(probes).toHaveLength(2);
  list.key(21);
  type("gone");
  await rest();
  probes[2].resolve({ failed: "error", reason: "Could not resolve hostname" });
  await rest();
  expect(note(null, a.probe("gone"), true)).toEqual({ text: "Could not resolve hostname", tone: "hot" });
  // Closing the list stops a probe waiting for the typing to rest.
  type("x");
  list.close();
  await rest();
  expect(probes).toHaveLength(3);
  // An add's progress says more than its probe.
  a.start("gone");
  expect(note(a.state("gone"), a.probe("gone"), false).text).toBe("Checking…");
});
