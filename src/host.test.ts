import { expect, test } from "bun:test";
import { Host } from "./host";
import { Probe } from "./terminal_info";

test("the host reports a badge change once, and learns branch glyphs from XTVERSION", () => {
  const host = new Host();
  const probe = new Probe();
  expect(host.observe(probe, null)).toBe(true);
  probe.badge.status = "ready";
  probe.badge.supports_kitty_graphics = true;
  expect(host.observe(probe, { width: 8, height: 16 })).toBe(true);
  expect(host.corgi_badge).toBe("pending");
  expect(host.cell_pixels).toEqual({ width: 8, height: 16 });
  expect(host.observe(probe, { width: 8, height: 16 })).toBe(false);
  expect(host.branch_glyphs).toBe(false);
  probe.clipboard.terminalName("ghostty 1.3.1");
  host.observe(probe, null);
  expect(host.branch_glyphs).toBe(true);
});
