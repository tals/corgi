import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { customizations, directory } from "./config";
import * as privateHome from "./private";

test("private Antigravity inference keeps the login method and its own tool settings", () => {
  const account = privateHome.temporary(),
    settings = { modelProvider: "gemini", title: { command: "example" }, trustedWorkspaces: ["/project"] };
  try {
    mkdirSync(directory(account), { recursive: true });
    writeFileSync(join(directory(account), "settings.json"), JSON.stringify(settings));
    mkdirSync(customizations(account));
    writeFileSync(join(customizations(account), "hooks.json"), '{"user":{}}');
    for (const inference of [true, false]) {
      const root = privateHome.create(account, inference);
      try {
        expect(JSON.parse(readFileSync(join(directory(root), "settings.json"), "utf8"))).toEqual(
          inference ? { modelProvider: "gemini" } : settings,
        );
        expect(Object.keys(JSON.parse(readFileSync(join(customizations(root), "hooks.json"), "utf8")))).toEqual([
          inference ? "Corgi private inference" : "user",
        ]);
      } finally {
        privateHome.remove(root);
      }
    }
  } finally {
    privateHome.remove(account);
  }
});
