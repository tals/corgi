import { sshEndpoint } from "./ssh_path";
import { expect, test } from "bun:test";
import { Notice } from "./machine_diagnostics";
import { Endpoint } from "./machine_connection";
import { Failure } from "./machine_update";
import * as machine_path from "./machine_path";
import { Host } from "./host";
import { Probe } from "./terminal_info";
import { Terminal } from "./pane/terminal";
import * as ssh from "./ssh";

/** An SSH machine named "work". */
const work = () =>
  sshEndpoint(
    { name: "work", target: "work", executable: "/corgi", socket: "/socket", home: "/home" },
    new Probe(),
    new Host(),
  );
test("SSH diagnostics distinguish authentication and host identity from transient failures", () => {
  expect(ssh.failure("Permission denied (publickey,password).")).toBe("auth");
  expect(ssh.failure("sign_and_send_pubkey: signing failed: agent refused operation")).toBe("auth");
  expect(ssh.failure("WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!")).toBe("host-key");
  expect(ssh.failure("Host key verification failed.")).toBe("host-key");
  expect(ssh.failure("connect to host build port 22: Connection timed out")).toBe("error");
  expect(ssh.failure("sh: /corgi: Permission denied")).toBe("error");
});

test("diagnostics remain readable after recovery and scroll to a usable repair command", () => {
  const endpoint = work();
  endpoint.status = "attention";
  endpoint.issue = "auth";
  endpoint.error = "Permission denied (publickey). " + "long diagnostic ".repeat(40);
  const notice = new Notice();
  notice.show(endpoint);
  endpoint.error = "";
  const terminal = new Terminal(60, 15);
  try {
    terminal.feed(notice.draw(60, 15));
    expect(terminal.text()).toContain("Authentication required");
    notice.scroll(1000);
    terminal.feed("\x1b[2J" + notice.draw(60, 15));
    expect(terminal.text()).toContain("corgi machine reconnect work");
    notice.key("\x1b", 27);
    expect(notice.open).toBe(false);
  } finally {
    terminal.destroy();
  }
});

test("incompatible diagnostics suggest a read-only status check", () => {
  const endpoint = work();
  endpoint.status = "incompatible";
  endpoint.error = "IncompatibleRemoteCorgi";
  const notice = new Notice();
  notice.show(endpoint);
  const terminal = new Terminal(80, 25);
  try {
    terminal.feed(notice.draw(80, 25));
    expect(terminal.text()).toContain("corgi machine status work");
    expect(terminal.text()).not.toContain("machine check");
  } finally {
    terminal.destroy();
  }
});

test("a machine another viewer moved says how to take it back, and why taking it back failed", () => {
  const endpoint = new Endpoint(
    "work",
    true,
    ["work"],
    machine_path.local("/nonexistent/control.sock"),
    new Probe(),
    new Host(),
    async () => null,
  );
  endpoint.status = "incompatible";
  endpoint.error = "IncompatibleRemoteCorgi";
  Reflect.set(endpoint, "updateFailure", new Failure("curl: (6) Could not resolve host", "MachineSetupCommandFailed"));
  const notice = new Notice();
  notice.show(endpoint);
  const terminal = new Terminal(100, 25);
  try {
    terminal.feed(notice.draw(100, 25));
    expect(terminal.text()).toContain("Ctrl+R moves it back");
    expect(terminal.text()).toContain("Could not resolve host");
  } finally {
    terminal.destroy();
  }
});

test("with no problem to show, details don't open and the key stays the pane's", () => {
  const endpoint = work();
  endpoint.status = "incompatible";
  endpoint.error = "";
  const notice = new Notice();
  expect(notice.show(endpoint)).toBe(false);
  expect(notice.open).toBe(false);
  endpoint.error = "Connection refused";
  expect(notice.show(endpoint)).toBe(true);
  expect(notice.open).toBe(true);
});
