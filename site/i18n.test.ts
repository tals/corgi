import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as app from "../src/i18n";
import * as i18n from "./i18n";
import * as html from "../scripts/html_translations";

test("site tags share the application's locale and actual messages", () => {
  try {
    for (const language of app.locales) {
      app.setLanguage(language);
      expect(i18n.t`workspaces`).toBe(app.t`workspaces`);
      const count = 2;
      expect(i18n.t`${count} unread →`).toBe(app.t`${count} unread →`);
    }
  } finally {
    app.setLanguage("en");
  }
});

test("HTML extraction preserves inline links and translates accessible attributes", async () => {
  const seen: string[] = [];
  const translated = await html.transform(
    '<p data-i18n>Read <a href="/docs">the docs</a>.</p><button title="Copy" data-i18n-attrs="title">⌘</button>',
    source => {
      seen.push(source);
      return source === "Copy" ? "复制" : '<a href="/docs">阅读文档</a>。';
    },
  );
  expect(seen).toEqual(['Read <a href="/docs">the docs</a>.', "Copy"]);
  expect(translated).toContain('<a href="/docs">阅读文档</a>。');
  expect(translated).toContain('title="复制"');
  await expect(html.transform("<p data-i18n><b data-i18n>nested</b></p>", source => source)).rejects.toThrow("Nested");
});

test("site validation is opt-in and rejects missing, dead, stale and unsafe markup", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-site-i18n-"));
  const project = join(import.meta.dir, "..");
  try {
    for (const directory of ["src", "scripts", "locales", "site/locales"])
      mkdirSync(join(root, directory), { recursive: true });
    copyFileSync(join(project, ".prettierrc"), join(root, ".prettierrc"));
    copyFileSync(join(project, "scripts/locale.sh"), join(root, "scripts/locale.sh"));
    writeFileSync(join(root, "src/example.ts"), 'import * as i18n from "./i18n"; i18n.t`Shared ${name}`;');
    writeFileSync(join(root, "site/main.js"), 'import * as i18n from "./i18n"; i18n.t`Shared ${name}`;');
    const source = 'Read <a href="/docs">the docs</a>.';
    writeFileSync(join(root, "site/index.html"), `<p data-i18n>${source}</p>`);
    for (const language of app.locales.filter(value => value !== "en"))
      writeFileSync(join(root, "locales", language + ".json"), JSON.stringify({ "Shared ${name}": "共有 ${name}" }));
    const run = (command: string, site = true) => {
      const result = Bun.spawnSync([
        process.execPath,
        join(project, "scripts/translations.ts"),
        command,
        "--root",
        root,
        ...(site ? ["--site"] : []),
      ]);
      return { code: result.exitCode, text: result.stdout.toString() + result.stderr.toString() };
    };
    const set = (language: string, value: unknown) =>
      writeFileSync(join(root, "site/locales", language + ".json"), JSON.stringify(value));
    expect(run("extract").code).toBe(0);
    expect(Object.keys(JSON.parse(readFileSync(join(root, "site/locales/ja.json"), "utf8")))).toEqual([source]);
    expect(run("check").text).toContain("untranslated");
    expect(run("generate", false).code).toBe(0);
    expect(run("check", false).code).toBe(0);
    const cachedAppScan = readFileSync(join(root, ".tools/i18n/scan.json"), "utf8");
    const cachedAppFormat = readFileSync(join(root, ".tools/i18n/format.json"), "utf8");
    const translated = '<a href="/docs">文档</a>。';
    for (const language of app.locales.filter(value => value !== "en")) set(language, { [source]: translated });
    expect(run("generate").code).toBe(0);
    expect(run("check").code).toBe(0);
    set("ja", {});
    expect(run("check").text).toContain("missing");
    set("ja", { [source]: translated, Dead: "不要" });
    expect(run("check").text).toContain("unused translation");
    set("ja", { [source]: translated.replace("/docs", "javascript:alert(1)") });
    expect(run("check").text).toContain("HTML markup mismatch");
    set("ja", { [source]: translated + "!" });
    expect(run("check").text).toContain("stale generated translations");
    writeFileSync(join(root, "site/main.js"), 'import * as i18n from "./i18n"; i18n.t`Shared ${person}`;');
    expect(run("check").text).toContain("inconsistent placeholder names");
    expect(readFileSync(join(root, ".tools/i18n/scan.json"), "utf8")).toBe(cachedAppScan);
    expect(readFileSync(join(root, ".tools/i18n/format.json"), "utf8")).toBe(cachedAppFormat);
    expect(run("check", false).code).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
