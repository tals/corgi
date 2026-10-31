import * as rowGlide from "./row_glide";
import { expect, test } from "bun:test";
import * as agentManager from "./agent_manager";
import * as palette from "./palette";
import { Entry as CommandEntry } from "./launch/command";
import { Rect } from "./layout";
import { Cell } from "./launcher_usage";
import { Terminal } from "./pane/terminal";
import { Writer } from "./text";

const agent = (fields: Partial<agentManager.Agent>): agentManager.Agent => ({
  provider: "claude",
  account: "",
  name: "",
  label: "Claude Code",
  who: "me@example.com",
  signed_out: false,
  shown: true,
  here: true,
  managed: false,
  usage: Cell.status("—"),
  ...fields,
});
const work = agent({ account: "/a/2", name: "work", label: "Claude Code · work", who: "me@acme.com", managed: true });
function model(): agentManager.Model {
  const commands = Array.from({ length: 6 }, () => new CommandEntry());
  commands[0].set('claude --model opus -p "review this diff"');
  commands[0].name = "review-bot";
  return {
    agents: [
      agent({ provider: "codex", label: "Codex" }),
      agent({}),
      work,
      agent({ account: "/o/side", name: "side", label: "Claude Code · side", who: "Not signed in", signed_out: true }),
    ],
    commands,
    workspace: "corgi",
    here: () => true,
    offers: [
      { provider: "codex", installed: true, signin: true },
      { provider: "claude", installed: true, signin: true },
    ],
    removed: [],
    folder: (provider, account) => account || (provider === "claude" ? "~/.claude" : "~/.codex"),
    account: () => "me@example.com",
    suggest: a => (a === work ? "acme" : "example"),
    options: () => ({ flags: "", env: [] }),
  };
}
/** What `v` draws in a box like the launcher's card, as text. */
function screen(v: agentManager.View, m: agentManager.Model, now?: number) {
  const b = new Rect(0, 0, 82, v.height(m)),
    w = new Writer();
  v.draw(w, b, m, now);
  w.write(v.glideImage(b, m));
  const host = new Terminal(90, 30);
  host.feed(w.s);
  const lines = host.text().split("\n");
  host.destroy();
  return { lines, b, raw: w.s };
}
const type = (v: agentManager.View, m: agentManager.Model, text: string) => {
  if (v.page === "list" && v.focus === "list") v.key(47, m);
  let action: agentManager.Action | null = null;
  for (const ch of text) action = v.key(ch.charCodeAt(0), m) ?? action;
  return action;
};

test("Active, Hidden and Add agent share a model column and preserve the opening selection", () => {
  const m = model(),
    v = new agentManager.View();
  v.open(agentManager.agentKey("claude", "/a/2"));
  expect(v.focus).toBe("list");
  const { lines, b, raw } = screen(v, m);
  expect(raw).toContain("\x1b[?25l");
  expect(lines[4]).toMatch(/Agent +Account +Model/);
  expect(lines[6]).toContain("Active · 5 · corgi");
  // Each account wears its agent's mark beside its own name.
  // The selected one's model key sits by its dropdown, whose arrow leads the model.
  expect(lines[9]).toMatch(/› ≡ \* work +me@acme.com +m  ▾ Auto \(last chosen\) +│/);
  expect(lines[8]).toMatch(/  ≡ \* Claude Code +me@example.com/);
  expect(lines[13]).toContain("Hidden · 0");
  expect(lines[14]).toContain("Drop an agent here");
  expect(lines[16]).toContain("Add agent");
  expect(lines[b.h - 3]).toContain("Clone");
  expect(lines[b.h - 2].replaceAll("│", "").trim()).toBe("");
});

test("typing searches names, accounts and commands, and the selection stays while it's listed", () => {
  const m = model(),
    v = new agentManager.View();
  v.open(agentManager.agentKey("claude", "/a/2"));
  type(v, m, "acme");
  let { lines } = screen(v, m);
  expect(lines[2]).toMatch(/│   \/  acme +│/);
  expect(lines[7]).toMatch(/│  ≡ \* work +me@acme.com/);
  // Add agent keeps only the agents with an account the search names, closed
  // while the selection is up the list.
  expect(lines[13]).toMatch(/│   \*  Claude Code +│/);
  expect(lines[14]).not.toContain("Claude Code");
  // Space and Backspace belong to search, including when it becomes empty.
  v.key(127, m);
  v.key(127, m);
  v.key(127, m);
  v.key(127, m);
  type(v, m, "codex");
  ({ lines } = screen(v, m));
  expect(lines[7]).toMatch(/│  ≡ † Codex /);
  expect(lines.find(l => l.includes("Add agent"))).toBeDefined();
  expect(v.key(32, m)).toBeNull();
  expect(v.query.raw()).toBe("codex ");
  type(v, m, "zz");
  expect(screen(v, m).lines.join("\n")).toContain("No matching agents");
  expect(screen(v, m).lines.join("\n")).not.toContain("Add agent");
});

test("Enter edits an account, preserving drafts on failure and suggesting an empty name", () => {
  const m = model(),
    v = new agentManager.View();
  v.open(agentManager.agentKey("claude", "/a/2"));
  expect(v.key(13, m)).toBeNull();
  expect(v.page).toBe("agent");
  expect(v.agent_form.name.name()).toBe("work");
  expect(screen(v, m).lines.join("\n")).toContain("Extra flags");
  type(v, m, "big");
  v.sequence("\x1b[A", m);
  expect(v.key(13, m)).toEqual({ kind: "configure", agent: work, name: "big", options: { flags: "", env: [] } });
  v.fail("There's an account by that name already.");
  expect(screen(v, m).lines.join("\n")).toContain("There's an account by that name already.");
  v.sequence("\x1b[B", m);
  for (let i = 0; i < 3; i++) v.key(127, m);
  v.sequence("\x1b[A", m);
  expect(v.key(13, m)).toEqual({ kind: "configure", agent: work, name: "acme", options: { flags: "", env: [] } });
  v.configured();
  expect(v.page).toBe("list");
  v.key(13, m);
  v.key(27, m);
  expect(v.page).toBe("list");
});

test("an empty default name goes by its agent's name, without replacing it with a suggestion", () => {
  const m = model(),
    v = new agentManager.View(),
    claude = m.agents[1];
  v.open(agentManager.agentKey("claude", ""));
  expect(v.key(13, m)).toBeNull();
  v.sequence("\x1b[A", m);
  expect(v.key(13, m)).toEqual({ kind: "configure", agent: claude, name: "", options: { flags: "", env: [] } });
  v.sequence("\x1b[B", m);
  type(v, m, "example");
  v.sequence("\x1b[A", m);
  expect(v.key(13, m)).toEqual({ kind: "configure", agent: claude, name: "example", options: { flags: "", env: [] } });
  v.configured();
  m.agents[1] = { ...claude, name: "example", label: "Claude Code · example" };
  v.key(13, m);
  expect(v.agent_form.name.name()).toBe("example");
});

/** Hold long enough to commit, returning the one removal action. */
function hold(v: agentManager.View, m: agentManager.Model, start = 0, forward = false) {
  const press = (now: number) => (forward ? v.sequence("\x1b[3~", m, now) : v.key(127, m, now));
  const actions: agentManager.Action[] = [];
  const first = press(start);
  if (first) actions.push(first);
  for (let elapsed = 400; elapsed <= 1700; elapsed += 50) {
    const action = press(start + elapsed);
    if (action) actions.push(action);
  }
  return actions;
}

test("clearing search and continuing to hold Backspace never starts removal", () => {
  const m = model(),
    v = new agentManager.View();
  v.open(agentManager.agentKey("claude", "/a/2"));
  type(v, m, "work");
  expect(hold(v, m)).toEqual([]);
  expect(v.query.name()).toBe("");
  expect(v.removal).toBeNull();
  expect(v.focus).toBe("search");
  expect(v.key(32, m)).toBeNull();
  expect(v.query.raw()).toBe(" ");
});

test("arrows cycle through search and list rows, while Tab toggles focus", () => {
  const m = model(),
    v = new agentManager.View();
  v.open();
  expect(v.selected(m)?.kind).toBe("agent");
  v.sequence("\x1b[A", m);
  expect(v.focus).toBe("search");
  v.sequence("\x1b[A", m);
  // The last row is Add agent's strip, on its first agent.
  expect([v.focus, v.at]).toEqual(["list", "tile:codex"]);
  // Down opens into its accounts, then wraps to search.
  v.sequence("\x1b[B", m);
  v.sequence("\x1b[B", m);
  expect(v.at).toBe("add:codex");
  v.sequence("\x1b[B", m);
  expect(v.focus).toBe("search");
  v.sequence("\x1b[B", m);
  expect([v.focus, v.at]).toEqual(["list", agentManager.agentKey("codex", "")]);
  v.key(9, m);
  type(v, m, "work");
  v.sequence("\x1b[B", m);
  expect([v.focus, v.at]).toEqual(["list", agentManager.agentKey("claude", work.account)]);
  // Its account under Add agent matches too.
  v.sequence("\x1b[B", m);
  expect([v.focus, v.at]).toEqual(["list", "tile:claude"]);
  v.sequence("\x1b[B", m);
  expect([v.focus, v.at]).toEqual(["list", "found:claude:/a/2"]);
  v.sequence("\x1b[B", m);
  expect(v.focus).toBe("search");
  v.sequence("\x1b[Z", m);
  expect(v.focus).toBe("list");
});

test("holding Backspace buries only the selected account and keeps its ending after removal", () => {
  const m = model(),
    v = new agentManager.View();
  v.open(agentManager.agentKey("claude", "/a/2"));
  v.key(127, m, 0);
  expect(screen(v, m, 0).lines.join("\n")).toContain("Signs out and deletes its folder");
  for (let now = 400; now <= 650; now += 50) v.key(127, m, now);
  expect(screen(v, m, 650).lines[9]).toContain("‹o");
  // Release restores the row and performs nothing.
  v.tick(m, 1400);
  expect(v.removal).toBeNull();
  expect(hold(v, m, 2000)).toEqual([{ kind: "remove", agent: work }]);
  m.agents.splice(2, 1);
  v.removed();
  expect(v.items(m).have).toHaveLength(5);
  for (let now = 3750; now <= 6000; now += 50) expect(v.key(127, m, now)).toBeNull();
  expect(v.removal).toBeNull();
  expect(v.items(m).have).toHaveLength(4);
  expect(v.items(m).add).not.toContainEqual({ kind: "agent", agent: work });
});

test.each([50, 125, 250])("continuous repeats every %i ms cannot remove a second row", interval => {
  const m = model(),
    v = new agentManager.View();
  m.agents = [work, { ...work, account: "/b", name: "second", label: "Claude Code · second" }];
  m.commands = [];
  m.offers = [];
  v.open(agentManager.agentKey("claude", work.account));
  const removed: string[] = [];
  for (let now = 0; now <= 10000; now += interval) {
    const action = v.key(127, m, now);
    if (action?.kind !== "remove") continue;
    removed.push(action.agent.account);
    m.agents = m.agents.filter(a => a.account !== action.agent.account);
    v.removed();
  }
  expect(removed).toEqual([work.account]);
  expect(m.agents.map(a => a.account)).toEqual(["/b"]);
});

test("forward Delete holds on the list, and external accounts and commands say what stays", () => {
  const m = model(),
    v = new agentManager.View();
  v.open(agentManager.agentKey("claude", "/o/side"));
  v.sequence("\x1b[3~", m, 0);
  expect(screen(v, m, 0).lines.join("\n")).toContain("Keeps its folder; Add agent can add it back");
  expect(hold(v, m, 2000, true)).toEqual([{ kind: "remove", agent: m.agents[3] }]);
  v.open("command:0");
  expect(hold(v, m)).toEqual([{ kind: "remove_command", index: 0 }]);
  expect(screen(v, m, 1700).lines.join("\n")).toContain("Deletes the saved command");
  v.removed("Could not save");
  expect(v.removal).toBeNull();
  expect(screen(v, m).lines.join("\n")).toContain("Could not save");
  v.open(agentManager.agentKey("claude", ""));
  expect(hold(v, m)).toEqual([{ kind: "remove", agent: m.agents[1] }]);
});

test("changing focus, the selected row, or its command cancels a hold", () => {
  for (const change of ["tab", "down", "command", "gone", "enter"] as const) {
    const m = model(),
      v = new agentManager.View();
    v.open("command:0");
    v.key(9, m);
    v.key(127, m, 0);
    v.key(127, m, 400);
    if (change === "tab") v.key(9, m, 450);
    if (change === "down") v.sequence("\x1b[B", m, 450);
    if (change === "command") m.commands[0].set("codex");
    if (change === "gone") m.commands[0] = new CommandEntry();
    if (change === "enter") expect(v.key(13, m, 450)).toBeNull();
    v.tick(m, 500);
    expect(v.removal).toBeNull();
  }
});

test("clicking search restores its caret, and list focus ignores paste", () => {
  const m = model(),
    v = new agentManager.View();
  v.open();
  type(v, m, "codex");
  v.key(9, m);
  v.paste(120, m);
  expect(v.query.name()).toBe("codex");
  v.click(b(v, m), 3, 2, m);
  expect(v.focus).toBe("search");
  v.sequence("\x1b[3~", m);
  expect(v.query.name()).toBe("odex");
  expect(v.removal).toBeNull();
  v.paste(120, m);
  expect(v.query.name()).toBe("xodex");
});

test("Add agent's agents sign in to a new account, and Custom command opens the form", () => {
  const m = model(),
    v = new agentManager.View();
  v.open("add:codex");
  expect(screen(v, m).lines[b(v, m).h - 2]).toMatch(/↵ +sign in to a new Codex account/);
  expect(v.key(13, m)).toEqual({ kind: "add", provider: "codex" });
  v.open("add:claude");
  // Right moves along the strip to saved commands.
  v.sequence("\x1b[C", m);
  expect(v.at).toBe("custom");
  expect(v.key(13, m)).toBeNull();
  expect(v.page).toBe("command");
  const { lines } = screen(v, m);
  expect(lines[0]).toMatch(/^╭─ New command ─/);
  expect(lines[2]).toContain("Command");
  expect(v.key(13, m)).toEqual({ kind: "save" });
  type(v, m, "codex");
  expect(v.form.editor.name()).toBe("codex");
  v.saved(3);
  expect([v.page, v.at]).toEqual(["list", "command:3"]);
  // A saved command's row edits it.
  v.open("command:0");
  v.key(13, m);
  expect([v.page, v.form.edit_index, v.form.name_editor.name()]).toEqual(["command", 0, "review-bot"]);
});
const b = (v: agentManager.View, m: agentManager.Model) => new Rect(0, 0, 82, v.height(m));

test("Add agent opens an agent's accounts once it's selected, adds back removed ones and keeps its room", () => {
  const m = model(),
    v = new agentManager.View();
  m.agents[1] = { ...m.agents[1], shown: false };
  m.removed = [{ provider: "claude", account: "/o/old", name: "old" }];
  v.open(agentManager.agentKey("codex", ""));
  const closed = v.height(m);
  let { lines } = screen(v, m);
  // A removed default leaves the list for its agent's accounts under Add agent.
  expect(lines.filter(l => /≡ Claude Code +me@example.com/.test(l))).toEqual([]);
  const strip = lines.findIndex(l => l.includes("Custom command"));
  // Each mark sits with its own name, the agents well apart.
  expect(lines[strip]).toMatch(/│   †  Codex  │  \*  Claude Code  │  \+  Custom command +│/);
  // Nothing opens until the strip is selected.
  expect(lines[strip + 1]).not.toContain("Codex");
  // Clicking an agent selects it, which opens its list.
  expect(v.click(b(v, m), 18, strip, m)).toBeNull();
  expect(v.at).toBe("tile:claude");
  const opened = v.height(m);
  expect(opened).toBe(closed + 5);
  ({ lines } = screen(v, m));
  expect(lines[strip]).toMatch(/│›  †  Codex/);
  expect(lines[strip + 1]).toMatch(/│  \+ Claude Code +me@example.com +Removed +│/);
  expect(lines[strip + 2]).toMatch(/│  ✓ work +me@acme.com +In the list +│/);
  expect(lines[strip + 4]).toMatch(/│  \+ old +\/o\/old +Removed +│/);
  expect(lines[strip + 5]).toContain("+ New Claude Code account");
  expect(lines[b(v, m).h - 2]).toMatch(/↓ +accounts +←→ +agents/);
  // Enter goes into its list, on the first row that adds something.
  expect(v.key(13, m)).toBeNull();
  expect(v.at).toBe("found:claude:");
  expect(screen(v, m).lines[b(v, m).h - 2]).toMatch(/↵ +add back to the list +←→ +agents/);
  expect(v.key(13, m)).toEqual({ kind: "show", agent: m.agents[1] });
  // A listed account's row goes to its row above, where the list closes and keeps its room.
  v.sequence("\x1b[B", m);
  expect(v.key(13, m)).toBeNull();
  expect(v.at).toBe(agentManager.agentKey("claude", work.account));
  expect(v.height(m)).toBe(opened);
  expect(screen(v, m).lines[strip + 1].replaceAll("│", "").trim()).toBe("");
  v.open("removed:claude:/o/old");
  expect(v.key(13, m)).toEqual({ kind: "restore", provider: "claude", account: "/o/old" });
  // Until its row comes, its agent's first row is selected; then its own.
  expect(v.selected(m)).toEqual({ kind: "tile", tile: "claude" });
  m.removed = [];
  m.agents.push(agent({ account: "/o/old", name: "old", label: "Claude Code · old" }));
  expect(v.selected(m)).toEqual({ kind: "found", agent: m.agents[4] });
  // Left keeps the place down the list, and focusing another agent never resizes the box.
  v.sequence("\x1b[D", m);
  expect(v.at).toBe("add:codex");
  expect(v.height(m)).toBe(opened + 1);
  v.sequence("\x1b[D", m);
  expect(v.at).toBe("add:codex");
  v.sequence("\x1b[C", m);
  v.sequence("\x1b[C", m);
  expect(v.at).toBe("custom");
  expect(v.height(m)).toBe(opened + 1);
  // The strip's own place moves along it too, and Enter on Custom command opens the form.
  v.sequence("\x1b[A", m);
  expect(v.at).toBe("tile:custom");
  v.sequence("\x1b[D", m);
  expect(v.at).toBe("tile:claude");
  v.sequence("\x1b[C", m);
  v.key(13, m);
  expect(v.page).toBe("command");
});

test("removing a search's last match leaves nothing selected, so Left goes back and Enter adds nothing", () => {
  const m = model(),
    v = new agentManager.View();
  v.open(agentManager.agentKey("claude", "/o/side"));
  type(v, m, "side");
  v.key(9, m);
  expect(hold(v, m)).toEqual([{ kind: "remove", agent: m.agents[3] }]);
  // A folder Corgi didn't make waits in Add agent once it's gone.
  m.agents.splice(3, 1);
  m.removed = [{ provider: "claude", account: "/o/side", name: "side" }];
  v.removed();
  v.tick(m, 4000);
  expect(v.selected(m)).toBeNull();
  expect(v.key(13, m)).toBeNull();
  expect(v.sequence("\x1b[D", m)).toEqual({ kind: "back" });
  // Down reaches its agent on the strip, and into its list adds it back.
  v.sequence("\x1b[B", m);
  expect(v.at).toBe("tile:claude");
  expect(v.key(13, m)).toBeNull();
  expect(v.key(13, m)).toEqual({ kind: "restore", provider: "claude", account: "/o/side" });
});

test("every row in the list can be removed, and only the list's rows", () => {
  const m = model(),
    v = new agentManager.View();
  for (const a of m.agents) {
    v.open(agentManager.agentKey(a.provider, a.account));
    expect(hold(v, m)).toEqual([{ kind: "remove", agent: a }]);
  }
  for (const at of ["found:claude:", "add:claude", "custom"]) {
    v.open(at);
    expect(hold(v, m)).toEqual([]);
    expect(screen(v, m).lines.join("\n")).not.toContain("hold ⌫");
  }
});

test("dragging and keyboard reorder use stable rows, and crossing sections leaves source focus", () => {
  const m = model(),
    v = new agentManager.View();
  v.open(agentManager.agentKey("claude", work.account));
  expect(v.sequence("\x1b[1;2A", m)).toMatchObject({ kind: "move", row: "claude:/a/2", before: "claude", shown: true });
  const box = b(v, m);
  v.pointer(box, 3, 9, 0, false, m);
  v.pointer(box, 3, 7, 32, false, m);
  expect(v.pointer(box, 3, 7, 0, true, m)).toMatchObject({
    kind: "move",
    row: "claude:/a/2",
    before: "codex",
    shown: true,
  });
  expect(v.at).toBe(agentManager.agentKey("claude", work.account));
  v.pointer(box, 3, 9, 0, false, m);
  v.pointer(box, 3, 14, 32, false, m);
  expect(v.pointer(box, 3, 14, 0, true, m)).toMatchObject({
    kind: "move",
    row: "claude:/a/2",
    before: null,
    shown: false,
  });
  expect(v.at).toBe(agentManager.agentKey("claude", "/o/side"));
  v.pointer(box, 3, 9, 0, false, m);
  v.pointer(box, 3, 14, 32, false, m);
  v.key(27, m);
  expect(v.pointer(box, 3, 14, 0, true, m)).toBeNull();
  v.pointer(box, 3, 7, 0, false, m);
  v.pointer(box, 3, 12, 32, false, m);
  expect(v.pointer(box, 3, 12, 0, true, m)).toMatchObject({ kind: "move", row: "codex", before: null, shown: true });
});

test("clone is an unsaved draft with a native model picker and independent fields", () => {
  const m = model(),
    v = new agentManager.View();
  m.options = () => ({ flags: "--verbose", env: [["A", "one"]], model: "opus" });
  v.open(agentManager.agentKey("claude", work.account));
  expect(v.key(99, m)).toBeNull();
  expect(v.page).toBe("agent");
  expect(v.agent_form.cloning).toBe(true);
  expect(v.agent_form.label()).toBe("work copy");
  v.agent_form.focus = { kind: "model" };
  const read = v.key(13, m);
  expect(read?.kind).toBe("models");
  v.picker!.view.received([
    { id: "opus", name: "Opus" },
    { id: "sonnet", name: "Sonnet" },
  ]);
  v.sequence("\x1b[B", m);
  expect(v.key(13, m)).toBeNull();
  expect(v.agent_form.model).toBe("sonnet");
  v.agent_form.focus = { kind: "save" };
  expect(v.key(13, m)).toMatchObject({ kind: "clone", name: "work copy", options: { model: "sonnet" } });
  expect(m.options(work).model).toBe("opus");
  v.key(27, m);
  expect(v.page).toBe("list");
  expect(m.agents).toHaveLength(4);
});

test("Esc returns from a command and cancels a rename or hold before closing the list", () => {
  const m = model(),
    v = new agentManager.View();
  v.open(agentManager.agentKey("claude", "/a/2"));
  type(v, m, "wo");
  expect(v.key(27, m)).toEqual({ kind: "close" });
  v.open(agentManager.agentKey("claude", "/a/2"));
  v.key(13, m);
  expect(v.key(27, m)).toBeNull();
  v.key(127, m);
  expect(v.key(27, m)).toBeNull();
  expect(v.key(27, m)).toEqual({ kind: "close" });
  v.open("custom");
  v.key(13, m);
  v.form.save_requested = true;
  expect(screen(v, m).lines[0]).toMatch(/esc +back/);
  expect(v.key(27, m)).toBeNull();
  expect(v.page).toBe("list");
  expect(v.at).toBe("custom");
  expect(v.form.save_requested).toBe(false);
  expect(v.key(27, m)).toEqual({ kind: "close" });
});

test("arrows move past the sections, and clicks select, act again, and close", () => {
  const m = model(),
    v = new agentManager.View();
  v.open("command:0");
  expect(v.sequence("\x1b[B", m)).toBeNull();
  expect(v.at).toBe("tile:codex");
  v.sequence("\x1b[A", m);
  v.sequence("\x1b[A", m);
  expect(v.at).toBe(agentManager.agentKey("claude", "/o/side"));
  const box = b(v, m);
  expect(v.click(box, 20, 9, m)).toBeNull();
  expect(v.at).toBe(agentManager.agentKey("claude", "/a/2"));
  v.click(box, 20, 9, m);
  expect(v.agent_form.name.name()).toBe("work");
  v.key(27, m);
  expect(v.click(box, 4, 7, m)).toBeNull();
  expect(v.at).toBe(agentManager.agentKey("codex", ""));
  // An agent on the strip opens its list, whose rows select and then act.
  expect(v.click(box, 5, 17, m)).toBeNull();
  expect(v.at).toBe("tile:codex");
  const open = b(v, m);
  expect(v.click(open, 20, 19, m)).toBeNull();
  expect(v.click(open, 20, 19, m)).toEqual({ kind: "add", provider: "codex" });
  expect(v.click(open, open.w - 8, 0, m)).toEqual({ kind: "close" });
});

test("Left and the title return to New tab while text fields keep their arrow keys", () => {
  const m = model(),
    v = new agentManager.View();
  v.open();
  expect(v.sequence("\x1b[D", m)).toEqual({ kind: "back" });
  type(v, m, "work");
  expect(v.sequence("\x1b[D", m)).toBeNull();
  expect(v.query.cursor).toBe(3);
  v.key(9, m);
  expect(v.sequence("\x1b[D", m)).toEqual({ kind: "back" });
  expect(v.click(b(v, m), 4, 0, m)).toEqual({ kind: "back" });
  v.key(13, m);
  expect(v.sequence("\x1b[D", m)).toBeNull();
});

test("a short host scrolls to the selected row and clicks the same visible row", () => {
  const m = model(),
    v = new agentManager.View(),
    b = new Rect(2, 1, 82, 13);
  v.open("custom");
  v.focus = "list";
  const w = new Writer();
  v.draw(w, b, m);
  const host = new Terminal(90, 20);
  try {
    host.feed(w.s);
    const lines = host.text().split("\n"),
      y = lines.findIndex(line => line.includes("+ New custom command"));
    expect(y).toBeGreaterThanOrEqual(b.y + 6);
    expect(y).toBeLessThan(b.y + b.h - 3);
    expect(
      lines
        .slice(b.y + b.h)
        .join("")
        .trim(),
    ).toBe("");
    v.click(b, b.x + 10, y, m);
    expect(v.page).toBe("command");
  } finally {
    host.destroy();
  }
});

test("Hidden holds hidden commands and Space activates them, while a removed default waits in Add agent", () => {
  const m = model(),
    v = new agentManager.View();
  m.agents[0].shown = false;
  m.commands[0].hidden = true;
  v.open();
  expect(v.items(m).have).toHaveLength(3);
  expect(v.items(m).hidden).toEqual([{ kind: "command", index: 0 }]);
  expect(v.items(m).add).toEqual([{ kind: "tile", tile: "codex" }]);
  v.at = "found:codex:";
  expect(v.items(m).add[1]).toEqual({ kind: "found", agent: m.agents[0] });
  expect(v.key(32, m)).toBeNull();
  expect(v.key(13, m)).toEqual({ kind: "show", agent: m.agents[0] });
  v.key(9, m);
  type(v, m, "review-bot");
  v.key(9, m);
  expect(v.key(32, m)).toEqual({ kind: "show_command", index: 0 });
  expect(v.empty_section).toBe("hidden");
  m.commands[0].hidden = false;
  expect(v.items(m).have).toEqual([{ kind: "command", index: 0 }]);
  expect(v.items(m).hidden).toEqual([]);
});

test("hiding keeps focus below, then above, then on the source section's empty drop area", () => {
  const m = model(),
    v = new agentManager.View();
  v.open(agentManager.agentKey("claude", work.account));
  expect(v.key(32, m)).toEqual({ kind: "here", agent: work, shown: false });
  expect(v.at).toBe(agentManager.agentKey("claude", "/o/side"));
  m.agents[2] = { ...work, here: false };
  v.at = "command:0";
  expect(v.key(32, m)).toEqual({ kind: "here_command", index: 0, shown: false });
  expect(v.at).toBe(agentManager.agentKey("claude", "/o/side"));
  m.here = () => false;
  m.agents = m.agents.map(a => ({ ...a, here: false }));
  m.agents[0].here = true;
  v.at = agentManager.agentKey("codex", "");
  v.key(32, m);
  m.agents[0].here = false;
  expect(v.selected(m)).toBeNull();
  expect(v.empty_section).toBe("have");
  const text = screen(v, m).lines.join("\n");
  expect(text).toContain("Active · 0");
  expect(text).toContain("Drop an agent here");
  expect(v.key(32, m)).toBeNull();
});

test("a removed default account is buried, then leaves the list for Add agent", () => {
  const m = model(),
    v = new agentManager.View(),
    listed = () =>
      [...v.items(m).have, ...v.items(m).hidden].some(
        i => i.kind === "agent" && i.agent.provider === "claude" && !i.agent.account,
      );
  v.open(agentManager.agentKey("claude", ""));
  expect(hold(v, m)).toEqual([{ kind: "remove", agent: m.agents[1] }]);
  expect(screen(v, m, 1700).lines.join("\n")).toContain("Keeps its folder; Add agent can add it back");
  m.agents[1] = { ...m.agents[1], shown: false };
  v.removed();
  expect(listed()).toBe(true);
  v.tick(m, 4000);
  expect(listed()).toBe(false);
  expect(v.items(m).hidden).toEqual([]);
  v.open("found:claude:");
  expect(v.key(13, m)).toEqual({ kind: "show", agent: m.agents[1] });
});

test.each(["agent", "command"])("a hidden %s can be permanently deleted in Hidden", kind => {
  const m = model(),
    v = new agentManager.View();
  m.agents[2] = { ...work, here: false };
  m.commands[0].hidden = true;
  v.open(kind === "agent" ? agentManager.agentKey("claude", work.account) : "command:0");
  expect(hold(v, m)).toEqual([
    kind === "agent" ? { kind: "remove", agent: m.agents[2] } : { kind: "remove_command", index: 0 },
  ]);
  if (kind === "agent") m.agents.splice(2, 1);
  else m.commands[0] = new CommandEntry();
  v.removed();
  expect(v.items(m).have).toHaveLength(3);
  expect(v.items(m).hidden).toHaveLength(2);
  v.tick(m, 4000);
  expect(v.items(m).hidden).toHaveLength(1);
});

test("slow cleanup shows the moving worktree deletion bar after the corgi leaves", () => {
  const m = model(),
    v = new agentManager.View();
  v.open(agentManager.agentKey("claude", work.account));
  expect(hold(v, m)).toEqual([{ kind: "remove", agent: work }]);
  expect(screen(v, m, 1800).lines.join("\n")).not.toContain("Deleting...");
  v.tick(m, 4000);
  const first = screen(v, m, 4000).lines;
  expect(first[9]).toMatch(/Deleting\.\.\. +[━─]+/);
  expect(screen(v, m, 4300).lines[9]).not.toBe(first[9]);
  m.agents.splice(2, 1);
  v.removed();
  v.tick(m, 4500);
  expect(screen(v, m, 4500).lines.join("\n")).not.toContain("Deleting...");
});

test("the edit transition preserves its first frame, reverses smoothly and settles without draw-driven time", () => {
  const m = model(),
    v = new agentManager.View();
  m.options = () => ({ flags: "--verbose", env: [["TIMEOUT", "60000"]] });
  v.open(agentManager.agentKey("claude", work.account));
  const before = screen(v, m, 0).lines;
  v.key(13, m, 0);
  expect(v.transition.active).toBe(true);
  expect(screen(v, m, 0).lines).toEqual(before);
  v.tick(m, 100);
  const middle = screen(v, m, 100);
  expect(screen(v, m, 100).raw).toBe(middle.raw);
  expect(middle.lines).not.toEqual(before);
  // A click cannot activate an action while it is moving under the pointer.
  expect(v.click(middle.b, 75, 20, m)).toBeNull();
  v.key(27, m, 100);
  const reverse = screen(v, m, 100);
  expect(reverse.lines.map(line => line.replaceAll("━", "─"))).toEqual(
    middle.lines.map(line => line.replaceAll("━", "─")),
  );
  v.tick(m, 400);
  expect(v.transition.active).toBe(false);
  expect(screen(v, m, 400).lines).toEqual(before);
  v.key(13, m, 400);
  v.tick(m, 700);
  const settled = screen(v, m, 700).lines.join("\n");
  expect(settled).toContain("Extra flags");
  expect(settled).toContain("--verbose");
  expect(settled).toContain("TIMEOUT");
  expect(v.tick(m, 800)).toBe(false);
});

test("whole-row dragging previews the same shifted rows and bar as the sidebar", () => {
  const m = model(),
    v = new agentManager.View();
  v.open(agentManager.agentKey("claude", work.account));
  const box = b(v, m);
  v.pointer(box, 16, 9, 0, false, m);
  v.pointer(box, 16, 7, 32, false, m);
  const preview = screen(v, m).lines;
  expect(preview[7]).toContain("▌");
  expect(preview[7]).toContain("* work");
  expect(preview[8]).toContain("Codex");
  expect(v.pointer(box, 16, 7, 0, true, m)).toMatchObject({ kind: "move", row: "claude:/a/2", before: "codex" });
  v.pointer(box, 16, 9, 0, false, m);
  v.pointer(box, 16, 7, 32, false, m);
  expect(v.pointer(box, 90, 7, 0, true, m)).toBeNull();
  v.pointer(box, 16, 9, 0, false, m);
  m.agents.reverse();
  expect(v.pointer(box, 16, 7, 32, false, m)).toBeNull();
  expect(v.drag).toBeNull();
});

test("slash focuses search without inserting the shortcut", () => {
  const m = model(),
    v = new agentManager.View();
  v.open();
  v.key(47, m);
  expect(v.focus).toBe("search");
  expect(v.query.name()).toBe("");
  expect(screen(v, m).lines[2]).toContain(" /  Search");
});

test("list typing never starts search, and the visible action keys operate on its row", () => {
  const m = model(),
    v = new agentManager.View();
  v.open();
  for (const ch of "xyz") v.key(ch.charCodeAt(0), m);
  expect(v.focus).toBe("list");
  expect(v.query.name()).toBe("");
  const text = screen(v, m).lines.join("\n");
  for (const key of ["e Edit", "c Clone", "h Hide", "Shift+↑ Up", "Shift+↓ Down"]) expect(text).toContain(key);
  // The model's key is on its dropdown, not the bar.
  expect(text).not.toContain("Model ▾");
  expect(text).toMatch(/› ≡ † Codex +me@example.com +m  ▾ Auto \(last chosen\)/);
  expect(text).toMatch(/  ≡ \* Claude Code +me@example.com +▾ Auto \(last chosen\)/);
  // Clicking the key opens the picker, as the dropdown does.
  const box = b(v, m);
  expect(v.click(box, box.x + box.w - 32, 7, m)?.kind).toBe("models");
  v.key(27, m);
  expect(v.picker).toBeNull();
  expect(v.key(104, m)).toMatchObject({ kind: "here", shown: false });
  expect(v.key(109, m)?.kind).toBe("models");
  v.key(27, m);
  v.key(101, m);
  expect(v.page).toBe("agent");
  v.key(27, m);
  v.key(99, m);
  expect(v.agent_form.cloning).toBe(true);
  v.key(27, m);
  v.key(47, m);
  v.key(122, m);
  expect(v.query.name()).toBe("z");
});

test.each([104, 32])("keyboard visibility moves glide into their new group without moving focus (%s)", key => {
  const m = model(),
    v = new agentManager.View();
  v.open(agentManager.agentKey("claude", work.account));
  v.cell = { width: 10, height: 20 };
  expect(v.key(key, m, 1000)).toMatchObject({ kind: "here", shown: false });
  const focus = v.at;
  expect(v.tick(m, 1010)).toBe(false);
  m.agents[2] = { ...work, here: false };
  v.tick(m, 1020);
  v.tick(m, 1170);
  v.marks = (provider, col, row) => `<${provider} mark at ${col},${row}>`;
  const gliding = screen(v, m, 1170);
  expect(gliding.raw).toContain("a=T,f=100,i=730121");
  // The gliding row keeps its brand image the whole way.
  const row = Number(/\x1b\[(\d+);\d+Hwork/.exec(gliding.raw)![1]) - 1;
  expect(gliding.raw).toContain(`<claude mark at 5,${row}>`);
  v.marks = null;
  expect(v.at).toBe(focus);
  const settled = 1020 + rowGlide.total_ms;
  v.tick(m, settled);
  expect(screen(v, m, settled).raw).not.toContain("a=T,f=100,i=730121");
  v.at = agentManager.agentKey("claude", work.account);
  expect(v.key(key, m, settled + 80)).toMatchObject({ kind: "here", shown: true });
  m.agents[2] = { ...work, here: true };
  v.tick(m, settled + 100);
  v.tick(m, settled + 250);
  expect(screen(v, m, settled + 250).raw).toContain("a=T,f=100,i=730121");
  v.key(47, m, settled + 250);
  v.key(122, m, settled + 250);
  v.tick(m, settled + 250);
  expect(screen(v, m, settled + 250).raw).not.toContain("a=T,f=100,i=730121");
});

test("dragging between groups skips the visibility glide and uses a grab cursor", () => {
  const m = model(),
    v = new agentManager.View();
  v.open();
  v.cell = { width: 10, height: 20 };
  const box = b(v, m);
  expect(v.pointerShape(box, m, 10, 7)).toBe("grab");
  expect(v.pointerShape(box, m, box.w - 8, 7)).toBe("pointer");
  expect(v.pointerShape(box, m, 10, 2)).toBe("text");
  const selected = v.at;
  v.pointer_at = { x: 10, y: 9 };
  screen(v, m);
  expect(v.at).toBe(selected);
  v.pointer(box, 10, 9, 0, false, m);
  v.pointer(box, 10, 14, 32, false, m);
  expect(v.pointerShape(box, m, 90, 14)).toBe("grabbing");
  expect(v.pointer(box, 10, 14, 0, true, m)).toMatchObject({ kind: "move", shown: false });
  m.agents[2] = { ...work, here: false };
  v.tick(m, 1000);
  v.tick(m, 1150);
  expect(screen(v, m, 1150).raw).not.toContain("a=T,f=100,i=730121");
});
