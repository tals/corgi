//! Extra launch arguments and literal environment overrides for an agent account.
import * as i18n from "./i18n";
import * as effort from "./providers/effort";
import { Tokens, max_length } from "./launch/tokens";
import { byteLength } from "./text";

export type Options = { flags: string; env: [string, string][]; model?: string; effort?: effort.Effort };
export const empty = (): Options => ({ flags: "", env: [] });
export const max_variables = 64;

/** Shell-style words, never shell evaluation. Reject incomplete or compound commands. */
export function args(flags: string): string[] {
  if (byteLength(flags) > max_length || /[\x00-\x1f\x7f-\x9f]/.test(flags)) throw Error("InvalidAgentFlags");
  const tokens = new Tokens(flags),
    result: string[] = [];
  while (flags.slice(tokens.pos).trim()) {
    const word = tokens.next();
    if (word === null) throw Error("InvalidAgentFlags");
    result.push(word);
  }
  return result;
}

export function problem(options: Options): string | null {
  if (options.effort !== undefined && !effort.parse(options.effort)) return i18n.t`Choose a valid effort.`;
  if (options.model && (!/^[^\s\x00-\x1f\x7f]+$/.test(options.model) || byteLength(options.model) > 512))
    return i18n.t`Choose a valid model ID.`;
  try {
    args(options.flags);
  } catch {
    return i18n.t`Check flag quotes; shell operators and expansions aren't supported.`;
  }
  if (options.env.length > max_variables) return i18n.t`Use at most ${max_variables} environment variables.`;
  const names = new Set<string>();
  for (const [key, value] of options.env) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      return i18n.t`Variable names use letters, digits and underscores; not a leading digit.`;
    if (names.has(key)) return i18n.t`Duplicate variable: ${key}`;
    if (byteLength(key) > max_length || byteLength(value) > max_length || /[\x00-\x1f\x7f-\x9f]/.test(value))
      return i18n.t`Variable values must be single-line text, up to 2048 bytes.`;
    names.add(key);
  }
  return null;
}

/** Normalize accounts.json at its boundary; malformed settings don't become launch input. */
export function read(value: unknown): Options | null {
  if (typeof value !== "object" || value === null || !("flags" in value) || !("env" in value)) return null;
  if (typeof value.flags !== "string" || !Array.isArray(value.env)) return null;
  const env: [string, string][] = [];
  for (const pair of value.env) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string")
      return null;
    env.push([pair[0], pair[1]]);
  }
  if ("model" in value && typeof value.model !== "string") return null;
  if ("effort" in value && !effort.parse(value.effort)) return null;
  const options: Options = {
    ...("effort" in value ? { effort: effort.parse(value.effort)! } : {}),
    flags: value.flags,
    env,
    ...("model" in value && value.model ? { model: value.model as string } : {}),
  };
  return problem(options) === null ? options : null;
}
