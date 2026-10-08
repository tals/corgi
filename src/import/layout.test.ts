import { test, expect } from "bun:test";
import { validate, Node } from "./layout";
test("import trees reject reused panes, cycles and disconnected nodes", () => {
  const good: Node[] = [
    { pane: 0 },
    { pane: 1 },
    { split: { axis: "horizontal", ratio: 600, first: 0, second: 1 } },
  ];
  validate(good, 2);
  for (const mutate of [
    (n: Node[]) => (n[1] = { pane: 0 }),
    (n: Node[]) => ((n[2] as any).split.first = 2),
    (n: Node[]) => ((n[2] as any).split.second = 0),
    (n: Node[]) => ((n[2] as any).split.ratio = 0),
  ]) {
    const bad = structuredClone(good);
    mutate(bad);
    expect(() => validate(bad, 2)).toThrow("InvalidImportLayout");
  }
  expect(() => validate([], 0)).toThrow("InvalidImportLayout");
});
