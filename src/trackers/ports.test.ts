import { test, expect } from "bun:test";
import {
  procSockets,
  procInventory,
  type Socket,
  Snapshot,
  kind,
  host,
  url,
  processes,
  sockets,
  owner,
  matching,
  workload,
  socketCommand,
  announcement,
  flagged,
  outputText,
  retryDelay,
  Tracker,
  type Endpoint,
  type Interface,
} from "./ports";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("socket inventory scopes descendants without widening network selection", () => {
  const list = processes("10 1 10 sh\n11 10 10 bun\n12 11 12 server\n20 1 20 other\n21 20 20 server");
  const roots = [{ pid: 10, pane: 1, workspace: 1, agent_pid: 0 }];
  const command = socketCommand(list, roots);
  expect(command).toContain("-a");
  expect(command[command.indexOf("-p") + 1]).toBe("10,11,12");
  expect(command).toContain("-iTCP");
  expect(command).toContain("-iUDP");
  const empty = socketCommand(list, []);
  expect(empty[empty.indexOf("-p") + 1]).toBe(String(process.pid));
});
const endpoint = (fields: Partial<Endpoint> = {}): Endpoint => ({
  label: "",
  label_pending: false,
  pid: 1,
  pane: 1,
  name: "web",
  transport: "tcp",
  bind_address: "*",
  port: 3000,
  ipv6: false,
  interfaces: [],
  scheme: "http",
  http_status: 200,
  probed_at: 0,
  ...fields,
});
test("viewer chooses only bound addresses in tailscale VPN network order", () => {
  const all: Interface[] = [
    { name: "en0", address: "192.168.1.20", kind: "network", ipv6: false },
    { name: "utun2", address: "10.8.0.2", kind: "vpn", ipv6: false },
    { name: "utun4", address: "100.80.1.2", kind: "tailscale", ipv6: false },
  ];
  const e = endpoint({ interfaces: all });
  expect(host(e, true)).toBe("100.80.1.2");
  expect(host(e, false)).toBe("localhost");
  expect(host(endpoint({ bind_address: "192.168.1.20", interfaces: [all[0]] }), true)).toBe("192.168.1.20");
  expect(kind("utun4", "100.80.1.2")).toBe("tailscale");
  expect(kind("tun0", "10.8.0.2")).toBe("vpn");
});
test("lsof inventory associates descendants, ignores TCP clients, keeps UDP and IPv6 binds", () => {
  const list = processes("10 1 10 root\n20 10 20 child\n21 20 20 web\n30 1 30 other\n"),
    roots = [{ pid: 10, pane: 1, workspace: 7, agent_pid: 0 }],
    text =
      "p21\ncweb\nf4\ntIPv4\nPTCP\nn*:3000\nTST=LISTEN\nf5\ntIPv4\nPTCP\nn127.0.0.1:51000->127.0.0.1:80\nTST=ESTABLISHED\nf6\ntIPv6\nPUDP\nn[::1]:9000\np30\ncother\nf4\ntIPv4\nPTCP\nn*:4000\nTST=LISTEN\n";
  const out = sockets(text, list, roots, []);
  expect(out).toHaveLength(2);
  expect(out[0].port).toBe(3000);
  expect(out[1].bind_address).toBe("::1");
  expect(out[1].ipv6).toBe(true);
  expect(owner(21, list, roots)?.workspace).toBe(7);
  expect(owner(30, list, roots)).toBeNull();
});
test("wildcard interface expansion respects family and explicit bind constraints", () => {
  const all: Interface[] = [
    { name: "lo0", address: "127.0.0.1", kind: "loopback", ipv6: false },
    { name: "en0", address: "192.168.1.20", kind: "network", ipv6: false },
    {
      name: "tailscale0",
      address: "fd7a:115c:a1e0::1",
      kind: "tailscale",
      ipv6: true,
    },
  ];
  expect(matching("*", false, all)).toHaveLength(2);
  expect(matching("192.168.1.20", false, all)).toEqual([all[1]]);
  expect(
    url(
      endpoint({
        bind_address: "::",
        port: 443,
        ipv6: true,
        scheme: "https",
        interfaces: matching("::", true, all),
      }),
      true,
    ),
  ).toBe("https://[fd7a:115c:a1e0::1]:443");
  expect(url(endpoint({ bind_address: "127.0.0.2", scheme: "https", port: 443 }), false)).toBe("https://127.0.0.2:443");
  expect(url(endpoint({ bind_address: "127.0.0.2" }), true)).toBeNull();
});
test("workloads count foreground servers and agent children but not shells or controllers", () => {
  const list = processes(
      "10 1 10 /opt/homebrew/bin/fish\n20 10 20 bun\n21 20 20 bun\n30 10 30 codex\n31 30 30 /bin/sh\n32 31 30 python3\n33 30 33 /opt/node\n40 1 40 unrelated\n",
    ),
    root = { pid: 10, pane: 1, workspace: 1, agent_pid: 33 };
  expect(list.filter(p => owner(p.pid, list, [root]) && workload(p, root)).map(p => p.pid)).toEqual([20, 21, 32]);
  const text = list.map(p => `p${p.pid}\ncserver\nf4\ntIPv4\nPTCP\nn127.0.0.1:${8000 + p.pid}\nTST=LISTEN\n`).join("");
  expect(sockets(text, list, [root], []).map(e => e.pid)).toEqual([20, 21, 32]);
  expect(workload({ pid: 10, parent: 1, group: 10, name: "bun" }, root)).toBe(true);
});
test("HTTP errors and unprobed endpoints never become browser links", () => {
  const e = endpoint({ bind_address: "127.0.0.1", http_status: null });
  expect(url(e, false)).toBeNull();
  for (const status of [101, 401, 403, 404, 500, 503]) expect(url({ ...e, http_status: status }, false)).toBeNull();
  for (const status of [200, 206, 301, 302, 307])
    expect(url({ ...e, http_status: status }, false)).toBe("http://localhost:3000");
});
test("a rescan that finds the same ports is not a change", () => {
  const e = endpoint({ probed_at: 1000 }),
    before = Object.assign(new Snapshot(), {
      processes_available: true,
      ports_available: true,
      workspaces: [{ id: 1, background: 0, endpoints: [e] }],
    }),
    after = Object.assign(new Snapshot(), {
      processes_available: true,
      ports_available: true,
      workspaces: [{ id: 1, background: 0, endpoints: [{ ...e, probed_at: 61000 }] }],
    });
  expect(before.same(after)).toBe(true);
  after.workspaces[0].endpoints[0].http_status = 404;
  expect(before.same(after)).toBe(false);
  after.workspaces = [];
  expect(before.same(after)).toBe(false);
});

test("proc socket tables read like lsof's addresses", () => {
  const table = new Map<string, Socket>();
  const tcp = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 101 1 0000000000000000 100 0 0 10 0",
    "   1: 00000000:0FA0 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 102 1 0000000000000000 100 0 0 10 0",
    "   2: 0100007F:C738 0100007F:0050 01 00000000:00000000 00:00000000 00000000  1000        0 103 1 0000000000000000 100 0 0 10 0",
  ].join("\n");
  procSockets(tcp, { transport: "TCP", ipv6: false, address: "", listening: false }, table);
  const udp6 = [
    "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops",
    "  0: 00000000000000000000000001000000:2328 00000000000000000000000000000000:0000 07 00000000:00000000 00:00000000 00000000  1000        0 104 2 0000000000000000 0",
  ].join("\n");
  procSockets(udp6, { transport: "UDP", ipv6: true, address: "", listening: false }, table);
  expect(table.get("101")!.address).toBe("127.0.0.1:3000");
  expect(table.get("101")!.listening).toBe(true);
  expect(table.get("102")!.address).toBe("*:4000");
  expect(table.get("103")!.listening).toBe(false);
  expect(table.get("104")!.address).toBe("[::1]:9000");
});

test("servers announce ports by URL, address or port number", () => {
  expect(announcement("  ➜  Local:   http://localhost:5173/\n", 5173)).toBe("http");
  expect(announcement("INFO:     Uvicorn running on https://0.0.0.0:8443 (Press CTRL+C to quit)", 8443)).toBe("https");
  expect(announcement("Starting vLLM server on http://[::]:8000", 8000)).toBe("http");
  expect(announcement("Server listening on port 3000", 3000)).toBe("address");
  expect(announcement("listening on [::]:8080", 8080)).toBe("address");
  expect(announcement("2026/10/08 Listening on :8080", 8080)).toBe("address");
  expect(announcement("Local: http://localhost:5174/", 5173)).toBeNull();
  expect(announcement("connected to 127.0.0.1:3000", 3000)).toBeNull();
});
test("internal and incidental mentions of a port are not announcements", () => {
  expect(announcement("NCCL INFO Bootstrap : Using eth0:10.0.0.5<42201>", 42201)).toBeNull();
  expect(announcement("[c10d] The server socket has started to listen on [::]:29500.", 29500)).toBeNull();
  expect(announcement("    at Server.listen (/app/server.js:3000:12)", 3000)).toBeNull();
  expect(announcement("I captured connections to ports 42201, 35031", 42201)).toBeNull();
  expect(announcement("", 3000)).toBeNull();
});
test("command lines announce ports chosen with a port or bind flag", () => {
  expect(flagged(["vllm", "serve", "Qwen/Qwen3-8B", "--port", "8000"], 8000)).toBe(true);
  expect(flagged(["jupyter", "lab", "--port=8888"], 8888)).toBe(true);
  expect(flagged(["gunicorn", "-b", "0.0.0.0:8000", "app:app"], 8000)).toBe(true);
  expect(flagged(["vite", "--port", "5173"], 5174)).toBe(false);
  expect(flagged(["torchrun", "--master_port", "29500", "train.py"], 29500)).toBe(false);
  expect(flagged(["python", "-m", "http.server", "8000"], 8000)).toBe(false);
  expect(flagged(["serve", "--port"], 8000)).toBe(false);
});
test("output files are read at both ends; other files read as empty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-ports-")),
    log = join(dir, "server.log");
  writeFileSync(log, "Local: http://localhost:5173/\n" + "x".repeat(300 * 1024) + "\nready on port 6006\n");
  const text = await outputText(log);
  expect(announcement(text, 5173)).toBe("http");
  expect(announcement(text, 6006)).toBe("address");
  expect(text.length).toBeLessThan(140 * 1024);
  const fifo = join(dir, "fifo");
  Bun.spawnSync(["mkfifo", fifo]);
  expect(await outputText(fifo)).toBe("");
  expect(await outputText(join(dir, "missing"))).toBe("");
});
test("probes that get no answer back off up to five minutes", () => {
  expect([1, 2, 3, 4, 5, 6, 9].map(retryDelay)).toEqual([15000, 30000, 60000, 120000, 240000, 300000, 300000]);
});
test("only listeners whose pane printed their port are probed", async () => {
  const tracker = new Tracker(),
    printed = endpoint({ pid: 999999, port: 5173, scheme: "unknown", http_status: null }),
    silent = endpoint({ pid: 999999, port: 42201, scheme: "unknown", http_status: null });
  await tracker.judge([printed, silent], 100000, () => "  ➜  Local:   http://localhost:5173/");
  expect(tracker.due(printed, 100000)).toBe(true);
  expect(tracker.due(silent, 100000)).toBe(false);
  expect(tracker.due(silent, 10_000_000)).toBe(false);
});
