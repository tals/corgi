import * as cli_help from "./cli_help";

export const flags = new Set(["json", "clear", "stdin", "enter", "new-tab", "first", "left", "right", "up", "down"]);
export const options = new Set([
  ...flags,
  "model",
  "effort",
  "flags",
  "env",
  "yolo",
  "from",
  "viewer",
  "pane",
  "owner",
  "workspace",
  "name",
  "command",
  "cwd",
  "before",
  "after",
  "width",
  "height",
  "lines",
  "left-of",
  "right-of",
  "above",
  "below",
]);
const values = new Set([...options].filter(name => !flags.has(name)).concat("account", "dir"));

export type Invocation =
  | { kind: "help"; topic: string[] }
  | { kind: "version" }
  | { kind: "skill" }
  | { kind: "command"; args: string[]; agent: boolean | null };

/** Parse Corgi's global options before any command can have side effects. */
export function parse(words: string[]): Invocation {
  if (words[0]?.startsWith("__")) return { kind: "command", args: words, agent: null };
  let help = false,
    agent: boolean | null = null;
  const args: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === "--" || (args[0] === "agent" && args.length >= 2)) {
      args.push(...words.slice(i));
      break;
    }
    switch (word) {
      case "--help":
      case "-h":
        help = true;
        break;
      case "--agent":
        agent = true;
        break;
      case "--no-agent":
        agent = false;
        break;
      default:
        args.push(word);
        if (word.startsWith("--") && values.has(word.slice(2)) && i + 1 < words.length) args.push(words[++i]);
        break;
    }
  }
  if (args[0] === "help") return { kind: "help", topic: args.slice(1) };
  if (help) return { kind: "help", topic: args.slice(0, args.indexOf("--") === -1 ? args.length : args.indexOf("--")) };
  if (args.length === 1) {
    switch (args[0]) {
      case "--version":
        return { kind: "version" };
      case "--skill":
        return { kind: "skill" };
      case "integration":
      case "headless":
        return { kind: "help", topic: args };
    }
    if (cli_help.nested.has(args[0])) return { kind: "help", topic: args };
  }
  if (
    args[1] === "help" &&
    (cli_help.nested.has(args[0]) || ["account", "integration", "headless", "update"].includes(args[0]))
  )
    return { kind: "help", topic: [args[0], ...args.slice(2)] };
  return { kind: "command", args, agent };
}
