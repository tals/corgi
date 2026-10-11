//! Where the launcher puts a new worktree: a folder template such as the
//! default `$PROJECT_ROOT/.worktrees/$NAME`, which Corgi setup edits. A
//! relative folder is relative to the project root.
import { basename, isAbsolute, join, normalize } from "node:path";
import { homedir } from "node:os";

export const default_template = "$PROJECT_ROOT/.worktrees/$NAME";
export const variables = ["PROJECT_ROOT", "PROJECT_NAME", "NAME", "HOME"] as const;
export type Variable = (typeof variables)[number];
/** Names people reach for, and the variable each means. */
const synonyms: Record<string, Variable> = {
  ROOT: "PROJECT_ROOT",
  REPO: "PROJECT_ROOT",
  REPO_ROOT: "PROJECT_ROOT",
  PROJECT_DIR: "PROJECT_ROOT",
  REPO_NAME: "PROJECT_NAME",
  BRANCH: "NAME",
  WORKTREE: "NAME",
};
type Part = { text: string } | { variable: Variable };

/** The template's parts, or why it doesn't parse. Variables are `$NAME` or `${NAME}`. */
export function parse(template: string): Part[] | string {
  const parts: Part[] = [];
  let literal = "";
  for (let i = 0; i < template.length;) {
    if (template[i] !== "$") {
      literal += template[i++];
      continue;
    }
    let name: string, end: number;
    if (template[i + 1] === "{") {
      const close = template.indexOf("}", i + 2);
      if (close < 0) return "A ${ needs its closing }";
      name = template.slice(i + 2, close);
      end = close + 1;
    } else {
      name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(template.slice(i + 1))?.[0] ?? "";
      end = i + 1 + name.length;
    }
    if (name.length === 0) return "A $ needs a variable after it, such as $NAME";
    const variable = variables.find(v => v === name);
    if (!variable) return unknown(name);
    if (literal) parts.push({ text: literal });
    literal = "";
    parts.push({ variable });
    i = end;
  }
  if (literal) parts.push({ text: literal });
  return parts;
}
function unknown(name: string): string {
  const upper = name.toUpperCase();
  const meant = variables.find(v => v === upper) ?? synonyms[upper];
  if (meant === upper) return `Variables are uppercase: $${meant}, not $${name}`;
  if (meant) return `$${name} isn't a variable; did you mean $${meant}?`;
  const near = variables.filter(v => v.startsWith(upper) || upper.startsWith(v));
  if (near.length > 0) return `$${name} isn't a variable; did you mean ${near.map(v => `$${v}`).join(" or ")}?`;
  return `$${name} isn't a variable`;
}
/** Why the template can't place worktrees, or null. */
export function problem(template: string): string | null {
  if (template.trim().length === 0) return `Type a folder, such as ${default_template}`;
  const parts = parse(template);
  if (typeof parts === "string") return parts;
  if (!parts.some(p => "variable" in p && p.variable === "NAME"))
    return "Add $NAME, so each worktree gets a folder of its own";
  return null;
}
/** The template cut into literal text, known variables and bad uses of
 * `$`, as setup colors them while it's typed. */
export function tokens(template: string): { text: string; kind: "text" | "variable" | "bad" }[] {
  const out: { text: string; kind: "text" | "variable" | "bad" }[] = [];
  for (let i = 0; i < template.length;) {
    if (template[i] !== "$") {
      const last = out[out.length - 1];
      if (last?.kind === "text") last.text += template[i];
      else out.push({ text: template[i], kind: "text" });
      i += 1;
      continue;
    }
    let name = "",
      end: number;
    if (template[i + 1] === "{") {
      const close = template.indexOf("}", i + 2);
      end = close < 0 ? template.length : close + 1;
      if (close >= 0) name = template.slice(i + 2, close);
    } else {
      name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(template.slice(i + 1))?.[0] ?? "";
      end = i + 1 + name.length;
    }
    out.push({ text: template.slice(i, end), kind: variables.some(v => v === name) ? "variable" : "bad" });
    i = end;
  }
  return out;
}
/** The template with a leading `./` spelled as the project root it means,
 * and where `cursor` (in characters) lands; null when there is none. */
export function completeRoot(template: string, cursor: number): { template: string; cursor: number } | null {
  if (!template.startsWith("./")) return null;
  const root = "$PROJECT_ROOT/";
  return { template: root + template.slice(2), cursor: cursor >= 2 ? cursor + root.length - 2 : cursor };
}
/** What each variable stands for, for branch `branch` of the project whose main checkout is `root`. */
export function values(root: string, branch: string, home = homedir()): Record<Variable, string> {
  return { PROJECT_ROOT: root, PROJECT_NAME: basename(root), NAME: branch.replaceAll("/", "-"), HOME: home };
}
/** The folder `template` names for branch `branch` of the project whose
 * main checkout is `root`; the default's when the template has a problem. */
export function expand(template: string, root: string, branch: string, home = homedir()): string {
  const parts = problem(template) === null ? parse(template) : parse(default_template);
  const by = values(root, branch, home);
  let path = (parts as Part[]).map(p => ("variable" in p ? by[p.variable] : p.text)).join("");
  if (path === "~" || path.startsWith("~/")) path = home + path.slice(1);
  else if (!isAbsolute(path)) path = join(root, path);
  const clean = normalize(path);
  return clean.length > 1 ? clean.replace(/\/+$/, "") : clean;
}
