import { expect, test } from "bun:test";
import type { Patch, RetiredPatch } from "./config";
import { patchLink, render } from "./list_view";
import { title } from "./term";

const patches: Patch[] = [
  { source: { kind: "branch", name: "my-branch" }, description: "My change", added: "2026-11-04" },
  {
    source: { kind: "pr", repo: "tals/corgi", number: 128 },
    description: "end a turn on its summary",
    added: "2026-11-05",
  },
  { source: { kind: "fork-branch", repo: "other/corgi", branch: "topic" }, description: "Topic", added: "2026-11-06" },
  {
    source: { kind: "fork-branch", url: "https://git.example.com/x.git", branch: "b" },
    description: "B",
    added: "2026-11-07",
  },
];
const retired: RetiredPatch[] = [{ ...patches[1], retired: "2026-11-09", reason: "merged upstream" }];
const opts = { retired: false, upstream: "upstream/main", fork: "github.com/me/corgi", color: false };
const plain = (lines: string[]) =>
  lines.map(l => l.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[\d;]*m/g, ""));

test("list shows the patches as a table in merge order", () => {
  expect(render({ patches, retired }, opts)).toEqual([
    "custom-build · 4 patches, merged in this order onto upstream/main",
    "",
    "#  PATCH                            ADDED       DESCRIPTION",
    "1  my-branch                        2026-11-04  My change",
    "2  tals/corgi#128                   2026-11-05  end a turn on its summary",
    "3  other/corgi:topic                2026-11-06  Topic",
    "4  https://git.example.com/x.git:b  2026-11-07  B",
  ]);
});

test("list --retired shows when and why each patch was retired", () => {
  expect(render({ patches, retired }, { ...opts, retired: true })).toEqual([
    "custom-build · 1 retired patch",
    "",
    "PATCH           RETIRED     REASON",
    "tals/corgi#128  2026-11-09  merged upstream",
  ]);
});

test("empty lists say so", () => {
  expect(render({ patches: [], retired: [] }, opts)).toEqual(["no patches"]);
  expect(render({ patches: [], retired: [] }, { ...opts, retired: true })).toEqual(["no retired patches"]);
});

test("a terminal gets each patch linked to its page, without shifting a column", () => {
  const linked = render({ patches, retired }, { ...opts, color: true });
  const out = linked.join("\n");
  expect(out).toContain(
    "\x1b]8;;https://github.com/tals/corgi/pull/128\x1b\\\x1b[4mtals/corgi#128\x1b[24m\x1b]8;;\x1b\\",
  );
  expect(out).toContain(
    "\x1b]8;;https://github.com/me/corgi/tree/my-branch\x1b\\\x1b[4mmy-branch\x1b[24m\x1b]8;;\x1b\\",
  );
  expect(out).toContain(
    "\x1b]8;;https://github.com/other/corgi/tree/topic\x1b\\\x1b[4mother/corgi:topic\x1b[24m\x1b]8;;\x1b\\",
  );
  expect(out).not.toContain("\x1b]8;;https://git.example.com");
  expect(plain(linked)).toEqual(render({ patches, retired }, opts));
});

test("links go where each kind of patch lives", () => {
  expect(patchLink({ kind: "pr", repo: "tals/corgi", number: 5 }, null)).toBe("https://github.com/tals/corgi/pull/5");
  expect(patchLink({ kind: "branch", name: "feat/x" }, "github.com/me/corgi")).toBe(
    "https://github.com/me/corgi/tree/feat/x",
  );
  expect(patchLink({ kind: "branch", name: "x" }, "gitlab.example.com/me/corgi")).toBeNull();
  expect(patchLink({ kind: "branch", name: "x" }, null)).toBeNull();
  expect(patchLink({ kind: "fork-branch", url: "https://git.example.com/x.git", branch: "b" }, null)).toBeNull();
});

test("on a narrow terminal the description is cut to fit", () => {
  const lines = render({ patches, retired }, { ...opts, columns: 60 });
  expect(lines[4]).toBe("2  tals/corgi#128                   2026-11-05  end a turn …");
  expect(lines[4].length).toBe(60);
  expect(lines[3]).toBe("1  my-branch                        2026-11-04  My change");
});

test("branch links encode each path segment, keeping the slashes", () => {
  expect(patchLink({ kind: "branch", name: "fix#123" }, "github.com/me/corgi")).toBe(
    "https://github.com/me/corgi/tree/fix%23123",
  );
  expect(patchLink({ kind: "fork-branch", repo: "o/corgi", branch: "team/a?b%c" }, null)).toBe(
    "https://github.com/o/corgi/tree/team/a%3Fb%25c",
  );
});

test("wide characters keep the columns aligned and are cut by width", () => {
  const wide: Patch[] = [
    { source: { kind: "branch", name: "機能" }, description: "日本語の説明です", added: "2026-11-04" },
    { source: { kind: "branch", name: "plain" }, description: "x", added: "2026-11-05" },
  ];
  const lines = render({ patches: wide, retired: [] }, opts);
  const at = (line: string) => Bun.stringWidth(line.slice(0, line.indexOf("2026")));
  expect(at(lines[3])).toBe(at(lines[4]));
  const cut = render({ patches: wide, retired: [] }, { ...opts, columns: Bun.stringWidth(lines[3]) - 4 })[3];
  expect(cut.endsWith("…")).toBe(true);
  expect(Bun.stringWidth(cut)).toBeLessThanOrEqual(Bun.stringWidth(lines[3]) - 4);
});

test("list colors kinds, names and dates on a terminal", () => {
  const colored = render({ patches, retired }, { ...opts, color: true }),
    out = colored.join("\n");
  expect(colored[0].startsWith(`${title(true)} · `)).toBe(true);
  expect(colored[0].startsWith("\x1b[38;2;125;207;255mc")).toBe(true);
  expect(colored[0]).toContain("\x1b[38;2;187;154;247md\x1b[0m");
  expect(out).toContain("\x1b[36m\x1b]8;;https://github.com/tals/corgi/pull/128\x1b\\\x1b[4mtals/corgi#128");
  expect(out).toContain("\x1b[34m\x1b]8;;https://github.com/me/corgi/tree/my-branch\x1b\\\x1b[4mmy-branch");
  expect(out).toContain("\x1b[35m\x1b]8;;https://github.com/other/corgi/tree/topic\x1b\\\x1b[4mother/corgi:topic");
  expect(out).toContain("\x1b[35mhttps://git.example.com/x.git:b\x1b[0m");
  expect(out).toContain("\x1b[2m2026-11-04\x1b[0m");
  expect(colored[3].startsWith("\x1b[2m1\x1b[0m")).toBe(true);
  expect(out).toContain("My change");
  expect(out).not.toContain("\x1b[2mMy change");
  expect(plain(colored)).toEqual(render({ patches, retired }, opts));

  const gone = render({ patches, retired }, { ...opts, retired: true, color: true });
  expect(gone[0].startsWith(`${title(true)} · `)).toBe(true);
  expect(gone.join("\n")).toContain("\x1b[36m\x1b]8;;https://github.com/tals/corgi/pull/128");
  expect(gone.join("\n")).toContain("\x1b[2m2026-11-09\x1b[0m");
  expect(plain(gone)).toEqual(render({ patches, retired }, { ...opts, retired: true }));
});
