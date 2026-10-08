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
  type Endpoint,
  type Interface,
} from "./ports";
test("socket inventory scopes descendants without widening network selection", () => {
  const list = processes("10 1 10 sh\n11 10 10 bun\n12 11 12 server\n20 1 20 other\n21 20 20 server");
  const roots = [{pid:10,pane:1,workspace:1,agent_pid:0}];
  const command = socketCommand(list, roots);
  expect(command).toContain("-a");
  expect(command[command.indexOf("-p")+1]).toBe("10,11,12");
  expect(command).toContain("-iTCP");
  expect(command).toContain("-iUDP");
  const empty = socketCommand(list, []);
  expect(empty[empty.indexOf("-p")+1]).toBe(String(process.pid));
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
  expect(
    host(
      endpoint({ bind_address: "192.168.1.20", interfaces: [all[0]] }),
      true,
    ),
  ).toBe("192.168.1.20");
  expect(kind("utun4", "100.80.1.2")).toBe("tailscale");
  expect(kind("tun0", "10.8.0.2")).toBe("vpn");
});
test("lsof inventory associates descendants, ignores TCP clients, keeps UDP and IPv6 binds", () => {
  const list = processes(
      "10 1 10 root\n20 10 20 child\n21 20 20 web\n30 1 30 other\n",
    ),
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
  expect(
    url(
      endpoint({ bind_address: "127.0.0.2", scheme: "https", port: 443 }),
      false,
    ),
  ).toBe("https://127.0.0.2:443");
  expect(url(endpoint({ bind_address: "127.0.0.2" }), true)).toBeNull();
});
test("workloads count foreground servers and agent children but not shells or controllers", () => {
  const list = processes(
      "10 1 10 /opt/homebrew/bin/fish\n20 10 20 bun\n21 20 20 bun\n30 10 30 codex\n31 30 30 /bin/sh\n32 31 30 python3\n33 30 33 /opt/node\n40 1 40 unrelated\n",
    ),
    root = { pid: 10, pane: 1, workspace: 1, agent_pid: 33 };
  expect(
    list
      .filter((p) => owner(p.pid, list, [root]) && workload(p, root))
      .map((p) => p.pid),
  ).toEqual([20, 21, 32]);
  const text = list
    .map(
      (p) =>
        `p${p.pid}\ncserver\nf4\ntIPv4\nPTCP\nn127.0.0.1:${8000 + p.pid}\nTST=LISTEN\n`,
    )
    .join("");
  expect(sockets(text, list, [root], []).map((e) => e.pid)).toEqual([
    20, 21, 32,
  ]);
  expect(workload({ pid: 10, parent: 1, group: 10, name: "bun" }, root)).toBe(
    true,
  );
});
test("HTTP errors and unprobed endpoints never become browser links", () => {
  const e = endpoint({ bind_address: "127.0.0.1", http_status: null });
  expect(url(e, false)).toBeNull();
  for (const status of [101, 401, 403, 404, 500, 503])
    expect(url({ ...e, http_status: status }, false)).toBeNull();
  for (const status of [200, 206, 301, 302, 307])
    expect(url({ ...e, http_status: status }, false)).toBe(
      "http://localhost:3000",
    );
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
      workspaces: [
        { id: 1, background: 0, endpoints: [{ ...e, probed_at: 61000 }] },
      ],
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
