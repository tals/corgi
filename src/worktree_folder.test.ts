import { expect, test } from "bun:test";
import * as worktreeFolder from "./worktree_folder";

test("the default puts worktrees under the project root, branch slashes as dashes", () => {
  expect(worktreeFolder.expand(worktreeFolder.default_template, "/src/app", "feat/login", "/home/u")).toBe(
    "/src/app/.worktrees/feat-login",
  );
  expect(worktreeFolder.expand("~/wt/${PROJECT_NAME}-$NAME/", "/src/app", "x", "/home/u")).toBe("/home/u/wt/app-x");
  expect(worktreeFolder.expand("$PROJECT_ROOT/../$PROJECT_NAME-$NAME", "/src/app", "x", "/home/u")).toBe("/src/app-x");
  expect(worktreeFolder.expand("$HOME/$NAME", "/src/app", "x", "/home/u")).toBe("/home/u/x");
  // Relative folders are relative to the project root.
  expect(worktreeFolder.expand(".wt/$NAME", "/src/app", "x", "/home/u")).toBe("/src/app/.wt/x");
  expect(worktreeFolder.expand("../$PROJECT_NAME-$NAME", "/src/app", "x", "/home/u")).toBe("/src/app-x");
  // A template with a problem falls back to the default.
  expect(worktreeFolder.expand("$NOPE/$NAME", "/src/app", "x", "/home/u")).toBe("/src/app/.worktrees/x");
});

test("a template that can't place worktrees says what to fix", () => {
  const cases: [string, string | null][] = [
    ["$PROJECT_ROOT/.worktrees/$NAME", null],
    ["/tmp/wt/$NAME", null],
    ["~/wt/${NAME}", null],
    ["", "Type a folder, such as $PROJECT_ROOT/.worktrees/$NAME"],
    ["$PROJECT_ROOT/.worktrees", "Add $NAME, so each worktree gets a folder of its own"],
    ["$project_root/$NAME", "Variables are uppercase: $PROJECT_ROOT, not $project_root"],
    ["$PROJECT/$NAME", "$PROJECT isn't a variable; did you mean $PROJECT_ROOT or $PROJECT_NAME?"],
    ["$PROJECT_ROOT/$BRANCH", "$BRANCH isn't a variable; did you mean $NAME?"],
    ["$TMPDIR/$NAME", "$TMPDIR isn't a variable"],
    ["$PROJECT_ROOT/${NAME", "A ${ needs its closing }"],
    ["$PROJECT_ROOT/$/$NAME", "A $ needs a variable after it, such as $NAME"],
    [".worktrees/$NAME", null],
    ["$NAME", null],
  ];
  for (const [template, expected] of cases)
    expect([template, worktreeFolder.problem(template)]).toEqual([template, expected]);
});

test("tokens mark known variables and bad uses of $ for coloring", () => {
  expect(worktreeFolder.tokens("$PROJECT_ROOT/wt/${NAME}-$BRANCH$")).toEqual([
    { text: "$PROJECT_ROOT", kind: "variable" },
    { text: "/wt/", kind: "text" },
    { text: "${NAME}", kind: "variable" },
    { text: "-", kind: "text" },
    { text: "$BRANCH", kind: "bad" },
    { text: "$", kind: "bad" },
  ]);
});

test("a leading ./ completes to the project root, the caret staying after what was typed", () => {
  expect(worktreeFolder.completeRoot("./", 2)).toEqual({ template: "$PROJECT_ROOT/", cursor: 14 });
  expect(worktreeFolder.completeRoot("./wt/$NAME", 0)).toEqual({ template: "$PROJECT_ROOT/wt/$NAME", cursor: 0 });
  expect(worktreeFolder.completeRoot("../wt/$NAME", 3)).toBeNull();
  expect(worktreeFolder.completeRoot(".", 1)).toBeNull();
});
