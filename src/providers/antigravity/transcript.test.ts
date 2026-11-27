import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Terminal } from "../../pane/terminal";
import { Launch, Pane, Runtime } from "../../runtime";
import { Worker } from "../../usage/worker";
import { Workspace } from "../../workspace";
import { directory } from "./config";
import { database } from "./summaries";

test("Antigravity reads titles only for followed sessions in their owning account", async () => {
  const home = mkdtempSync(join(tmpdir(), "corgi-agy-titles-")),
    runtime = new Runtime(),
    worker = new Worker(),
    pane = new Pane(1, Terminal.create(20, 4), home),
    parent = runtime.conversations.get("antigravity", "11111111-1111-4111-8111-111111111111"),
    child = runtime.conversations.get("antigravity", "22222222-2222-4222-8222-222222222222"),
    writers: Database[] = [];
  runtime.workspaces.items.push(new Workspace(1, home));
  runtime.panes.push(pane);
  parent.workspace = child.workspace = 1;
  child.parent = parent.id;
  pane.attachment.select(parent);
  const names = async () => {
    worker.reconcile(runtime);
    await worker.run();
    return worker.take().map(r => r.name.text());
  };
  try {
    for (const name of ["First", "Second"]) {
      const account = join(home, name);
      mkdirSync(directory(account), { recursive: true });
      const db = new Database(database(directory(account)));
      writers.push(db);
      // Reading the unrelated title fails the query, so a history-wide refresh loses the followed titles.
      db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE titles (conversation_id TEXT PRIMARY KEY, name TEXT);
        CREATE VIEW conversation_summaries AS SELECT conversation_id,
          CASE WHEN name IS NULL THEN json_extract('invalid', '$') ELSE name END AS title FROM titles;
        INSERT INTO titles VALUES ('unrelated', NULL);
      `);
      const insert = db.query("INSERT INTO titles VALUES (?,?)");
      insert.run(parent.state.sessionId(), name);
      insert.run(child.state.sessionId(), name + " child");
      pane.launch = new Launch({ provider: "antigravity", env: [["HOME", account]] });
      expect(await names()).toEqual([name, name + " child"]);
      db.query("UPDATE titles SET name=? WHERE conversation_id=?").run(name + " renamed", parent.state.sessionId());
      expect(await names()).toEqual([name + " renamed", name + " child"]);
    }
    child.parent = null;
    expect(await names()).toEqual(["Second renamed"]);
    expect(worker.reader("antigravity")?.name?.(child.state.sessionId(), join(home, "Second")).len).toBe(0);
    pane.attachment.deselect();
    expect(await names()).toEqual([]);
    expect(worker.reader("antigravity")?.name?.(parent.state.sessionId(), join(home, "Second")).len).toBe(0);
  } finally {
    worker.stop();
    runtime.destroy();
    for (const db of writers) db.close();
    rmSync(home, { recursive: true, force: true });
  }
});
