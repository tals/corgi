import { test, expect } from "bun:test";
import * as bug_report from "./bug_report";
import * as user_agent from "./user_agent";

test("terminals' own answers keep their name and version, in one field", () => {
  const cases: [string, string][] = [
    ["ghostty 1.3.2-main+5dc28bb8e", "ghostty 1.3.2-main+5dc28bb8e"],
    ["kitty(0.36.4)", "kitty 0.36.4"],
    ["Warp(v0.2026.10.14.08.27.stable_03)", "Warp v0.2026.10.14.08.27.stable_03"],
    ["tmux 3.4", "tmux 3.4"],
    ["", ""],
    ["  a;b,c\\d\x07é  e ", "a b c d e"],
    ["x".repeat(39) + " tail", "x".repeat(39)],
  ];
  for (const [reply, field] of cases) expect(user_agent.clean(reply)).toBe(field);
});

test("a viewer's terminal is its XTVERSION answer, else TERM_PROGRAM for Terminal.app", () => {
  const viewer = (name: string, env: Record<string, string> = {}, ssh = false) =>
    user_agent.terminal(bug_report.wireTerminal({ source: "viewer", name, env, ssh }));
  const apple = { TERM_PROGRAM: "Apple_Terminal", TERM_PROGRAM_VERSION: "455" };
  expect(viewer("kitty(0.36.4)", apple)).toEqual({ name: "kitty", label: "kitty 0.36.4" });
  expect(viewer("Warp(v0.2026.10.14.08.27.stable_03)")).toEqual({
    name: "warp",
    label: "Warp v0.2026.10.14.08.27.stable_03",
  });
  // Terminal.app doesn't answer XTVERSION.
  expect(viewer("", apple)).toEqual({ name: "apple_terminal", label: "Apple_Terminal 455" });
  // Over SSH or in a multiplexer, the variable names somewhere else.
  expect(viewer("", apple, true)).toBeNull();
  expect(viewer("", { ...apple, TMUX: "/tmp/tmux-501/default,1,0" })).toBeNull();
  expect(viewer("", { ...apple, STY: "1.pts-0" })).toBeNull();
  // Alacritty started from iTerm2 answers nothing and inherits iTerm2's variables.
  expect(viewer("", { TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.5.10" })).toBeNull();
  // Corgi's panes say ghostty, without a version.
  expect(viewer("", { TERM_PROGRAM: "ghostty" })).toBeNull();
  expect(viewer("")).toBeNull();
  expect(user_agent.terminal(bug_report.wireTerminal(null))).toBeNull();
});

test("a daemon keeps every terminal reported since it started, the newest of each", () => {
  const terminals = new user_agent.Terminals(),
    report = (name: string) => terminals.report(bug_report.wireTerminal({ source: "viewer", name, env: {} }));
  expect(terminals.list()).toEqual([]);
  report("ghostty 1.3.1");
  report("kitty(0.36.4)");
  report("");
  report("ghostty 1.3.2");
  expect(terminals.list()).toEqual(["ghostty 1.3.2", "kitty 0.36.4"]);
  // The order says nothing of which reported last.
  const release = "20261120T015223Z-cdce8d77d3f9";
  expect(user_agent.full(release, "macos-aarch64", terminals.list(), "macos 15")).toBe(
    `corgi/${release} (macos 15; aarch64; ghostty 1.3.2,kitty 0.36.4)`,
  );
  report("Apple_Terminal 455");
  // The first three by name, whatever their case.
  report("WezTerm 20240203-110809-5046fc22");
  expect(user_agent.full(release, "macos-aarch64", terminals.list(), "macos 15")).toBe(
    `corgi/${release} (macos 15; aarch64; Apple_Terminal 455,ghostty 1.3.2,kitty 0.36.4)`,
  );
});

test("the check names the release, OS, CPU and up to three terminals", () => {
  const release = "20261120T015223Z-cdce8d77d3f9";
  expect(user_agent.full(release, "macos-aarch64", ["ghostty 1.3.1"], "macos 15")).toBe(
    `corgi/${release} (macos 15; aarch64; ghostty 1.3.1)`,
  );
  expect(user_agent.full(release, "linux-x86_64", [], "linux/arch")).toBe(`corgi/${release} (linux/arch; x86_64; -)`);
  expect(user_agent.full(release, "linux-aarch64", ["foot 1.16", "ghostty 1.3"], "linux")).toBe(
    `corgi/${release} (linux; aarch64; foot 1.16,ghostty 1.3)`,
  );
  expect(user_agent.bare(release)).toBe(`corgi/${release}`);
});

test("the OS is macOS's major version, or Linux's distribution and version", () => {
  const files =
    (found: Record<string, string>) =>
    (path: string): string => {
      if (path in found) return found[path];
      throw Error("ENOENT");
    };
  const plist = (v: string) =>
    `<dict>\n\t<key>ProductName</key>\n\t<string>macOS</string>\n\t<key>ProductVersion</key>\n\t<string>${v}</string>\n</dict>`;
  const mac = "/System/Library/CoreServices/SystemVersion.plist";
  expect(user_agent.os("darwin", files({ [mac]: plist("15.3.1") }))).toBe("macos 15");
  expect(user_agent.os("darwin", files({ [mac]: plist("26.1") }))).toBe("macos 26");
  expect(user_agent.os("darwin", files({}))).toBe("macos");

  const ubuntu = 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nID_LIKE=debian\n';
  expect(user_agent.os("linux", files({ "/etc/os-release": ubuntu }))).toBe("linux/ubuntu 24.04");
  expect(user_agent.os("linux", files({ "/usr/lib/os-release": "ID='fedora'\nVERSION_ID=41\n" }))).toBe(
    "linux/fedora 41",
  );
  // Rolling releases have no version.
  expect(user_agent.os("linux", files({ "/etc/os-release": 'NAME="Arch Linux"\nID=arch\nBUILD_ID=rolling\n' }))).toBe(
    "linux/arch",
  );
  expect(user_agent.os("linux", files({}))).toBe("linux");
  expect(
    user_agent.os(
      "linux",
      files({ "/etc/os-release": ubuntu, "/proc/sys/kernel/osrelease": "5.15.167.4-microsoft-standard-WSL2\n" }),
    ),
  ).toBe("linux/ubuntu 24.04 wsl");
  expect(user_agent.os("linux", files({ "/etc/os-release": "ID=odd distro;x\nVERSION_ID=1 (a)\n" }))).toBe(
    "linux/odd-distro-x 1-a",
  );
});
