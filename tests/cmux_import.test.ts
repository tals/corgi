import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { registerCase, TestCase, writeExecutable, ROOT } from "./support";
import { screen_text } from "./runtime";
import { Viewer } from "./viewer_client";
import { ImportFixture } from "./import_fixture";

const CLI = `import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.CMUX_TEST_LOG, JSON.stringify(args) + '\\n');
const mode = process.env.CMUX_TEST_MODE;
if (mode === 'hang') { process.stdout.end?.(); await Bun.sleep(60000); process.exit(0); }
if (mode === 'unreadable') { console.log('{new-format: ???'); process.exit(0); }
if (mode === 'old') {
  if (args.includes('--id-format') || args[0] === 'tree') process.exit(1);
  if (args[0] === 'list-windows') console.log(JSON.stringify({windows:[{id:'w1'},{id:'w2'}]}));
  else if (args[0] === 'list-workspaces') { const window = args[args.indexOf('--window') + 1]; console.log(JSON.stringify({workspaces:[{id:window,name:'Old '+window,cwd:'/tmp'}]})); }
  else process.exit(1);
} else if (args[0] === 'tree') console.log(readFileSync(process.env.CMUX_TEST_FIXTURE, 'utf8'));
else if (args[0] === 'list-panes') console.log(JSON.stringify({panes:[]}));
else process.exit(1);
`;

class CmuxImport extends TestCase {
  fixture!: ImportFixture;
  async setUp() {
    this.fixture = new ImportFixture();
    Object.assign(this.fixture.env, {
      CMUX_TEST_LOG: join(this.fixture.root, "cmux-commands.jsonl"),
      CMUX_TEST_MODE: "recent",
      CMUX_TEST_FIXTURE: join(ROOT, "src/testdata/cmux-tree.json"),
    });
    writeExecutable(join(this.fixture.root, "bin/cmux"), CLI);
    await this.fixture.start();
  }
  async tearDown() {
    await this.fixture.close();
  }
  async wizard(mode = "recent", cols = 100, rows = 34) {
    this.fixture.env.CMUX_TEST_MODE = mode;
    const viewer = await Viewer.create(this.fixture, cols, rows);
    await viewer.input("\r");
    await viewer.input("3");
    return viewer;
  }
  async text(viewer: Viewer, cols = 100, rows = 34) {
    return screen_text((await viewer.poll()).data, cols, rows).join("\n");
  }
  shape(ws: any, tab: any, snapshot: any): any {
    const names = Object.fromEntries(snapshot.panes.map((p: any) => [p.id, p.name]));
    const visit = (index: number): any => {
      const node = ws.model.nodes[index];
      if ("pane" in node) return names[node.pane];
      const split = node.split;
      return [split.axis, split.ratio, visit(split.first), visit(split.second)];
    };
    return visit(tab.root);
  }

  async test_layers_partial_recovery_and_real_shells() {
    const v = await this.wizard();
    await this.fixture.until(async () => (await this.text(v)).includes("Workspace only"));
    const before = await this.text(v);
    this.assertIn("I'm confused by this cmux version.", before);
    this.assertIn("Split layout approximated", before);
    await v.input(" j j \r");
    await this.fixture.until(async () => (await this.text(v)).includes("You're ready to go"));
    const snapshot = await this.fixture.rpc({ op: "session.snapshot" });
    const byName = Object.fromEntries(snapshot.workspaces.map((w: any) => [w.name, w]));
    const project: any = byName["cmux project"];
    this.assertEqual(
      project.model.tabs.map((t: any) => this.shape(project, t, snapshot)),
      [["horizontal", 600, "Editor", "Server"], ["horizontal", 600, "Build", "Logs"], "Docs"],
    );
    const research: any = byName.research;
    this.assertEqual(research.model.tabs.length, 1);
    this.assertEqual(realpathSync(research.cwd), realpathSync(join(this.fixture.root, "home")));
    const imported = new Set(
      snapshot.workspaces
        .filter((w: any) => ["cmux project", "layoutless", "research"].includes(w.name))
        .map((w: any) => w.id),
    );
    const panes = snapshot.panes.filter((p: any) => imported.has(p.workspace));
    this.assertEqual(panes.length, 8);
    this.assertTrue(panes.every((p: any) => p.pid > 0));
    const commands = readFileSync(this.fixture.env.CMUX_TEST_LOG, "utf8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line)[0]);
    this.assertTrue(commands.every(command => ["tree", "list-panes"].includes(command)));
  }
  async test_old_cli_recovers_workspaces_across_windows() {
    const v = await this.wizard("old");
    await this.fixture.until(async () => (await this.text(v)).includes("Old w2"));
    this.assertIn("Workspace only", await this.text(v));
    await v.input(" j \r");
    await this.fixture.until(async () => (await this.text(v)).includes("You're ready to go"));
    const snapshot = await this.fixture.rpc({ op: "session.snapshot" });
    const ws = snapshot.workspaces.filter((w: any) => w.name.startsWith("Old "));
    this.assertEqual(new Set(ws.map((w: any) => w.name)), new Set(["Old w1", "Old w2"]));
    this.assertTrue(ws.every((w: any) => w.model.tabs.length === 1));
  }
  async test_unreadable_source_is_not_reported_as_empty_and_blinks_without_input() {
    const v = await this.wizard("unreadable", 76, 26);
    await this.fixture.until(async () => (await this.text(v, 76, 26)).includes("No workspaces could be recovered"));
    const frames = new Set<string>();
    await this.fixture.until(async () => {
      const text = await this.text(v, 76, 26);
      for (const frame of ["ᐱoᴥ°ᐱ", "ᐱ─ᴥ─ᐱ"]) if (text.includes(frame)) frames.add(frame);
      this.assertIn("I'm confused by this cmux version.", text);
      this.assertNotIn("No available sessions found", text);
      return frames.size === 2;
    }, 6);
    this.assertEqual((await this.fixture.rpc({ op: "session.snapshot" })).panes, []);
  }
  async test_recovery_notes_keep_mouse_selection_aligned_at_minimum_size() {
    const v = await this.wizard("old", 76, 26);
    await this.fixture.until(async () => (await this.text(v, 76, 26)).includes("Old w2"));
    const rows = screen_text((await v.poll()).data, 76, 26);
    const y = rows.findIndex(row => row.includes("Old w2"));
    const x = rows[y].indexOf("Old w2");
    await v.input(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`);
    this.assertIn("[x] Old w2", await this.text(v, 76, 26));
    this.assertIn("[ ] Old w1", await this.text(v, 76, 26));
    await v.input("\r");
    await this.fixture.until(async () => (await this.text(v, 76, 26)).includes("You're ready to go"));
    const names = new Set((await this.fixture.rpc({ op: "session.snapshot" })).workspaces.map((w: any) => w.name));
    this.assertIn("Old w2", names);
    this.assertNotIn("Old w1", names);
  }
  async test_invalid_import_tree_is_rejected_before_creating_shells() {
    const before = await this.fixture.rpc({ op: "session.snapshot" });
    const result = await this.fixture.rpc(
      {
        op: "onboarding.copy",
        operation: 71,
        source: "cmux",
        workspaces: [
          {
            id: "bad",
            name: "must not exist",
            cwd: "/tmp",
            tabs: [
              {
                id: "tab",
                name: "bad",
                panes: [{ id: "p", name: "bad" }],
                nodes: [{ pane: 7 }],
              },
            ],
          },
        ],
      },
      true,
    );
    this.assertEqual(result.err, "InvalidImportLayout");
    const after = await this.fixture.rpc({ op: "session.snapshot" });
    this.assertEqual(after.panes, before.panes);
    this.assertEqual(after.workspaces, before.workspaces);
  }
  async test_closing_wizard_cancels_cli_that_closed_stdout_but_did_not_exit() {
    const v = await this.wizard("hang");
    await this.fixture.until(() => existsSync(this.fixture.env.CMUX_TEST_LOG));
    const started = Date.now();
    await v.input("s");
    this.assertLess(Date.now() - started, 2000);
  }
}

registerCase("cmux import", CmuxImport, {
  skip: process.platform !== "darwin" ? "cmux is offered only on macOS" : undefined,
});
