//! What a launcher command says about the agent it starts, for the command
//! lines Claude Code and Codex share the shape of: environment overrides,
//! `--model`, a permission-skipping flag, profiles and settings files.
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandLine, Inspection, Kept } from "./adapter";
export type Vocabulary = {
  /** The variable that moves its settings directory. */
  config_env: string;
  /** Where its cached account sits under a HOME the command sets. */
  account_home: string;
  model_env?: string;
  yolo: string;
  profile_flags: string[];
  settings_flags: string[];
  credential_env: string[];
  oauth_env?: string;
  /** Variables that point it at another endpoint, or switch its provider on. */
  endpoint_env: string[];
  provider_env: string[];
  /** The account cached in a settings directory, as the launcher shows it. */
  account(root: string): string | null;
};
export function inspect(c: CommandLine, v: Vocabulary): Inspection {
  const out: Inspection = { permissions: "default", model: "", account: "", default_account: !c.flagged };
  let credential = false,
    settings = c.flagged,
    config = "",
    home = "";
  for (const [key, value] of c.env) {
    if (key === "HOME") {
      home = value;
      out.default_account = false;
    } else if (key === v.config_env) {
      config = value;
      out.default_account = false;
    } else if (value && v.credential_env.includes(key)) {
      out.default_account = false;
      credential = true;
      out.account = "API key - identity unavailable";
    } else if (value && key === v.oauth_env) {
      out.default_account = false;
      credential = true;
      out.account = "Explicit OAuth token - identity unknown";
    } else if (
      value &&
      (v.endpoint_env.includes(key) || (v.provider_env.includes(key) && /^(1|true|yes|on)$/i.test(value.trim())))
    ) {
      out.default_account = false;
      settings = true;
      out.account = "External endpoint/provider - identity unknown";
    } else if (key === v.model_env) out.model = value;
  }
  let model = false,
    profile = false;
  for (const w of c.args) {
    if (model) {
      out.model = w;
      model = false;
      continue;
    }
    if (profile) {
      out.account = "Profile selected; identity unknown";
      profile = false;
      continue;
    }
    if (w === "--model" || w === "-m") model = true;
    if (w.startsWith("--model=")) out.model = w.slice(8);
    if (w === v.yolo) out.permissions = "bypass";
    const profiled = v.profile_flags.some(f => w === f || w.startsWith(f + "=")),
      set = v.settings_flags.some(f => w === f || w.startsWith(f + "="));
    if (profiled || set) {
      settings = true;
      out.default_account = false;
    }
    if (v.profile_flags.includes(w)) profile = true;
    if ((profiled && w.includes("=")) || set) out.account = "Custom settings - identity unknown";
  }
  if (!out.default_account && !credential && !settings) {
    out.account = "Custom profile - identity unknown";
    const root =
      config && !/[$~`]/.test(config)
        ? resolve(c.cwd, config)
        : home && !/[$~`]/.test(home)
          ? resolve(c.cwd, home, v.account_home)
          : null;
    if (root) out.account = v.account(root) ?? out.account;
  }
  return out;
}
/** What a provider keeps of a typed command line on a resume or fork. */
export type Keeping = {
  /** Options it drops along with their values: the session, the prompt, the
   * model and the permission checks the agent reports itself. */
  drop: string[];
  /** Options that take no value. */
  flags: string[];
  /** Variables that choose its account, endpoint or features. */
  env: RegExp;
};
/** The options of a typed command line, with their values, and the
 * variables it set apart from Corgi's own. Words that aren't options, such
 * as a prompt or a subcommand and its session, go. */
export function keep(c: CommandLine, k: Keeping): Kept {
  const args: string[] = [];
  for (let i = 1; i < c.args.length; i++) {
    const w = c.args[i];
    if (w === "--") break;
    if (!w.startsWith("-") || w === "-") continue;
    const name = w.split("=")[0],
      next = c.args[i + 1],
      value = !w.includes("=") && !k.flags.includes(name) && next !== undefined && !next.startsWith("-");
    if (value) i++;
    if (!k.drop.includes(name)) args.push(w, ...(value ? [next] : []));
  }
  return { args, env: c.env.filter(([key, value]) => k.env.test(key) && value !== process.env[key]) };
}
/** A JSON file in `root` no bigger than `limit`, or null. */
export function cached(root: string, name: string, limit = 65536): any {
  try {
    const file = resolve(root, name);
    return statSync(file).size <= limit ? JSON.parse(readFileSync(file, "utf8")) : null;
  } catch {
    return null;
  }
}
/** An explicit picker choice wins over model flags in an entry's extra arguments. */
export function withoutModel(args: string[], qualified = false): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i],
      name = word.split("=")[0];
    if (word === "--") return [...out, ...args.slice(i)];
    if (name === "--model" || name === "-m" || (qualified && name === "--provider")) {
      if (!word.includes("=") && args[i + 1] !== undefined) i++;
    } else out.push(word);
  }
  return out;
}
