import { expect, test } from "bun:test";
import { Notice } from "./machine_diagnostics";
import { Endpoint } from "./machine_connection";
import { Host } from "./host";
import { Probe } from "./terminal_info";
import { Terminal } from "./pane/terminal";
import * as ssh from "./ssh";

test("SSH diagnostics distinguish authentication and host identity from transient failures", () => {
  expect(ssh.failure("Permission denied (publickey,password).")).toBe("auth");
  expect(ssh.failure("sign_and_send_pubkey: signing failed: agent refused operation")).toBe("auth");
  expect(ssh.failure("WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!")).toBe("host-key");
  expect(ssh.failure("Host key verification failed.")).toBe("host-key");
  expect(ssh.failure("connect to host build port 22: Connection timed out")).toBe("error");
  expect(ssh.failure("sh: /corgi: Permission denied")).toBe("error");
});

test("diagnostics remain readable after recovery and scroll to a usable repair command", () => {
  const endpoint = new Endpoint(
    { name: "work", target: "work", executable: "/corgi", socket: "/socket", home: "/home" },
    "/local",
    new Probe(),
    new Host(),
  );
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
  const endpoint = new Endpoint(
    { name: "work", target: "work", executable: "/corgi", socket: "/socket", home: "/home" },
    "/local",
    new Probe(),
    new Host(),
  );
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
