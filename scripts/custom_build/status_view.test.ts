import { expect, test } from "bun:test";
import { fileSummary, render, shortPath, type View } from "./status_view";
import { title } from "./term";

const view = (rest: Partial<View> = {}): View => ({
  run: null,
  upstream: { name: "upstream/main", tip: "8433d62abcdef" },
  rows: [],
  note: null,
  home: "/home/me",
  ...rest,
});

test("status shows one aligned row per patch, conflicts and the hints that apply", () => {
  const lines = render(
    view({
      rows: [
        { patch: "tool", clean: true, files: [], own: { kind: "diverged" } },
        {
          patch: "owner/repo#93",
          clean: false,
          files: ["locales/ja.json", "src/a.ts", "src/i18n.generated.ts", "src/b.ts", "src/c.ts"],
          own: { kind: "worktree", path: "/home/me/corgi/.claude/worktrees/tint", rebasableThere: true },
        },
        { patch: "upstream-pr", clean: null, files: [], own: null },
      ],
    }),
    { color: false },
  );
  expect(lines).toEqual([
    "custom-build · no run in progress · upstream upstream/main @ 8433d62",
    "",
    "PATCH           UPSTREAM        OWN BRANCH",
    "tool            ✓ clean         ! diverged from origin",
    "owner/repo#93   ✗ 5 conflicts   · in worktree tint",
    "upstream-pr     ? not fetched   -",
    "",
    "Conflicts",
    "  owner/repo#93  src/a.ts, src/b.ts, src/c.ts, … +2",
    "",
    "Branches in a worktree: `rebase --in-worktree` rebases them there.",
  ]);
});

test("a stopped run gets its own block and an unfetched upstream says how to fix it", () => {
  const lines = render(
    view({
      run: { where: "merging x (2 of 3)", startedAt: "2026-11-10T20:00:00Z", report: "/home/me/r", next: "continue" },
      upstream: { name: "upstream/main", tip: null },
    }),
    { color: false },
  );
  expect(lines).toEqual([
    "custom-build · stopped while merging x (2 of 3)",
    "  started  2026-11-10T20:00:00Z",
    "  report   ~/r",
    "  next     continue",
    "",
    "upstream/main not fetched yet; rebuild to check patches",
  ]);
});

test("colors only with a terminal, and padding ignores the escape codes", () => {
  const rows: View["rows"] = [
    { patch: "a", clean: true, files: [], own: { kind: "behind", conflicts: false } },
    { patch: "b", clean: false, files: ["x"], own: { kind: "pending", command: "git push x" } },
  ];
  const colored = render(view({ rows }), { color: true }),
    plain = render(view({ rows }), { color: false });
  expect(colored.join("\n")).toContain("\x1b[32m✓ clean\x1b[0m");
  expect(colored.map(l => l.replace(/\x1b\[[\d;]*m/g, ""))).toEqual(plain);
  expect(plain).toContain("b was rebased earlier; push it with: git push x");
  expect(plain).toContain("Branches behind upstream: `rebase` updates them.");
});

test("paths and file lists are shortened", () => {
  expect(shortPath("/x/corgi/.claude/worktrees/feat", "/home/me")).toBe("feat");
  expect(shortPath("/home/me/src/tree", "/home/me")).toBe("~/src/tree");
  expect(shortPath("/home/meadow/tree", "/home/me")).toBe("/home/meadow/tree");
  expect(fileSummary(["a", "b", "c"])).toBe("a, b, c");
  expect(fileSummary(["locales/x.json", "a"])).toBe("a, locales/x.json");
});

test("on a terminal patch names link to their pages, in the table and the conflicts", () => {
  const rows: View["rows"] = [
    { patch: "tals/corgi#5", clean: false, files: ["x"], own: null, url: "https://github.com/tals/corgi/pull/5" },
    { patch: "mine", clean: true, files: [], own: null, url: null },
  ];
  const colored = render(view({ rows }), { color: true }),
    out = colored.join("\n"),
    linked = "\x1b]8;;https://github.com/tals/corgi/pull/5\x1b\\\x1b[4mtals/corgi#5\x1b[24m\x1b]8;;\x1b\\";
  expect(out.split(linked)).toHaveLength(3);
  expect(colored.map(l => l.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[\d;]*m/g, ""))).toEqual(
    render(view({ rows }), { color: false }),
  );
  expect(render(view({ rows }), { color: false }).join("\n")).not.toContain("\x1b");
});

test("wide characters in patch names keep the table and the conflicts aligned", () => {
  const rows: View["rows"] = [
    { patch: "機能", clean: false, files: ["a.ts"], own: null },
    { patch: "plain", clean: false, files: ["b.ts"], own: null },
  ];
  const lines = render(view({ rows }), { color: false }),
    at = (line: string, mark: string) => Bun.stringWidth(line.slice(0, line.indexOf(mark)));
  const table = lines.filter(l => l.includes("✗"));
  expect(at(table[0], "✗")).toBe(at(table[1], "✗"));
  expect(
    at(
      lines.find(l => l.includes("a.ts"))!,
      "a.ts",
    ),
  ).toBe(
    at(
      lines.find(l => l.includes("b.ts"))!,
      "b.ts",
    ),
  );
});

test("status title uses the gradient", () => {
  const colored = render(view(), { color: true }),
    plain = render(view(), { color: false });
  expect(colored[0].startsWith(`${title(true)} · `)).toBe(true);
  expect(colored[0].startsWith("\x1b[38;2;125;207;255mc")).toBe(true);
  expect(colored[0].replace(/\x1b\[[\d;]*m/g, "")).toBe(plain[0]);
  expect(plain[0]).toBe("custom-build · no run in progress · upstream upstream/main @ 8433d62");
  expect(plain[0]).not.toContain("\x1b");
});
