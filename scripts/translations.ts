//! Extract ordinary template tags, validate catalogs, and compile JS and shell messages.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import * as tooling from "./tooling";
import * as locale from "../src/locale";

const command = process.argv[2] ?? "check";
const rootIndex = process.argv.indexOf("--root");
const root = rootIndex < 0 ? resolve(import.meta.dir, "..") : resolve(process.argv[rootIndex + 1]);
const [compiler] = await tooling.packages("translations", { typescript: "6.0.3" });
const ts = await import(join(compiler, "lib/typescript.js"));
type Message = { source: string; parts: string[]; names: string[]; locations: string[]; shell: boolean; js: boolean };
type Plural = { plural: string; forms: Partial<Record<Intl.LDMLPluralRule, string>> };
type Translation = string | Plural;
type Catalog = Record<string, Translation>;
const messages = new Map<string, Message>();
const shapes = new Map<string, string>();
const errors: string[] = [];
// Catalog problems by kind and English source, so --summary can count them.
type Problem = "missing" | "unused" | "invalid" | "stale";
const problems = new Map<Problem, Set<string>>();
const summary = process.argv.includes("--summary");
function problem(kind: Problem, source: string, error: string): void {
  if (!problems.has(kind)) problems.set(kind, new Set());
  problems.get(kind)!.add(source);
  errors.push(error);
}

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
for (const path of [...new Bun.Glob("src/**/*.ts").scanSync(root)].sort()) {
  if (/\.(?:test|generated|d)\.ts$/.test(path)) continue;
  const source = ts.createSourceFile(path, readFileSync(join(root, path), "utf8"), ts.ScriptTarget.Latest, true);
  const namespaces = new Set<string>(),
    tags = new Set<string>(),
    documents = new Map<string, string>();
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      statement.moduleSpecifier.text.endsWith(".txt") &&
      statement.importClause?.name
    )
      documents.set(
        statement.importClause.name.text,
        resolve(dirname(join(root, path)), statement.moduleSpecifier.text),
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
      const method = node.expression.name.text;
      const display =
        (path === "src/controller.ts" && method === "notice") ||
        (path === "src/shortcut_help.ts" &&
          ["heading", "group", "binding", "action", "featured", "alsoHeld", "pair"].includes(method));
      const argument = node.arguments[0];
      if (
        display &&
        argument &&
        (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) &&
        /[A-Za-z]{2}/.test(argument.text)
      )
        errors.push(
          `${path}:${source.getLineAndCharacterOfPosition(argument.getStart(source)).line + 1}: unmarked UI text; use i18n.t`,
        );
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      namespaces.has(node.expression.expression.text) &&
      node.expression.name.text === "document"
    ) {
      const imported = node.arguments[0];
      const document = imported && ts.isIdentifier(imported) ? documents.get(imported.text) : undefined;
      if (!document) errors.push(`${path}: i18n.document requires an imported text asset`);
      else add([readFileSync(document, "utf8")], [], path + " (" + document.slice(root.length + 1) + ")");
    }
    if (ts.isTaggedTemplateExpression(node)) {
      const tag = node.tag;
      const marked = ts.isIdentifier(tag)
        ? tags.has(tag.text)
        : ts.isPropertyAccessExpression(tag) && namespaces.has(tag.expression.text) && tag.name.text === "t";
      if (marked) {
        const location = `${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
        const template = node.template;
        if (ts.isNoSubstitutionTemplateLiteral(template)) add([template.text], [], location);
        else {
          const parts = [template.head.text],
            names: string[] = [];
          for (const span of template.templateSpans) {
            if (!ts.isIdentifier(span.expression))
              errors.push(`${location}: use a named local for ${span.expression.getText(source)}`);
            names.push(span.expression.getText(source));
            parts.push(span.literal.text);
          }
          add(parts, names, location);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
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
function count(kind: Problem, one: string, many: string): string[] {
  const size = problems.get(kind)?.size ?? 0;
  return size ? [`${size} ${size === 1 ? one : many}`] : [];
}
function fail(): void {
  if (!errors.length) return;
  // Source errors come before any catalog problem and are always listed.
  if (summary && problems.size) {
    const found = [
      ...count("missing", "message needs translating", "messages need translating"),
      ...count("unused", "unused translation", "unused translations"),
      ...count("invalid", "malformed translation", "malformed translations"),
      ...(problems.has("stale") ? ["generated files are stale"] : []),
    ];
    console.log(
      ["Translations incomplete:", ...found.map(line => `  • ${line}`)].join("\n") +
        "\nFix these with bun run i18n. See locales/README.md for further info.",
    );
  } else for (const error of errors) console.error(error);
  process.exit(1);
}
fail();
const catalogs = {} as Record<locale.TranslatedLocale, Catalog>;
function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}
for (const language of locale.translated) {
  const path = join(root, "locales", `${language}.json`);
  let value: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(`${path}: expected a message object`);
  const catalog = value as Catalog;
  if (command === "extract") {
    const next = Object.fromEntries(ordered.map(message => [message.source, catalog[message.source] ?? ""]));
    write(path, JSON.stringify(next, null, 2) + "\n");
    catalogs[language] = next;
    continue;
  }
  catalogs[language] = catalog;
  for (const key of Object.keys(catalog))
    if (!messages.has(key)) problem("unused", key, `${path}: unused translation ${JSON.stringify(key)}`);
  for (const message of ordered) {
    const entry = catalog[message.source];
    if (entry === undefined) {
      problem(
        "missing",
        message.source,
        `${path}: missing ${JSON.stringify(message.source)} (${message.locations[0]})`,
      );
      continue;
    }
    const validate = (translated: unknown, category = "") => {
      if (typeof translated !== "string" || !translated.trim()) {
        problem("missing", message.source, `${path}: untranslated ${JSON.stringify(message.source)} ${category}`);
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
        problem(
          "invalid",
          message.source,
          `${path}: placeholder mismatch for ${JSON.stringify(message.source)} ${category}`,
        );
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(translated))
        problem("invalid", message.source, `${path}: control character in ${JSON.stringify(message.source)}`);
    };
    if (typeof entry === "string") validate(entry);
    else if (
      entry &&
      typeof entry === "object" &&
      typeof entry.plural === "string" &&
      entry.forms &&
      typeof entry.forms === "object"
    ) {
      if (!message.names.includes(entry.plural))
        problem("invalid", message.source, `${path}: unknown plural variable ${entry.plural}`);
      if (message.shell) problem("invalid", message.source, `${path}: installer messages cannot use plural variants`);
      const categories = new Intl.PluralRules(language).resolvedOptions().pluralCategories;
      for (const category of categories) validate(entry.forms[category], category);
      for (const [category, form] of Object.entries(entry.forms)) {
        if (!categories.includes(category as Intl.LDMLPluralRule))
          problem("invalid", message.source, `${path}: unused plural category ${category}`);
        validate(form, category);
      }
    } else problem("invalid", message.source, `${path}: invalid translation for ${JSON.stringify(message.source)}`);
  }
}
if (command === "extract") {
  write(join(root, ".tools/i18n/messages.json"), JSON.stringify(ordered, null, 2) + "\n");
  console.log(`Extracted ${ordered.length} messages into locales/{zh,ja,ko,ru}.json`);
  process.exit(0);
}
fail();
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
let generated =
  '// Generated by bun scripts/translations.ts generate. Do not edit.\nimport { plural } from "./locale";\nimport type { TranslatedLocale } from "./locale";\nexport type Value = string | number | bigint;\nexport type Message = (...values: Value[]) => string;\nexport const messages: Record<TranslatedLocale, Record<string, Message>> = {\n';
for (const language of locale.translated) {
  generated += `${JSON.stringify(language)}: {\n`;
  for (const message of ordered.filter(message => message.js)) {
    const entry = catalogs[language][message.source],
      args = message.names.map((_, i) => `v${i}`).join(", ");
    generated += `${JSON.stringify(JSON.stringify(message.parts))}: (${args}) => `;
    if (typeof entry === "string") generated += template(entry, message.names) + ",\n";
    else {
      generated += `{ switch (plural(${JSON.stringify(language)}, Number(v${message.names.indexOf(entry.plural)}))) {\n`;
      for (const [category, form] of Object.entries(entry.forms))
        generated += `case ${JSON.stringify(category)}: return ${template(form!, message.names)};\n`;
      generated += `default: return ${template(entry.forms.other!, message.names)};\n} },\n`;
    }
  }
  generated += "},\n";
}
generated += "};\n";
const [prettierPath] = await tooling.packages("format", { prettier: "3.9.9" });
const prettier = await import(join(prettierPath, "index.mjs"));
generated = await prettier.format(generated, {
  ...(await prettier.resolveConfig(join(root, "src/i18n.generated.ts"))),
  parser: "typescript",
});
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
const resolverPath = join(root, "scripts/locale.sh");
let shell =
  "# Generated by bun scripts/translations.ts generate. Do not edit.\n" +
  readFileSync(resolverPath, "utf8") +
  '\nmsg() {\n  i18n_source=$1; shift\n  case "${i18n_language:-en}:$i18n_source" in\n';
for (const message of ordered.filter(message => message.shell)) {
  for (const language of ["en", ...locale.translated]) {
    const value =
      language === "en" ? message.source : (catalogs[language as locale.TranslatedLocale][message.source] as string);
    shell += `    ${quote(language + ":" + message.source)}) ${shellPrint(value, message.names)};;\n`;
  }
}
shell += '    *) printf "%s" "$i18n_source";;\n  esac\n}\n';
for (const [relative, contents] of [
  ["src/i18n.generated.ts", generated],
  ["scripts/install_i18n.generated.sh", shell],
]) {
  const path = join(root, relative);
  if (command === "generate") write(path, contents);
  else if (command === "check") {
    if (!existsSync(path) || readFileSync(path, "utf8") !== contents)
      problem("stale", relative, `${relative}: stale generated translations; run bun scripts/translations.ts generate`);
  } else throw Error("Usage: bun scripts/translations.ts extract|generate|check [--root DIR]");
}
fail();
console.log(
  `${command === "check" ? "Checked" : "Generated"} ${ordered.length} messages in ${locale.translated.length} languages`,
);
