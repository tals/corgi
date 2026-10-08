import { test, expect } from "bun:test";
import { parse, checksum } from "./tmux_layout";
const fixture = (body: string) =>
  checksum(body).toString(16).padStart(4, "0") + "," + body;
test("tmux saved layout preserves nested panes by id, not listing order", () => {
  const g = parse(
    fixture("120x40,0,0{59x40,0,0,12,60x40,60,0[60x19,60,0,3,60x20,60,20,27]}"),
  );
  expect(g.count).toBe(3);
  expect({ ...g.find("%12") }).toEqual({ x: 0, y: 0, w: 59, h: 40 });
  expect({ ...g.find("%3") }).toEqual({ x: 60, y: 0, w: 60, h: 19 });
  expect({ ...g.find("%27") }).toEqual({ x: 60, y: 20, w: 60, h: 20 });
  expect(g.find("%1")).toBe(null);
});
test("tmux layouts allow single panes and multiple siblings", () => {
  expect(parse(fixture("80x24,0,0,42")).count).toBe(1);
  const g = parse(fixture("122x24,0,0{40x24,0,0,1,40x24,41,0,2,40x24,82,0,3}"));
  expect(g.count).toBe(3);
  expect(g.find("%3")?.x).toBe(82);
});
test("tmux layouts reject malformed or incomplete snapshots", () => {
  for (const body of [
    "80x24,0,0",
    "80x24,0,0{39x24,0,0,1,40x24,40,0,2]",
    "80x24,0,0{39x24,0,0,1,40x24,40,0,1}",
    "80x24,0,0,1trailing",
    "65536x24,0,0,1",
    "0x24,0,0,1",
  ])
    expect(() => parse(fixture(body))).toThrow("InvalidTmuxLayout");
  expect(() => parse("0000,80x24,0,0,1")).toThrow("InvalidTmuxLayout");
});
