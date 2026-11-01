//! Extract ordinary template tags, validate catalogs, and compile JS and shell messages.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import * as tooling from "./tooling";
import * as locale from "../src/locale";

type Message = { source: string; parts: string[]; names: string[]; locations: string[]; shell: boolean; js: boolean };
type Plural = { plural: string; forms: Partial<Record<Intl.LDMLPluralRule, string>> };
type Translation = string | Plural;
type Catalog = Record<string, Translation>;
type Catalogs = Record<locale.TranslatedLocale, Catalog>;
export type Problem = "missing" | "unused" | "invalid" | "stale";
export type Report = {
  messages: number;
  /** Source errors, such as unnamed placeholders. Nothing is extracted or generated until they're fixed. */
  errors: string[];
  /** Catalog and generated-file problems. Generated output leaves these messages in English. */
  problems: { kind: Problem; subject: string; error: string }[];
};

const project = resolve(import.meta.dir, "..");
const outputs = ["src/i18n.generated.ts", "scripts/install_i18n.generated.sh"];
// Only these files' literal UI text is checked for a missing i18n.t.
const displays: Record<string, string[]> = {
  "src/controller.ts": ["notice"],
  "src/shortcut_help.ts": ["heading", "group", "binding", "action", "featured", "alsoHeld", "pair"],
};

function sources(root: string): string[] {
  return [...new Bun.Glob("src/**/*.ts").scanSync(root)]
    .filter(path => !/\.(?:test|generated|d)\.ts$/.test(path))
    .sort();
}

// What one source file marks, in order; each file's result is cached by its contents.
type Found =
  | { kind: "template"; parts: string[]; names: string[]; location: string }
  | { kind: "document"; path: string; location: string }
  | { kind: "error"; error: string };
type Scans = { script: string; files: Record<string, { hash: string; found: Found[] }> };
const scanCache = (root: string) => join(root, ".tools/i18n/scan.json");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

async function typescript(): Promise<any> {
  const [compiler] = await tooling.packages("translations", { typescript: "6.0.3" });
  return import(join(compiler, "lib/typescript.js"));
}

function parse(ts: any, root: string, path: string, text: string): Found[] {
  const found: Found[] = [],
    source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true),
    namespaces = new Set<string>(),
    tags = new Set<string>(),
    imports = new Map<string, string>(),
    display = displays[path] ?? [];
  const line = (node: any) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      statement.moduleSpecifier.text.endsWith(".txt") &&
      statement.importClause?.name
    )
      imports.set(
        statement.importClause.name.text,
        relative(root, resolve(dirname(join(root, path)), statement.moduleSpecifier.text)),
      );
    if (!ts.isImportDeclaration(statement) || !/\/(?:i18n)(?:\.ts)?$/.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings))
      for (const element of bindings.elements)
        if ((element.propertyName ?? element.name).text === "t") tags.add(element.name.text);
  }
  function visit(node: any) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const argument = node.arguments[0];
      if (
        display.includes(node.expression.name.text) &&
        argument &&
        (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) &&
        /[A-Za-z]{2}/.test(argument.text)
      )
        found.push({ kind: "error", error: `${path}:${line(argument)}: unmarked UI text; use i18n.t` });
      if (namespaces.has(node.expression.expression.text) && node.expression.name.text === "document") {
        const document = argument && ts.isIdentifier(argument) ? imports.get(argument.text) : undefined;
        if (!document) found.push({ kind: "error", error: `${path}: i18n.document requires an imported text asset` });
        else found.push({ kind: "document", path: document, location: `${path} (${document})` });
      }
    }
    if (ts.isTaggedTemplateExpression(node)) {
      const tag = node.tag;
      const marked = ts.isIdentifier(tag)
        ? tags.has(tag.text)
        : ts.isPropertyAccessExpression(tag) && namespaces.has(tag.expression.text) && tag.name.text === "t";
      if (marked) {
        const location = `${path}:${line(node)}`;
        const template = node.template;
        if (ts.isNoSubstitutionTemplateLiteral(template))
          found.push({ kind: "template", parts: [template.text], names: [], location });
        else {
          const parts = [template.head.text],
            names: string[] = [];
          for (const span of template.templateSpans) {
            if (!ts.isIdentifier(span.expression))
              found.push({
                kind: "error",
                error: `${location}: use a named local for ${span.expression.getText(source)}`,
              });
            names.push(span.expression.getText(source));
            parts.push(span.literal.text);
          }
          found.push({ kind: "template", parts, names, location });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

/** Finds every marked message, parsing only the files that changed since the last scan. */
async function scan(root: string): Promise<{ messages: Message[]; errors: string[] }> {
  const messages = new Map<string, Message>(),
    shapes = new Map<string, string>(),
    errors: string[] = [];
  function add(parts: string[], names: string[], location: string, shell = false): void {
    if (parts.some(part => /\$\{/.test(part))) {
      errors.push(`${location}: literal \u0024{ is reserved for named translation placeholders`);
      return;
    }
    const source = parts.map((part, i) => part + (i < names.length ? "${" + names[i] + "}" : "")).join("");
    const shape = JSON.stringify(parts),
      previous = shapes.get(shape);
    if (previous && previous !== source)
      errors.push(`${location}: inconsistent placeholder names: ${source} / ${previous}`);
    shapes.set(shape, source);
    const found = messages.get(source);
    if (found) {
      found.locations.push(location);
      found.shell ||= shell;
      found.js ||= !shell;
    } else messages.set(source, { source, parts, names, locations: [location], shell, js: !shell });
  }
  const script = hash(readFileSync(import.meta.path, "utf8"));
  let previous: Scans = { script, files: {} };
  try {
    const cached = JSON.parse(readFileSync(scanCache(root), "utf8")) as Scans;
    if (cached.script === script) previous = cached;
  } catch {}
  const next: Scans = { script, files: {} };
  let ts: any = null,
    changed = false;
  for (const path of sources(root)) {
    const text = readFileSync(join(root, path), "utf8");
    // Tags come from an i18n import, so other files can't mark anything.
    if (!text.includes("i18n") && !(path in displays)) continue;
    const key = hash(text);
    let entry = previous.files[path];
    if (entry?.hash !== key) {
      ts ??= await typescript();
      entry = { hash: key, found: parse(ts, root, path, text) };
      changed = true;
    }
    next.files[path] = entry;
    for (const found of entry.found) {
      if (found.kind === "error") errors.push(found.error);
      else if (found.kind === "template") add(found.parts, found.names, found.location);
      else add([readFileSync(join(root, found.path), "utf8")], [], found.location);
    }
  }
  if (changed || Object.keys(previous.files).length !== Object.keys(next.files).length)
    try {
      write(scanCache(root), JSON.stringify(next));
    } catch {}
  const installer = join(root, "scripts/install.sh.in");
  if (existsSync(installer)) {
    const source = readFileSync(installer, "utf8");
    for (const match of source.matchAll(/\bmsg\s+'([^']*)'/g)) {
      const value = match[1],
        parts: string[] = [],
        names: string[] = [];
      let start = 0;
      for (const token of value.matchAll(/\$\{([A-Za-z_][A-Za-z_0-9]*)\}/g)) {
        parts.push(value.slice(start, token.index));
        names.push(token[1]);
        start = token.index! + token[0].length;
      }
      parts.push(value.slice(start));
      add(parts, names, `scripts/install.sh.in:${source.slice(0, match.index).split("\n").length}`, true);
    }
  }
  const ordered = [...messages.values()].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  return { messages: ordered, errors };
}

function catalogPath(root: string, language: locale.TranslatedLocale): string {
  return join(root, "locales", `${language}.json`);
}

function readCatalog(root: string, language: locale.TranslatedLocale): Catalog {
  const path = catalogPath(root, language);
  const value: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(`${path}: expected a message object`);
  return value as Catalog;
}

/** Lists catalog problems, and returns only the entries that can be compiled. */
function validate(
  root: string,
  messages: Message[],
  catalogs: Catalogs,
): { problems: Report["problems"]; valid: Catalogs } {
  const problems: Report["problems"] = [],
    known = new Set(messages.map(message => message.source)),
    valid = {} as Catalogs;
  for (const language of locale.translated) {
    const path = catalogPath(root, language),
      catalog = catalogs[language];
    valid[language] = {};
    for (const key of Object.keys(catalog))
      if (!known.has(key))
        problems.push({ kind: "unused", subject: key, error: `${path}: unused translation ${JSON.stringify(key)}` });
    for (const message of messages) {
      const entry = catalog[message.source],
        quoted = JSON.stringify(message.source);
      let ok = true;
      const problem = (kind: Problem, error: string) => {
        problems.push({ kind, subject: message.source, error });
        ok = false;
      };
      if (entry === undefined) {
        problem("missing", `${path}: missing ${quoted} (${message.locations[0]})`);
        continue;
      }
      const check = (translated: unknown, category = "") => {
        if (typeof translated !== "string" || !translated.trim()) {
          problem("missing", `${path}: untranslated ${quoted} ${category}`);
          return;
        }
        const parameters = [...translated.matchAll(/\$\{([^}]*)\}/g)].map(match => match[1]);
        const expected = new Set(message.names),
          actual = new Set(parameters);
        if (
          parameters.some(name => !/^[A-Za-z_$][\w$]*$/.test(name)) ||
          expected.size !== actual.size ||
          [...expected].some(name => !actual.has(name))
        )
          problem("invalid", `${path}: placeholder mismatch for ${quoted} ${category}`);
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(translated))
          problem("invalid", `${path}: control character in ${quoted}`);
      };
      if (typeof entry === "string") check(entry);
      else if (
        entry &&
        typeof entry === "object" &&
        typeof entry.plural === "string" &&
        entry.forms &&
        typeof entry.forms === "object"
      ) {
        if (!message.names.includes(entry.plural))
          problem("invalid", `${path}: unknown plural variable ${entry.plural}`);
        if (message.shell) problem("invalid", `${path}: installer messages cannot use plural variants`);
        const categories = new Intl.PluralRules(language).resolvedOptions().pluralCategories;
        for (const category of categories) check(entry.forms[category], category);
        for (const [category, form] of Object.entries(entry.forms)) {
          if (!categories.includes(category as Intl.LDMLPluralRule))
            problem("invalid", `${path}: unused plural category ${category}`);
          check(form, category);
        }
      } else problem("invalid", `${path}: invalid translation for ${quoted}`);
      if (ok) valid[language][message.source] = entry;
    }
  }
  return { problems, valid };
}

function template(value: string, names: string[]): string {
  let result = "`",
    start = 0;
  const literal = (text: string) =>
    text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${").replace(/\r/g, "\\r");
  for (const token of value.matchAll(/\$\{([A-Za-z_$][\w$]*)\}/g)) {
    result += literal(value.slice(start, token.index)) + "${v" + names.indexOf(token[1]) + "}";
    start = token.index! + token[0].length;
  }
  return result + literal(value.slice(start)) + "`";
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
function shellPrint(value: string, names: string[]): string {
  let start = 0;
  const args: string[] = [];
  for (const token of value.matchAll(/\$\{([A-Za-z_][A-Za-z_0-9]*)\}/g)) {
    if (token.index! > start) args.push(quote(value.slice(start, token.index)));
    args.push('"${' + (names.indexOf(token[1]) + 1) + '-}"');
    start = token.index! + token[0].length;
  }
  if (start < value.length) args.push(quote(value.slice(start)));
  return `printf '%s' ${args.length ? args.join(" ") : "''"}`;
}

/** The generated files' contents. Messages without a valid translation are left out, so they show in English. */
function render(root: string, messages: Message[], valid: Catalogs): Record<string, string> {
  // Written already formatted; Prettier skips the file (.prettierignore).
  let js =
    "// Generated by bun run i18n generate. Do not edit.\n" +
    'import { plural } from "./locale";\n' +
    'import type { TranslatedLocale } from "./locale";\n' +
    "export type Value = string | number | bigint;\n" +
    "export type Message = (...values: Value[]) => string;\n" +
    "export const messages: Record<TranslatedLocale, Record<string, Message>> = {\n";
  for (const language of locale.translated) {
    js += `  ${JSON.stringify(language)}: {\n`;
    for (const message of messages) {
      const entry = valid[language][message.source];
      if (!message.js || entry === undefined) continue;
      const args = `(${message.names.map((_, i) => `v${i}`).join(", ")})`;
      // The key is the JSON text itself, quoted as a JS string.
      const key = JSON.stringify(message.parts).replaceAll("\\", "\\\\").replaceAll("'", "\\'");
      js += `    '${key}': ${args} => `;
      if (typeof entry === "string") js += template(entry, message.names) + ",\n";
      else {
        js += `{\n      switch (plural(${JSON.stringify(language)}, Number(v${message.names.indexOf(entry.plural)}))) {\n`;
        for (const [category, form] of Object.entries(entry.forms))
          js += `        case ${JSON.stringify(category)}:\n          return ${template(form!, message.names)};\n`;
        js += `        default:\n          return ${template(entry.forms.other!, message.names)};\n      }\n    },\n`;
      }
    }
    js += "  },\n";
  }
  js += "};\n";
  let shell =
    "# Generated by bun run i18n generate. Do not edit.\n" +
    readFileSync(join(root, "scripts/locale.sh"), "utf8") +
    '\nmsg() {\n  i18n_source=$1; shift\n  case "${i18n_language:-en}:$i18n_source" in\n';
  for (const message of messages.filter(message => message.shell)) {
    for (const language of ["en", ...locale.translated]) {
      const entry = language === "en" ? undefined : valid[language as locale.TranslatedLocale][message.source];
      const value = typeof entry === "string" ? entry : message.source;
      shell += `    ${quote(language + ":" + message.source)}) ${shellPrint(value, message.names)};;\n`;
    }
  }
  shell += '    *) printf "%s" "$i18n_source";;\n  esac\n}\n';
  return { [outputs[0]]: js, [outputs[1]]: shell };
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function stale(root: string, files: Record<string, string>): Report["problems"] {
  return Object.entries(files)
    .filter(([path, contents]) => !existsSync(join(root, path)) || readFileSync(join(root, path), "utf8") !== contents)
    .map(([path]) => ({
      kind: "stale",
      subject: path,
      error: `${path}: stale generated translations; run bun run i18n generate`,
    }));
}

/** Checks sources, catalogs and generated files without changing anything. */
export async function check(root = project): Promise<Report> {
  const found = await scan(root);
  const report: Report = { messages: found.messages.length, errors: found.errors, problems: [] };
  if (!found.errors.length) {
    const catalogs = Object.fromEntries(
      locale.translated.map(language => [language, readCatalog(root, language)]),
    ) as Catalogs;
    const { problems, valid } = validate(root, found.messages, catalogs);
    report.problems = [...problems, ...stale(root, render(root, found.messages, valid))];
  }
  return report;
}

/** Writes the generated files from whatever translations are valid. */
export async function generate(root = project): Promise<Report> {
  const found = await scan(root);
  const report: Report = { messages: found.messages.length, errors: found.errors, problems: [] };
  if (found.errors.length) return report;
  const catalogs = Object.fromEntries(
    locale.translated.map(language => [language, readCatalog(root, language)]),
  ) as Catalogs;
  const { problems, valid } = validate(root, found.messages, catalogs);
  for (const [path, contents] of Object.entries(render(root, found.messages, valid))) write(join(root, path), contents);
  report.problems = problems;
  return report;
}

/** Adds new messages to every catalog, with blank translations, and drops unused ones. */
export async function extract(root = project): Promise<Report> {
  const found = await scan(root);
  const report: Report = { messages: found.messages.length, errors: found.errors, problems: [] };
  if (found.errors.length) return report;
  for (const language of locale.translated) {
    const catalog = readCatalog(root, language);
    const next = Object.fromEntries(found.messages.map(message => [message.source, catalog[message.source] ?? ""]));
    write(catalogPath(root, language), JSON.stringify(next, null, 2) + "\n");
  }
  write(join(root, ".tools/i18n/messages.json"), JSON.stringify(found.messages, null, 2) + "\n");
  return report;
}

/** Counts each kind of problem, for a short warning. */
export function summary(report: Report, color: boolean): string {
  const count = (kind: Problem) =>
    new Set(report.problems.filter(problem => problem.kind === kind).map(problem => problem.subject)).size;
  const line = (size: number, one: string, many: string) => (size ? [`${size} ${size === 1 ? one : many}`] : []);
  const found = [
    ...line(count("missing"), "message needs translating", "messages need translating"),
    ...line(count("unused"), "unused translation", "unused translations"),
    ...line(count("invalid"), "malformed translation", "malformed translations"),
    ...(count("stale") ? ["generated files are stale"] : []),
  ];
  const dim = (text: string) => (color ? `\x1b[2m${text}\x1b[0m` : text);
  return [
    ...["Translations incomplete:", ...found.map(text => `  • ${text}`)].map(dim),
    `${dim("Run")} bun run i18n extract${dim(" and fill in the new entries. See locales/README.md.")}`,
    "",
  ].join("\n");
}

/**
 * Build and typecheck's translation step. CI requires complete, current translations. A local run
 * regenerates stale files and only warns about the rest, which shows in English meanwhile.
 * Resolves to the exit code and the text to show.
 */
export async function verify(
  ci = process.argv.includes("--ci") || !!process.env.CI,
  root = project,
): Promise<{ code: number; text: string }> {
  let report = await check(root);
  if (report.errors.length) return { code: 1, text: report.errors.join("\n") + "\n" };
  if (ci)
    return {
      code: report.problems.length ? 1 : 0,
      text: report.problems.map(problem => problem.error + "\n").join(""),
    };
  const color = process.stderr.isTTY && !process.env.NO_COLOR;
  let text = "";
  if (report.problems.some(problem => problem.kind === "stale")) {
    report = await generate(root);
    if (report.errors.length) return { code: 1, text: report.errors.join("\n") + "\n" };
    text = (color ? "\x1b[2mUpdated the generated translations\x1b[0m" : "Updated the generated translations") + "\n";
  }
  return { code: 0, text: text + (report.problems.length ? summary(report, color) : "") };
}

if (import.meta.main) {
  const command = process.argv[2] ?? "check",
    rootIndex = process.argv.indexOf("--root"),
    root = rootIndex < 0 ? project : resolve(process.argv[rootIndex + 1]);
  let report: Report;
  switch (command) {
    case "check":
      report = await check(root);
      break;
    case "generate":
      report = await generate(root);
      break;
    case "extract":
      report = await extract(root);
      break;
    default:
      console.error("Usage: bun run i18n [check|generate|extract] [--root DIR]");
      process.exit(2);
  }
  for (const error of report.errors) console.error(error);
  if (report.errors.length) process.exit(1);
  if (command === "extract") console.log(`Extracted ${report.messages} messages into locales/{zh,ja,ko,ru}.json`);
  else if (command === "generate") {
    console.log(`Generated ${report.messages} messages in ${locale.translated.length} languages`);
    if (report.problems.length) console.error(summary(report, process.stderr.isTTY && !process.env.NO_COLOR));
  } else {
    for (const problem of report.problems) console.error(problem.error);
    if (report.problems.length) process.exit(1);
    console.log(`Checked ${report.messages} messages in ${locale.translated.length} languages`);
  }
}
