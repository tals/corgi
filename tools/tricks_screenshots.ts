/** Regenerate the Tricks guide's PNGs in live Ghostty: bun tools/tricks_screenshots.ts [output-directory]. */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Connection } from "../src/rpc";
import * as ghostty from "./ghostty_screenshot";

const out = resolve(process.argv[2] ?? join(import.meta.dir, "../docs/images"));

await ghostty.capture(
  { sandbox: "tricks", cols: 110, rows: 32, fontSize: 16 },
  {
    async prepare(s) {
      const conn = new Connection(s.env.CORGI_SOCKET);
      try {
        const agents = await ghostty.until(async () => {
          const snapshot = await conn.call("session.snapshot");
          const agents = snapshot.panes.filter(p => p.agent.provider === "claude");
          return agents.length === 3 ? agents : null;
        });
        await ghostty.until(async () => {
          const { tricks } = await conn.call("tricks.list");
          return tricks.length === 5 && tricks.every(t => t.running && !t.error);
        });
        for (const [i, agent] of agents.entries())
          await conn.call("session.command", {
            command: { "pane.rename": { target: agent.id, name: ["Personal", "Work", "Client"][i] } },
          });
        const snapshot = await conn.call("session.snapshot");
        const workspace = snapshot.workspaces[0];
        await conn.call("session.command", { command: { "workspace.edit": { target: workspace.id, name: "Tricks" } } });
        const shell = snapshot.panes.find(p => !p.agent.provider)!;
        const source = readFileSync(join(s.root, "examples/tricks/account-colors/main.mjs"), "utf8");
        s.write(join(s.dir, "app/account-colors.mjs"), source);
        s.corgi(["tab", "rename", String(workspace.model.tabs[0].id), "account-colors.mjs"]);
        s.run([s.exe, "pane", "send", String(shell.id), "clear; cat account-colors.mjs"]);
        s.run([s.exe, "pane", "keys", String(shell.id), "enter"]);
      } finally {
        conn.close();
      }
    },
    async drive(d) {
      // The 110×32 layout puts the first account on sidebar row 18.
      d.move(7, 18);
      await d.screenshot(join(out, "tricks-account-colors.png"));
      d.move(109, 31);
      d.sandbox!.run([d.sandbox!.exe, "action", "setup"]);
      await d.settle();
      d.key(...Array(9).fill("Down"));
      await d.screenshot(join(out, "tricks-settings.png"));
      d.key("Return");
      await d.settle();
      d.key("Down");
      await d.settle();
      d.key("Return");
      await d.settle();
      d.key("Down", "Return");
      await d.screenshot(join(out, "tricks-palette-schemes.png"));
      d.key("Escape", "Down", "Return");
      await d.screenshot(join(out, "tricks-palettes.png"));
    },
  },
);
