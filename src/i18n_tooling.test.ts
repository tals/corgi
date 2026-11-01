import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const project = resolve(import.meta.dir, "..");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "corgi-translations-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "scripts"));
  copyFileSync(join(project, "src/locale.ts"), join(root, "src/locale.ts"));
  copyFileSync(join(project, "src/i18n.ts"), join(root, "src/i18n.ts"));
  copyFileSync(join(project, "scripts/locale.sh"), join(root, "scripts/locale.sh"));
  copyFileSync(join(project, ".prettierrc"), join(root, ".prettierrc"));
  const run = (command: string, ...options: string[]) => {
    const result = Bun.spawnSync([
      process.execPath,
      join(project, "scripts/translations.ts"),
      command,
      "--root",
      root,
      ...options,
    ]);
    return { code: result.exitCode, text: result.stdout.toString() + result.stderr.toString() };
  };
  const catalog = (language: string, value?: unknown) => {
    const path = join(root, "locales", language + ".json");
    if (value !== undefined) writeFileSync(path, JSON.stringify(value));
    return JSON.parse(readFileSync(path, "utf8"));
  };
  const translate = (values: Record<string, unknown>) => {
    for (const language of ["zh", "ja", "ko", "ru"]) catalog(language, values);
  };
  const source = (value: string) => writeFileSync(join(root, "src/example.ts"), value);
  return { root, run, catalog, translate, source, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("translation CI rejects missing, dead, stale and malformed messages", () => {
  const f = fixture();
  try {
    f.source('import * as i18n from "./i18n"; const name = "Corgi"; export const greeting = i18n.t`Hello ${name}`;');
    expect(f.run("extract").code).toBe(0);
    expect(f.run("check").text).toContain("untranslated");
    f.translate({ "Hello ${name}": "こんにちは ${name}" });
    expect(f.run("generate").code).toBe(0);
    expect(f.run("check").code).toBe(0);
    f.catalog("ja", {});
    expect(f.run("check").text).toContain("missing");
    f.catalog("ja", { "Hello ${name}": "こんにちは ${wrong}" });
    expect(f.run("check").text).toContain("placeholder mismatch");
    f.catalog("ja", { "Hello ${name}": "こんにちは ${name}", Obsolete: "古い" });
    expect(f.run("check").text).toContain("unused translation");
    f.catalog("ja", { "Hello ${name}": "やあ ${name}" });
    expect(f.run("check").text).toContain("stale generated translations");
    f.source('import * as i18n from "./i18n"; const name = "Corgi"; export const greeting = i18n.t`Welcome ${name}`;');
    const changed = f.run("check");
    expect(changed.text).toContain("missing");
    expect(changed.text).toContain("unused translation");
    const summary = f.run("check", "--summary");
    expect(summary.code).toBe(1);
    expect(summary.text).toContain("1 message needs translating, 1 unused translation");
    expect(summary.text).not.toContain("ja.json");
  } finally {
    f.close();
  }
}, 30000);

test("generated native templates reorder names, escape literal code, and use locale plural rules", () => {
  const f = fixture();
  try {
    f.source(
      'import * as i18n from "./i18n"; export const move = (file: string, folder: string) => i18n.t`Moved ${file} to ${folder}`; export const files = (count: number) => i18n.t`${count} files`;',
    );
    expect(f.run("extract").code).toBe(0);
    f.translate({
      "Moved ${file} to ${folder}": "${folder} ← ${file} ` \\ newline\n",
      "${count} files": "${count} files",
    });
    f.catalog("ru", {
      "Moved ${file} to ${folder}": "${folder} ← ${file}",
      "${count} files": {
        plural: "count",
        forms: { one: "${count} файл", few: "${count} файла", many: "${count} файлов", other: "${count} файла" },
      },
    });
    expect(f.run("generate").code).toBe(0);
    const code = `import * as i18n from ${JSON.stringify(join(f.root, "src/i18n.ts"))}; import {move, files} from ${JSON.stringify(join(f.root, "src/example.ts"))}; i18n.setLanguage("ja"); console.log(JSON.stringify(move("a.txt", "src"))); i18n.setLanguage("ru"); console.log(JSON.stringify([1,2,5,21].map(files))); i18n.setLanguage("en"); console.log(move("a.txt", "src"));`;
    const result = Bun.spawnSync([process.execPath, "-e", code]);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.toString().trim().split("\n");
    expect(JSON.parse(lines[0])).toBe("src ← a.txt ` \\ newline\n");
    expect(JSON.parse(lines[1])).toEqual(["1 файл", "2 файла", "5 файлов", "21 файл"]);
    expect(lines[2]).toBe("Moved a.txt to src");
    const ru = f.catalog("ru");
    delete ru["${count} files"].forms.few;
    f.catalog("ru", ru);
    expect(f.run("check").text).toContain("few");
  } finally {
    f.close();
  }
}, 30000);

test("extraction rejects expression placeholders and conflicting names, and ignores tests", () => {
  const f = fixture();
  try {
    f.source('import * as i18n from "./i18n"; i18n.t`Hello ${user.name}`;');
    expect(f.run("extract").text).toContain("use a named local");
    f.source('import * as i18n from "./i18n"; i18n.t`Hello ${name}`; i18n.t`Hello ${person}`;');
    expect(f.run("extract").text).toContain("inconsistent placeholder names");
    f.source('import * as i18n from "./i18n"; i18n.t`Welcome`;');
    writeFileSync(join(f.root, "src/example.test.ts"), 'import * as i18n from "./i18n"; i18n.t`Test fixture only`;');
    expect(f.run("extract").code).toBe(0);
    expect(Object.keys(f.catalog("ja"))).toEqual(["Welcome"]);
    writeFileSync(join(f.root, "src/controller.ts"), 'class View { show() { this.notice("Untranslated warning"); } }');
    expect(f.run("check").text).toContain("unmarked UI text");
  } finally {
    f.close();
  }
}, 30000);

test("generated installer templates treat leading dashes and shell syntax as literal text", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "scripts/install.sh.in"), "msg 'Moved ${file} to ${folder}'\n");
    expect(f.run("extract").code).toBe(0);
    const translated = "-- ${folder} ← ${file}; 100% 'quoted' `uname` $(printf unsafe) \\n\n";
    f.translate({ "Moved ${file} to ${folder}": translated });
    expect(f.run("generate").code).toBe(0);
    const shell =
      readFileSync(join(f.root, "scripts/install_i18n.generated.sh"), "utf8") +
      '\ni18n_init\nmsg \'Moved ${file} to ${folder}\' "$TEST_FILE" "$TEST_FOLDER"\n';
    const file = "a 'quoted' $(printf unsafe) % \\n",
      folder = "--target/`uname`\nnext line";
    for (const command of ["/bin/sh", "/bin/bash"]) {
      const result = Bun.spawnSync([command, "-eu", "-c", shell], {
        env: { ...process.env, CORGI_LANG: "ja", TEST_FILE: file, TEST_FOLDER: folder },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
      expect(result.stdout.toString()).toBe(translated.replace("${folder}", folder).replace("${file}", file));
    }
  } finally {
    f.close();
  }
}, 30000);
