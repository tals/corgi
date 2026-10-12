import { test, expect } from "bun:test";
import { Cache, parseName, keyOf, encode, type Request } from "./link_labels";
import type { Endpoint } from "./ports";
import { Text } from "../providers";
const endpoint = (fields: Partial<Endpoint> = {}): Endpoint => ({
  label: "",
  label_pending: false,
  pid: 2,
  pane: 3,
  name: "bun",
  transport: "tcp",
  bind_address: "127.0.0.1",
  port: 3000,
  ipv6: false,
  interfaces: [],
  scheme: "http",
  http_status: 200,
  probed_at: 0,
  ...fields,
});
test("link guesses are bounded display names and stale endpoint results cannot apply", () => {
  expect(parseName("Open Finance")!.text()).toBe("Finance");
  expect(parseName("Bad\x1b[2J")).toBeNull();
  expect(parseName("Here are too many words")).toBeNull();
  const cache = new Cache(),
    key = keyOf(1, endpoint());
  cache.entries[0] = {
    key,
    generation: 2n,
    pending: true,
    attempted: true,
    name: new Text(),
  };
  expect(cache.apply({ slot: 0, key, generation: 1n, name: parseName("Finance") }, 0)).toBe(false);
  expect(
    cache.apply(
      {
        slot: 0,
        key: { ...key, pid: 4 },
        generation: 2n,
        name: parseName("Finance"),
      },
      0,
    ),
  ).toBe(false);
  expect(cache.apply({ slot: 0, key, generation: 2n, name: parseName("Finance") }, 0)).toBe(true);
  expect(cache.name(1, endpoint())).toBe("Finance");
  expect(cache.name(1, endpoint({ pid: 4 }))).toBe("");
});
test("JSON escaping cannot overflow link evidence and preserves the latest terminal text", () => {
  const req: Request = {
    slot: 0,
    generation: 1n,
    key: keyOf(1, endpoint()),
    evidence: "",
    len: 0,
  };
  encode(req, {
    url: "http://localhost:3000",
    pid: 2,
    process: "bun",
    cwd: "/project",
    workspace: "Project",
    terminal_title: "Title",
    terminal: '"\\'.repeat(3000) + "LATEST",
  });
  expect(req.len).toBeLessThanOrEqual(4096);
  expect(JSON.parse(req.evidence).terminal.endsWith("LATEST")).toBe(true);
});
test("endpoint naming survives failed probes and missing scans without spending another inference", () => {
  const cache = new Cache(),
    e = endpoint(),
    terminal = {
      exited: false,
      liveText: () => "running Finance",
      vt: { getTitle: () => "" },
    },
    pane = { id: 3, cwd: "/project", terminal },
    owner = { id: 1, name: () => "Project" },
    runtime: any = {
      pane: (id: number) => (id === 3 ? pane : null),
      workspaces: { owner: () => owner },
      ports: { current: { workspaces: [{ id: 1, endpoints: [e] }] } },
    },
    requests: Request[] = [],
    worker = {
      cancelLink: () => {},
      naming: () => true,
      submitLink: (r: Request) => requests.push(r),
    };
  expect(cache.reconcile(runtime, worker, 0)).toBe(true);
  expect(requests).toHaveLength(1);
  cache.apply({ ...requests[0], name: parseName("Finance") }, 0);
  e.http_status = 500;
  expect(cache.reconcile(runtime, worker, 0)).toBe(false);
  runtime.ports.current.workspaces = [];
  expect(cache.reconcile(runtime, worker, 0)).toBe(false);
  runtime.ports.current.workspaces = [{ id: 1, endpoints: [endpoint()] }];
  expect(cache.reconcile(runtime, worker, 0)).toBe(false);
  expect(requests).toHaveLength(1);
  expect(cache.name(1, endpoint())).toBe("Finance");
  terminal.exited = true;
  expect(cache.reconcile(runtime, worker, 0)).toBe(true);
  expect(cache.entries.every(e => e === null)).toBe(true);
});
