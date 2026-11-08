import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Menu } from "./connectivity_menu";
import { Endpoint } from "./machine_connection";
import { Host } from "./host";
import { Probe } from "./terminal_info";
import { Terminal } from "./pane/terminal";
import type { Command } from "./remote_lab";

const endpoints = () =>
  [null, "slowloris", "finnicky", "goodboy"].map(
    name =>
      new Endpoint(
        name ? { name, target: name, socket: "/tmp/unused.sock", home: "/tmp", executable: "/tmp/corgi" } : null,
        "/tmp/unused.sock",
        new Probe(),
        new Host(),
      ),
  );

test("developer console keeps navigation and close visible on short screens", () => {
  const menu = new Menu(endpoints(), "");
  menu.toggle(0);
  for (const [cols, rows] of [
    [112, 38],
    [80, 24],
    [40, 12],
  ]) {
    const terminal = new Terminal(cols, rows);
    try {
      terminal.feed(menu.draw(cols, rows));
      expect(terminal.text()).toContain("Developer");
      expect(terminal.text()).toContain("Remote");
      expect(terminal.text()).toContain("slowloris");
      expect(terminal.text()).toContain("Esc close");
      menu.mouse(cols - 5, rows - 5, 65, true);
      terminal.feed(menu.draw(cols, rows));
      expect(terminal.text()).toContain("Esc close");
    } finally {
      terminal.destroy();
    }
  }
});

test("machine selection and keyboard scrolling expose policy controls without losing queued input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-console-")),
    socket = join(dir, "control.sock");
  const commands: Command[] = [];
  const server = createServer(client => {
    let input = "";
    client.on("data", bytes => {
      input += bytes;
      if (!input.includes("\n")) return;
      commands.push(JSON.parse(input));
      setTimeout(
        () =>
          client.end(
            JSON.stringify({
              slowloris: {
                latency_ms: 800,
                bandwidth_kib: 0,
                outage_until: 0,
                hang_seconds: 5,
                hang_every_seconds: 0,
                next_hang_at: 0,
                accepted: 1,
              },
            }) + "\n",
          ),
        10,
      );
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  const menu = new Menu(endpoints(), socket),
    terminal = new Terminal(100, 24);
  try {
    menu.toggle(0);
    menu.key("\x1b[B", null);
    expect(menu.selected).toBe(1);
    menu.tick();
    await Bun.sleep(30);
    terminal.feed(menu.draw(100, 24));
    menu.key("\t", 9);
    terminal.feed(menu.draw(100, 24));
    expect(terminal.text()).toContain("One-way lag");
    // A poll is in flight while two different settings are changed.
    menu.key("\x1b[C", null);
    menu.key("\x1b[B", null);
    menu.key("\x1b[C", null);
    await Bun.sleep(60);
    expect(commands.some(c => c.machine === "slowloris" && c.latency_ms === 850)).toBe(true);
    expect(commands.some(c => c.machine === "slowloris" && c.bandwidth_kib === 128)).toBe(true);
    for (let i = 0; i < 6; i++) menu.key("\x1b[B", null);
    terminal.feed(menu.draw(100, 24));
    expect(terminal.text()).toContain("Reset network");
    expect(terminal.text()).toContain("Esc close");
  } finally {
    terminal.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("response heatmap keeps fixed latency bands when a high spike expires", () => {
  const machines = endpoints(),
    menu = new Menu(machines, ""),
    terminal = new Terminal(112, 38);
  try {
    const stats = machines[0].stats;
    stats.answer(15000, false);
    stats.answer(40, false);
    terminal.feed(menu.draw(112, 38));
    const bands = [">10 s", "2–10 s", "0.5–2 s", "100–500 ms", "≤100 ms"];
    for (const band of bands) expect(terminal.text()).toContain(band);
    expect(terminal.text()).not.toContain("s / cell");
    expect(terminal.text()).not.toContain("Last data");
    expect(terminal.text()).not.toContain("Stall after");
    expect(terminal.text()).not.toContain("15.00 s │");
    stats.history.length = 0;
    stats.answer(40, false);
    terminal.feed(menu.draw(112, 38));
    for (const band of bands) expect(terminal.text()).toContain(band);
  } finally {
    terminal.destroy();
  }
});
