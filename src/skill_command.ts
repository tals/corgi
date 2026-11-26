import { YAML } from "bun";
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import corgiSkill from "../assets/corgi-skill.md" with { type: "text" };
import recallSkill from "../assets/corgi-recall-skill.md" with { type: "text" };
import { Provider, adapter } from "./providers";
import { atomicWrite } from "./os";
import * as accounts from "./accounts";
import * as errors from "./errors";
import * as i18n from "./i18n";

/** A skill Corgi bundles, as the CLI names it. */
export type Skill = "corgi" | "recall";
const texts: Record<Skill, string> = { corgi: corgiSkill, recall: recallSkill };
export const skills = Object.keys(texts) as Skill[];
/** Skills a bare `corgi skill status` lists where they aren't installed. The
 * Corgi guide is already in the Corgi prompt, so it shows only once installed. */
const offered: Record<Skill, boolean> = { corgi: false, recall: true };
export function parse(name: unknown): Skill | null {
  return skills.find(s => s === name) ?? null;
}
/** The bundled file, verbatim. */
export function text(skill: Skill): string {
  return texts[skill];
}
/** A skill file's front matter `name` and `description`; null when it has none. */
export function frontMatter(text: string): { name: string; description: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!match) return null;
  try {
    const raw = YAML.parse(match[1]!) as { name?: unknown; description?: unknown } | null;
    if (typeof raw?.name !== "string") return null;
    return { name: raw.name, description: typeof raw.description === "string" ? raw.description : "" };
  } catch {
    return null;
  }
}
/** The folder name a skill installs under: its front matter `name`. */
export function folderName(skill: Skill): string {
  return frontMatter(texts[skill])!.name;
}

/** Providers whose accounts keep a `skills` folder. */
export function providers(): Provider[] {
  return Provider.all.filter(p => adapter(p).accounts.shared.dirs.includes("skills"));
}
/** One account's skill folder. `present` is false when the account's home
 * doesn't exist, which Corgi never creates. */
export type Folder = { provider: Provider; account: string; root: string; path: string; present: boolean };
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
}
/** Every skill folder, the default account's first; folders that resolve
 * to one already listed, as linked accounts' do, are left out. */
export function folders(only: Provider | null = null, named: string | null = null): Folder[] {
  const chosen = named === null ? null : named === "default" ? "" : accounts.named(named, only)?.dir;
  if (chosen === undefined) throw Error("UnknownAccount");
  const seen = new Set<string>(),
    out: Folder[] = [];
  for (const provider of providers()) {
    if (only && provider !== only) continue;
    const roots = [
      { account: "", root: adapter(provider).accounts.home() },
      ...accounts
        .known()
        .filter(a => a.provider === provider)
        .map(a => ({ account: a.dir, root: a.dir })),
    ];
    for (const { account, root } of roots) {
      if (chosen !== null && chosen !== account) continue;
      const path = join(root, "skills"),
        present = existsSync(root);
      if (present) {
        const key = real(path);
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push({ provider, account, root, path, present });
    }
  }
  return out;
}

export type State = "absent" | "current" | "outdated" | "foreign" | "skipped";
/** Where `skill` installs in `folder`. */
export function file(skill: Skill, folder: Folder): string {
  return join(folder.path, folderName(skill), "SKILL.md");
}
/** How `skill` stands in `folder`: Corgi's copy is the `SKILL.md` whose
 * front matter names the skill; any other is someone else's. */
export function state(skill: Skill, folder: Folder): State {
  if (!folder.present) return "skipped";
  let found: string;
  try {
    found = readFileSync(file(skill, folder), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "foreign";
  }
  if (found === texts[skill]) return "current";
  return frontMatter(found)?.name === folderName(skill) ? "outdated" : "foreign";
}

type Line = { folder: Folder; skill: Skill; mark: "✓" | "✗" | "·"; text: string; failed?: boolean };
function tilde(path: string): string {
  const home = process.env.HOME ?? "";
  return home && path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}
/** The lines a command prints, aligned as `corgi integration` aligns them. */
function format(lines: Line[]): string[] {
  const label = (f: Folder) =>
      adapter(f.provider).label + (f.account ? " · " + accounts.label(f.provider, f.account) : ""),
    labels = Math.max(...lines.map(l => label(l.folder).length)),
    names = Math.max(...lines.map(l => l.skill.length));
  return lines.map(l => `${l.mark} ${label(l.folder).padEnd(labels)}  ${l.skill.padEnd(names)}  ${l.text}`);
}
function reason(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? errors.name(error) ?? String(error);
}
function install(skill: Skill, folder: Folder): Line {
  const at = tilde(file(skill, folder)),
    line = (mark: Line["mark"], text: string, failed = false): Line => ({ folder, skill, mark, text, failed });
  const found = state(skill, folder);
  switch (found) {
    case "skipped":
      return line("·", `skipped, no ${tilde(folder.root)}`);
    case "current":
      return line("·", `already current in ${at}`);
    case "foreign":
      return line("✗", `conflict: ${at} names another skill`, true);
    case "absent":
    case "outdated":
      try {
        atomicWrite(file(skill, folder), texts[skill], 0o644, false);
      } catch (error) {
        return line("✗", `failed in ${at}: ${reason(error)}`, true);
      }
      return line("✓", found === "absent" ? `written to ${at}` : `refreshed ${at}`);
  }
}
function status(skill: Skill, folder: Folder): Line {
  const at = tilde(file(skill, folder)),
    command = `\`corgi skill install ${skill}\``,
    line = (mark: Line["mark"], text: string): Line => ({ folder, skill, mark, text });
  switch (state(skill, folder)) {
    case "skipped":
      return line("·", `no ${tilde(folder.root)}`);
    case "current":
      return line("✓", `current in ${at}`);
    case "outdated":
      return line("✗", `outdated in ${at}; ${command} refreshes it`);
    case "absent":
      return line("·", `absent from ${tilde(folder.path)}; ${command} adds it`);
    case "foreign":
      return line("✗", `conflict: ${at} names another skill`);
  }
}
function uninstall(skill: Skill, folder: Folder): Line {
  const path = file(skill, folder),
    at = tilde(path),
    line = (mark: Line["mark"], text: string, failed = false): Line => ({ folder, skill, mark, text, failed });
  switch (state(skill, folder)) {
    case "skipped":
      return line("·", `skipped, no ${tilde(folder.root)}`);
    case "absent":
      return line("·", `not in ${tilde(folder.path)}`);
    case "foreign":
      return line("✗", `conflict: ${at} names another skill, left`, true);
    case "current":
    case "outdated":
      try {
        unlinkSync(path);
        const left = readdirSync(dirname(path)).sort();
        if (!left.length) {
          rmdirSync(dirname(path));
          return line("✓", `removed ${tilde(dirname(path))}`);
        }
        return line("✓", `removed ${at}; left ${left.join(", ")}`);
      } catch (error) {
        return line("✗", `failed in ${at}: ${reason(error)}`, true);
      }
  }
}

export const help = `Usage: corgi skill COMMAND [NAME] [${providers().join("|")}] [--account NAME]

  list               bundled skills and what each is for
  show NAME          print a bundled skill
  install NAME       write it into each agent's skill folder
  status             where each skill is installed, current or outdated
  uninstall NAME     remove what install wrote

NAME is corgi or recall. Nothing is installed until you run install.
`;
export function localizedHelp(): string {
  const names = providers().join("|");
  return i18n.t`Usage: corgi skill COMMAND [NAME] [${names}] [--account NAME]

  list               bundled skills and what each is for
  show NAME          print a bundled skill
  install NAME       write it into each agent's skill folder
  status             where each skill is installed, current or outdated
  uninstall NAME     remove what install wrote

NAME is corgi or recall. Nothing is installed until you run install.
`;
}

type Op = "list" | "show" | "install" | "status" | "uninstall";
function op(word: string | undefined): Op | null {
  switch (word) {
    case "list":
    case "show":
    case "install":
    case "status":
    case "uninstall":
      return word;
    default:
      return null;
  }
}
/** `corgi skill …` after the group word, or null when it is a usage error. */
export function request(
  args: string[],
): { op: Op; skill: Skill | null; provider: Provider | null; account: string | null } | null {
  const words = [...args],
    at = words.indexOf("--account"),
    account = at >= 0 ? (words[at + 1] ?? "") : null;
  if (at >= 0) words.splice(at, 2);
  const chosen = op(words[0]);
  if (!chosen || account === "") return null;
  let skill: Skill | null = null,
    provider: Provider | null = null,
    i = 1;
  if (chosen !== "list") {
    skill = parse(words[i]);
    if (skill) i++;
    else if (chosen !== "status") return null;
  }
  if (chosen === "install" || chosen === "status" || chosen === "uninstall") {
    if (i < words.length) {
      provider = Provider.parse(words[i]);
      if (!provider || !providers().includes(provider)) return null;
      i++;
    }
  } else if (account !== null) return null;
  return i === words.length ? { op: chosen, skill, provider, account } : null;
}
/** `corgi skill COMMAND …`: the exit status. Writes skills only for `install`. */
export async function command(args: string[], agent = false): Promise<number> {
  const usage = agent ? help : localizedHelp();
  if (!args.length || args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(usage);
    return 0;
  }
  const r = request(args);
  if (!r) {
    process.stderr.write(usage);
    return 2;
  }
  switch (r.op) {
    case "list": {
      const width = Math.max(...skills.map(s => s.length));
      for (const s of skills) process.stdout.write(`${s.padEnd(width)}  ${frontMatter(texts[s])!.description}\n`);
      return 0;
    }
    case "show":
      process.stdout.write(texts[r.skill!]);
      return 0;
  }
  let found: Folder[];
  try {
    found = folders(r.provider, r.account);
  } catch (error) {
    const name = reason(error);
    process.stderr.write(
      name === "UnknownAccount"
        ? "corgi: no account by that name; `corgi account list` shows them\n"
        : name === "AmbiguousAccount"
          ? "corgi: two providers have an account by that name; say claude/NAME or codex/NAME\n"
          : `corgi: ${name}\n`,
    );
    return 1;
  }
  const lines: Line[] = [];
  for (const folder of found)
    for (const skill of r.skill ? [r.skill] : skills) {
      if (r.op === "status" && !r.skill && !offered[skill] && ["absent", "skipped"].includes(state(skill, folder)))
        continue;
      lines.push(
        r.op === "install"
          ? install(skill, folder)
          : r.op === "status"
            ? status(skill, folder)
            : uninstall(skill, folder),
      );
    }
  for (const text of lines.length ? format(lines) : []) process.stdout.write(text + "\n");
  return lines.some(l => l.failed) ? 1 : 0;
}
