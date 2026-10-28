import { test, expect } from "bun:test";
import { geometry, aimed, draw, hoverAt, State, buttonAt, rowAt } from "./resource_tooltip";
import { Rect } from "./layout";
import { Writer } from "./text";
import { Terminal } from "./pane/terminal";
import * as sim from "./providers/sim";
test("resource card stays within terminal bounds", () => {
  for (const cols of [68, 88, 120, 200])
    for (const rows of [24, 30, 40]) {
      const r = geometry(cols, rows, 28, rows - 1)!;
      expect(r.x + r.w).toBeLessThan(cols);
      expect(r.y + r.h).toBeLessThan(rows);
    }
});
test("aim triangle spans from the row exit to the card's left edge", () => {
  const card = new Rect(28, 4, 82, 24),
    exit = { x: 4, y: 4 };
  for (const [x, y] of [
    [8, 7],
    [14, 10],
    [20, 13],
    [27, 26],
  ])
    expect(aimed(card, exit, x, y)).toBe(true);
  expect(aimed(card, exit, 4, 5)).toBe(true);
  for (const [x, y] of [
    [4, 6],
    [3, 5],
    [20, 3],
    [27, 28],
    [28, 10],
  ])
    expect(aimed(card, exit, x, y)).toBe(false);
  const lifted = new Rect(28, 10, 82, 24);
  expect(aimed(lifted, { x: 4, y: 30 }, 16, 24)).toBe(true);
  expect(aimed(lifted, { x: 4, y: 30 }, 16, 36)).toBe(false);
  expect(aimed(new Rect(2, 4, 82, 24), exit, 3, 5)).toBe(false);
});
test("agent processes carry their provider's mark, which the legend explains", () => {
  const remove = sim.register();
  try {
    const state = new State(),
      work = { id: 1, known: true, count: 1, processes: [{ pid: 7, start: 1n, name: "sim", provider: sim.sim }] };
    state.update(work, true);
    const w = new Writer();
    draw(w, new Rect(0, 0, 82, 24), "corgi", { workspaces: [work] }, state);
    expect(w.buffered()).toContain("§ sim");
    expect(w.buffered()).toContain("† Codex   * Claude Code   π Pi   o OpenCode   G Goose   § Simulated Agent");
  } finally {
    remove();
  }
});
test("process rows freeze by identity while their numbers can refresh", () => {
  const state = new State(),
    processes = [
      { pid: 1, start: 10n, name: "first", cpu: 90 },
      { pid: 2, start: 20n, name: "second", cpu: 10 },
    ],
    work = { id: 1, known: true, processes };
  state.update(work, true);
  processes[0].cpu = 0;
  processes[1].cpu = 100;
  state.update(work, true);
  expect(state.order[0].pid).toBe(1);
  state.update(work, false);
  expect(state.order[0].pid).toBe(2);
});
test("a second click on the sorted heading turns the order around, unsampled processes last", () => {
  const state = new State({ workspace: 1 }),
    rect = new Rect(28, 4, 82, 24),
    processes = [
      { pid: 1, start: 10n, name: "busy", cpu: 90 },
      { pid: 2, start: 20n, name: "unsampled", cpu: null },
      { pid: 3, start: 30n, name: "quiet", cpu: 10 },
    ],
    work = { id: 1, known: true, processes },
    heading = () => {
      const w = new Writer(),
        terminal = new Terminal(120, 30);
      try {
        draw(w, rect, "repo", { workspaces: [work] }, state);
        terminal.feed(w.buffered());
        return terminal.text().split("\n")[rect.y + 14];
      } finally {
        terminal.destroy();
      }
    };
  state.update(work, false);
  expect(state.order.map(p => p.pid)).toEqual([1, 3, 2]);
  expect(heading()).toMatch(/↓CPU % +GiB +R MB\/s +W MB\/s/);
  state.click(rect, rect.x + rect.w - 28, rect.y + 14);
  state.update(work, false);
  expect(state.order.map(p => p.pid)).toEqual([3, 1, 2]);
  expect(heading()).toContain("↑CPU %");
  // Another heading starts from the most again; both disk columns are marked.
  state.click(rect, rect.x + rect.w - 5, rect.y + 14);
  expect(state.ascending).toBe(false);
  expect(heading()).toMatch(/↓R MB\/s ↓W MB\/s/);
});
test("a host with GPUs gets a GPU row and columns that stay while workspaces go idle", () => {
  const rect = geometry(160, 40, 28, 4, 2)!,
    processes = [
      { pid: 1, start: 10n, name: "train", cpu: 50, gpu: 130, gpu_memory: 8n << 30n },
      { pid: 2, start: 20n, name: "kv-cache", cpu: 5, gpu: 0, gpu_memory: 12n << 30n },
      { pid: 3, start: 30n, name: "sh", cpu: 0 },
    ],
    share = (index: number, util: number) => ({ index, util, memory: 4n << 30n }),
    work = {
      id: 1,
      known: true,
      count: 3,
      cpu: 55,
      memory: 1n << 30n,
      gpu: 150,
      gpu_memory: 8n << 30n,
      gpu_shown: true,
      gpu_devices: [share(0, 100), share(1, 50)],
      processes,
      history: [
        {
          at: 0,
          samples: 5,
          cpu: 10,
          gpus: [share(0, 100), share(1, 100)],
          processes: [
            {
              pid: 7,
              start: 1n,
              name: "old-train",
              gpu: 90,
              gpu_memory: 1n << 30n,
              gpu_devices: [share(0, 90), share(1, 0)],
            },
            { pid: 8, start: 1n, name: "old-cache", gpu: 10, gpu_memory: 6n << 30n, gpu_devices: [share(1, 10)] },
          ],
        },
        { at: 5000, samples: 5, cpu: 20, gpus: [share(0, 100), share(1, 0)] },
      ],
    },
    snapshot = {
      gpu_memory_kind: "VRAM",
      gpus: [0, 1].map(index => ({ index, name: "GPU", util: 50, used: 10n << 30n, total: 48n << 30n })),
      workspaces: [work],
    },
    screen = (pointer: { x: number; y: number } | null = null) => {
      const w = new Writer(),
        terminal = new Terminal(160, 40);
      try {
        draw(w, rect, "repo", snapshot, state, pointer);
        terminal.feed(w.buffered());
        return terminal.text().split("\n");
      } finally {
        terminal.destroy();
      }
    },
    state = new State();
  expect([rect.w, rect.h]).toEqual([82, 32]);
  expect(geometry(160, 40, 28, 4)!.h).toBe(24);
  expect(geometry(160, 40, 28, 4, 8)!.h).toBe(36);
  state.update(work, false, 2);
  let lines = screen();
  const top = rect.y + 11;
  expect(lines[rect.y + 3]).toMatch(/cpu .* memory /);
  // The history's span and its ceiling sit in the dashed border over it.
  expect(lines[top]).toMatch(/gpu 0-1 ─+┄ 2m ┄+ 100% ─┐.*vram ─+┄ 2m ┄+ 48G ─┐/);
  expect(lines[top + 1]).toContain("150%");
  expect(lines[top + 1]).toContain("8.00 GiB");
  // Two devices in four lines: each meter two lines tall, its branch at the foot.
  expect(lines[top + 2]).toMatch(/│ │ +[▁-█]/);
  expect(lines[top + 3]).toMatch(/├ 0 █ 100%/);
  expect(lines[top + 5]).toMatch(/└ 1 █ 50%/);
  expect(lines[top + 4]).toMatch(/│ │   [ ] /);
  // Both devices were full at the older point and one at the newer, so its
  // cell at the ceiling shades lighter, with nothing under either.
  expect(lines[top + 1]).toMatch(/█▒ │/);
  expect(lines[top + 5]).toMatch(/└ 1 █ 50% +│/);
  expect(lines[rect.y + 19]).toContain("2 GPUs 50% / 20.0 of 96 GiB");
  // Pointing at the older point gives its figures in every graph.
  const gpuChart = rect.x + 2 + 17,
    chartEnd = rect.x + 2 + Math.floor((rect.w - 5) / 2) - 3;
  lines = screen({ x: chartEnd - 1, y: top + 3 });
  expect(lines[top]).toContain("5s ago");
  expect(lines[top + 1]).toContain("200%");
  expect(lines[top + 3]).toMatch(/├ 0 █ 100%/);
  expect(lines[top + 5]).toMatch(/└ 1 █ 100%/);
  expect(lines[rect.y + 4]).toContain("10%");
  // Its middle line holds neither device, so the table keeps the point's leaders.
  expect(hoverAt(rect, 2, gpuChart, top + 3)).toEqual({ metric: "gpu", age: chartEnd - gpuChart, line: 2 });
  expect(hoverAt(rect, 2, gpuChart - 2, top + 3)).toBeNull();
  // The table lists that point's leaders by the hovered graph's figure, with their devices.
  const header0 = rect.y + 22;
  expect(lines[header0]).toMatch(/CPU % +GiB +↓GPU % +VRAM/);
  expect(lines[header0 + 1]).toMatch(/old-train gpu 0-1 .* 90\.0/);
  expect(lines[header0 + 2]).toMatch(/old-cache gpu 1 .* 10\.0/);
  expect(lines[rect.y + rect.h - 2]).toContain("2 leading processes 5s ago");
  // Over the vram box they sort by memory instead.
  lines = screen({ x: chartEnd + 38, y: top + 3 });
  expect(lines[header0]).toMatch(/GPU % +↓VRAM/);
  expect(lines[header0 + 1]).toMatch(/old-cache gpu 1 /);
  const header = rect.y + 22;
  lines = screen();
  expect(lines[header]).toMatch(/↓CPU % +GiB +GPU % +VRAM +R MB\/s +W MB\/s/);
  state.click(rect, rect.x + rect.w - 30, header);
  state.update(work, false, 2);
  expect(state.sort).toBe("gpu");
  expect(state.order.map(p => p.pid)).toEqual([1, 2, 3]);
  state.click(rect, rect.x + rect.w - 20, header);
  state.update(work, false, 2);
  expect(state.sort).toBe("gpu_memory");
  expect(state.order.map(p => p.pid)).toEqual([2, 1, 3]);
  lines = screen();
  expect(lines[header + 1]).toMatch(/kv-cache .* 0\.0 +12\.00/);
  // Once the hold lapses only the figures go; the layout and sort stay.
  work.gpu_shown = false;
  state.update(work, false, 2);
  expect(state.sort).toBe("gpu_memory");
  lines = screen();
  expect(lines[top]).toMatch(/gpu .* vram /);
  expect(lines[top + 1]).toContain("no use");
  expect(lines[header]).toMatch(/CPU % +GiB +GPU % +↓VRAM +R MB\/s +W MB\/s/);
  // A card too short for the GPU row keeps the columns.
  const short = geometry(160, 28, 28, 0, 2)!;
  expect(short.h).toBe(26);
  state.click(short, short.x + short.w - 30, short.y + 14);
  expect(state.sort).toBe("gpu");
});

test("GPU trees pack devices that outnumber their lines", () => {
  const rect = geometry(160, 44, 28, 0, 12)!,
    work = {
      id: 1,
      known: true,
      cpu: 1,
      gpu: 120,
      gpu_memory: 12n,
      gpu_shown: true,
      gpu_devices: Array.from({ length: 12 }, (_, index) => ({ index, util: 10, memory: 1n })),
    },
    snapshot = { gpus: Array.from({ length: 12 }, (_, index) => ({ index, total: 1n << 30n })), workspaces: [work] },
    state = new State(),
    w = new Writer(),
    terminal = new Terminal(160, 44);
  state.update(work, false, 12);
  try {
    draw(w, rect, "repo", snapshot, state);
    terminal.feed(w.buffered());
    const lines = terminal.text().split("\n");
    // Twelve devices over eight lines: two a line.
    expect(lines[rect.y + 13]).toMatch(/├ 0▁ 1▁ /);
    expect(lines[rect.y + 17]).toMatch(/├ 8▁ 9▁ /);
    expect(lines[rect.y + 18]).toMatch(/└ 10▁ 11▁/);
  } finally {
    terminal.destroy();
  }
});

test("pointing at a graph's history shows that point's figures and leaders", () => {
  const rect = geometry(120, 40, 28, 4)!,
    proc = (pid: number, name: string, cpu: number, memory: bigint) => ({
      pid,
      start: 1n,
      name,
      cpu,
      memory,
      read: 0n,
      written: 0n,
    }),
    work = {
      id: 1,
      known: true,
      count: 2,
      cpu: 5,
      memory: 1n << 30n,
      read: 0n,
      written: 0n,
      processes: [proc(1, "shell", 5, 1n << 30n)],
      history: [
        {
          at: 0,
          samples: 5,
          cpu: 80,
          memory: 3n << 30n,
          io: 0n,
          processes: [proc(2, "build", 70, 1n << 30n), proc(3, "cache", 10, 2n << 30n)],
        },
        { at: 5000, samples: 5, cpu: 5, memory: 1n << 30n, io: 0n, processes: [proc(1, "shell", 5, 1n << 30n)] },
      ],
    },
    snapshot = { workspaces: [work] },
    state = new State(),
    screen = (pointer: { x: number; y: number } | null) => {
      const w = new Writer(),
        terminal = new Terminal(120, 40);
      try {
        draw(w, rect, "repo", snapshot, state, pointer);
        terminal.feed(w.buffered());
        return terminal.text().split("\n");
      } finally {
        terminal.destroy();
      }
    };
  state.update(work, false);
  const end = rect.x + 2 + 25 - 3,
    header = rect.y + 14;
  expect(hoverAt(rect, 0, end - 1, rect.y + 5)).toEqual({ metric: "cpu", age: 1, line: null });
  expect(hoverAt(rect, 0, end + 1, rect.y + 5)).toBeNull();
  let lines = screen(null);
  expect(lines[rect.y + 4]).toContain("5%");
  expect(lines[header + 1]).toContain("shell");
  // Over the cpu graph, five seconds back: its figure, and its leaders by CPU.
  lines = screen({ x: end - 1, y: rect.y + 5 });
  expect(lines[rect.y + 4]).toContain("80%");
  expect(lines[header]).toMatch(/↓CPU %/);
  expect(lines[header + 1]).toMatch(/build +70\.0/);
  expect(lines[header + 2]).toMatch(/cache +10\.0/);
  expect(lines[rect.y + rect.h - 2]).toContain("2 leading processes 5s ago");
  // Over the memory graph the same point's leaders sort by memory.
  lines = screen({ x: end + 26 - 1, y: rect.y + 5 });
  expect(lines[rect.y + 4]).toContain("3.00 GiB");
  expect(lines[header]).toMatch(/↓GiB/);
  expect(lines[header + 1]).toMatch(/cache /);
});
test("a GPU heatmap cell lists the processes on the GPUs at its line", () => {
  const rect = geometry(160, 40, 28, 4, 4)!,
    utils = [95, 95, 95, 40],
    shares = () => utils.map((util, index) => ({ index, util, memory: 1n << 30n })),
    ranks = () =>
      shares().map(share => ({
        pid: 10 + share.index,
        start: 1n,
        name: `rank${share.index}`,
        gpu: share.util,
        gpu_memory: share.memory,
        gpu_devices: [share],
      })),
    work = {
      id: 1,
      known: true,
      count: 4,
      cpu: 0,
      memory: 0n,
      gpu: 325,
      gpu_memory: 4n << 30n,
      gpu_shown: true,
      gpu_devices: shares(),
      processes: ranks(),
      history: [{ at: 0, samples: 5, cpu: 0, gpus: shares(), processes: ranks() }],
    },
    snapshot = {
      gpu_memory_kind: "VRAM",
      gpus: utils.map((_, index) => ({ index, name: "GPU", util: 50, used: 1n << 30n, total: 48n << 30n })),
      workspaces: [work],
    },
    state = new State(),
    screen = (pointer: { x: number; y: number }) => {
      const w = new Writer(),
        terminal = new Terminal(160, 40);
      try {
        draw(w, rect, "repo", snapshot, state, pointer);
        terminal.feed(w.buffered());
        return terminal.text().split("\n");
      } finally {
        terminal.destroy();
      }
    };
  state.update(work, false, 4);
  // Five lines of heatmap under the box's top: 95% reaches the top one, 40% the second.
  const top = rect.y + 11,
    newest = rect.x + 2 + Math.floor((rect.w - 5) / 2) - 3,
    header = rect.y + 22;
  expect(hoverAt(rect, 4, newest, top + 4)).toEqual({ metric: "gpu", age: 0, line: 1 });
  let lines = screen({ x: newest, y: top + 4 });
  expect(lines[header + 1]).toMatch(/rank3 gpu 3 /);
  expect(lines[header + 2]).not.toContain("rank");
  expect(lines[rect.y + rect.h - 2]).toContain("1 process on gpu 3 0s ago");
  lines = screen({ x: newest, y: top + 1 });
  expect(lines[header + 3]).toMatch(/rank\d gpu [0-2] /);
  expect(lines[header + 4]).not.toContain("rank");
  expect(lines[rect.y + rect.h - 2]).toContain("3 processes on gpu 0-2 0s ago");
});
test("a pinned card keeps its rows put: new processes join at the foot, gone ones stay as gone", () => {
  const state = new State(),
    processes = [
      { pid: 1, start: 10n, name: "first", cpu: 90 },
      { pid: 2, start: 20n, name: "second", cpu: 10 },
    ],
    work = { id: 1, known: true, processes };
  state.update(work, true);
  state.pin();
  state.move(1);
  processes[0].cpu = 0;
  processes[1].cpu = 100;
  processes.push({ pid: 3, start: 30n, name: "third", cpu: 500 });
  state.update(work, true);
  expect(state.order.map(k => k.pid)).toEqual([1, 2, 3]);
  expect(state.selected?.pid).toBe(2);
  processes.shift();
  state.update(work, true);
  const w = new Writer(),
    terminal = new Terminal(120, 30);
  try {
    draw(w, new Rect(0, 0, 82, 24), "repo", { workspaces: [work] }, state);
    terminal.feed(w.buffered());
    expect(terminal.text().split("\n")[15]).toMatch(/1 exited/);
  } finally {
    terminal.destroy();
  }
  // Sorting again moves the rows, and the selection goes with its process.
  state.step(true);
  state.update(work, true);
  expect(state.sort).toBe("memory");
  expect(state.selected?.pid).toBe(2);
});
test("the selection scrolls the table and stays on its process", () => {
  const processes = Array.from({ length: 12 }, (_, i) => ({ pid: i + 1, start: 1n, name: `p${i}`, cpu: 100 - i })),
    state = new State();
  state.update({ id: 1, processes }, true);
  state.pin();
  for (let i = 0; i < 7; i++) state.move(1);
  state.reveal(5);
  expect([state.selected?.pid, state.offset]).toEqual([8, 3]);
  state.move(-10);
  state.reveal(5);
  expect([state.selected?.pid, state.offset]).toEqual([1, 0]);
});
test("tags work as htop's: space tags and moves down, c tags a process and what it started", () => {
  const processes = [
      { pid: 10, start: 1n, name: "shell", cpu: 4, parent: 1 },
      { pid: 11, start: 1n, name: "vite", cpu: 3, parent: 10 },
      { pid: 12, start: 1n, name: "esbuild", cpu: 2, parent: 11 },
      { pid: 13, start: 1n, name: "other", cpu: 1, parent: 1 },
    ],
    state = new State();
  state.update({ id: 1, processes }, true);
  state.pin();
  expect(state.targets().map(k => k.pid)).toEqual([10]);
  state.move(1);
  state.tagTree(processes);
  expect(state.targets().map(k => k.pid)).toEqual([11, 12]);
  state.untag();
  state.toggle();
  expect([state.targets().map(k => k.pid), state.selected?.pid]).toEqual([[11], 12]);
  state.toggle();
  expect(state.targets().map(k => k.pid)).toEqual([11, 12]);
});
test("the pinned card's bar names where the process runs, then asks before a signal", () => {
  const processes = [{ pid: 98112, start: 1n, name: "vite", cpu: 20, pane: 3 }],
    rect = new Rect(0, 0, 82, 24),
    state = new State({ place: "api › tab 2" }),
    screen = () => {
      const w = new Writer(),
        terminal = new Terminal(120, 30);
      try {
        draw(w, rect, "api", { workspaces: [{ id: 1, known: true, processes }] }, state);
        terminal.feed(w.buffered());
        return terminal.text().split("\n");
      } finally {
        terminal.destroy();
      }
    };
  state.update({ id: 1, processes }, true);
  state.pin();
  let lines = screen();
  expect(lines[21]).toMatch(/vite · api › tab 2 +↵ go to pane +t term +k kill/);
  expect(lines[22]).toContain("↑↓ select  ←→ sort  space tag");
  const kill = lines[21].indexOf("k kill");
  expect(buttonAt(rect, kill, 21)).toBe("kill");
  expect(buttonAt(rect, lines[21].indexOf("go to pane"), 21)).toBe("go");
  expect(buttonAt(rect, kill, 20)).toBe(null);
  expect(rowAt(rect, 20, 15)).toBe(0);
  state.confirm = "kill";
  lines = screen();
  expect(lines[21]).toContain("Kill vite (98112) with SIGKILL? k again · esc");
});
