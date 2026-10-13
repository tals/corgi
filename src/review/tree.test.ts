import { expect, test } from "bun:test";
import * as tree from "./tree";

const names = (rows: tree.Row[]) =>
  rows.map(r => "  ".repeat(r.depth) + (r.kind === "dir" ? `${r.open ? "▾" : "▸"} ${r.name}/` : r.name));

test("directories come first, and single-child chains join", () => {
  const rows = tree.rows(["src/b.ts", "src/a.ts", "README.md", "src/generated/x/w.ts"], new Set());
  expect(names(rows)).toEqual(["▾ src/", "  ▾ generated/x/", "    w.ts", "  a.ts", "  b.ts", "README.md"]);
});

test("a crowded directory starts folded and opens when toggled", () => {
  const snaps = Array.from({ length: 13 }, (_, i) => `tests/snap/${String(i).padStart(2, "0")}.snap`);
  const folded = tree.rows([...snaps, "a.ts"], new Set());
  expect(names(folded)).toEqual(["▸ tests/snap/", "a.ts"]);
  const dir = folded[0] as tree.Row & { kind: "dir" };
  expect(dir.files.length).toBe(13);
  const open = tree.rows([...snaps, "a.ts"], tree.setOpen(new Set(), dir, true));
  expect(open.length).toBe(15);
  expect(tree.setOpen(tree.setOpen(new Set(), dir, true), dir, false).size).toBe(0);
});

test("walking order ignores folds, and reveal opens a file's directories", () => {
  const snaps = Array.from({ length: 13 }, (_, i) => `tests/snap/${i}.snap`);
  const paths = ["z.ts", ...snaps];
  expect(tree.order(paths)[0]).toBe("tests/snap/0.snap");
  expect(tree.order(paths).at(-1)).toBe("z.ts");
  // Reversed, each level runs Z to A, directories still first.
  expect(tree.order(paths, true)[0]).toBe("tests/snap/9.snap");
  expect(tree.order(paths, true).at(-1)).toBe("z.ts");
  const toggled = tree.reveal(paths, new Set(), "tests/snap/3.snap");
  expect(tree.rows(paths, toggled).some(r => r.path === "tests/snap/3.snap")).toBe(true);
});

test("by last edit, newest or oldest first, files without a time last", () => {
  const edited = new Map([
    ["a.ts", 100],
    ["b.ts", 300],
    ["c.ts", 200],
  ]);
  expect(tree.byEdited(["gone.ts", "a.ts", "b.ts", "c.ts"], edited)).toEqual(["b.ts", "c.ts", "a.ts", "gone.ts"]);
  expect(tree.byEdited(["gone.ts", "a.ts", "b.ts", "c.ts"], edited, true)).toEqual(["a.ts", "c.ts", "b.ts", "gone.ts"]);
});
