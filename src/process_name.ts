//! What an untitled tab calls the program in front of its pane's shell:
//! tmux's `pane_current_command`, read past interpreters to their script,
//! and the brand whose mark its tab wears.
import path from "node:path";

export const brands = [
  "node",
  "bun",
  "python",
  "ruby",
  "php",
  "hack",
  "perl",
  "r",
  "vim",
  "neovim",
  "git",
  "docker",
  "kubernetes",
  "postgresql",
  "redis",
  "rust",
  "go",
  "zig",
  "homebrew",
  "cmake",
  "claude",
  "openai",
  "tmux",
  "omp",
] as const;
export type Brand = (typeof brands)[number];
export function brand(value: unknown): Brand | null {
  return brands.includes(value as Brand) ? (value as Brand) : null;
}
/** The brand of each program, by the name it runs as, version aside. */
const programs: Record<string, Brand> = {
  node: "node",
  nodejs: "node",
  bun: "bun",
  bunx: "bun",
  python: "python",
  pypy: "python",
  ruby: "ruby",
  php: "php",
  hhvm: "hack",
  hh_client: "hack",
  hh_server: "hack",
  perl: "perl",
  r: "r",
  npm: "node",
  npx: "node",
  pnpm: "node",
  pnpx: "node",
  yarn: "node",
  vi: "vim",
  vim: "vim",
  vimdiff: "vim",
  nvim: "neovim",
  git: "git",
  tig: "git",
  lazygit: "git",
  docker: "docker",
  lazydocker: "docker",
  kubectl: "kubernetes",
  k9s: "kubernetes",
  psql: "postgresql",
  postgres: "postgresql",
  pgcli: "postgresql",
  "redis-cli": "redis",
  "redis-server": "redis",
  cargo: "rust",
  rustc: "rust",
  rustup: "rust",
  go: "go",
  zig: "zig",
  brew: "homebrew",
  cmake: "cmake",
  ccmake: "cmake",
  ctest: "cmake",
  cpack: "cmake",
  claude: "claude",
  codex: "openai",
  omp: "omp",
  uv: "python",
  uvx: "python",
  tmux: "tmux",
};
/** The brand a program or provider called `name` wears, if it has one. */
export function brandOf(name: string): Brand | null {
  const key = name.toLowerCase();
  return programs[key] ?? programs[key.replace(/-?[\d.]+$/, "")] ?? null;
}

/** How an interpreter's command line says what it runs. */
type Interpreter = {
  /** Flags that run code from the command line, which no script names. */
  inline: string[];
  /** Flags whose value is the next argument. */
  valued: string[];
  /** Flags and subcommands whose next argument is what runs: a module, a
   * package script, or a script by path. */
  runs: string[];
};
const shell: Interpreter = { inline: ["-c"], valued: ["-o", "-O"], runs: [] };
const javascript: Interpreter = {
  inline: ["-e", "-p", "--eval", "--print"],
  valued: ["-r", "--require", "--preload", "--import", "--loader", "--cwd", "--filter", "-F"],
  runs: ["run", "--run"],
};
const python: Interpreter = { inline: ["-c"], valued: ["-W", "-X"], runs: ["-m"] };
/** Each interpreter by the name it runs as, version aside. */
const interpreters: Record<string, Interpreter> = {
  ...Object.fromEntries(["sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "nu"].map(s => [s, shell])),
  node: javascript,
  nodejs: javascript,
  bun: javascript,
  python,
  pypy: python,
  ruby: { inline: ["-e"], valued: ["-I", "-r"], runs: [] },
  perl: { inline: ["-e", "-E"], valued: [], runs: [] },
  php: { inline: ["-r"], valued: ["-c", "-d"], runs: [] },
  lua: { inline: ["-e"], valued: ["-l"], runs: [] },
};
const script = /\.(?:[cm]?[jt]sx?|py|rb|pl|php|lua|sh|bash|zsh|fish)$/;

export type Program = { name: string; brand: Brand | null };
/** The program `argv` runs, named as tmux names a window: no login shell's
 * dash or folder, and a title written over argv only to its first space.
 * Past an interpreter it is the script, module or package script, and wears
 * the interpreter's brand; a program installed on PATH, like npm, wears its
 * own. A shell at its prompt is "", and its tab shows its folder instead. */
export function program(argv: string[]): Program {
  const exe = word(argv[0] ?? ""),
    own = { name: exe, brand: brandOf(exe) },
    interpreter = interpreters[exe.toLowerCase().replace(/[\d.]+$/, "")];
  if (!interpreter) return own;
  let runs = false,
    i = 1;
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (interpreter.runs.includes(arg)) runs = true;
    else if (arg === "--") {
      i++;
      break;
    } else if (!arg.startsWith("-")) break;
    else if (interpreter.inline.includes(arg)) return own;
    else if (interpreter.valued.includes(arg)) i++;
  }
  // A shell's first argument is its script; others' might be a subcommand.
  const target = argv[i] ?? "";
  if (!target || !(runs || interpreter === shell || target.includes("/") || script.test(target)))
    return interpreter === shell ? { ...own, name: "" } : own;
  const name = path.basename(target).replace(script, "");
  // Found on PATH, an installed program reaches its interpreter by full path.
  return { name, brand: (path.isAbsolute(target) && brandOf(name)) || own.brand };
}

function word(arg0: string): string {
  const program = arg0.replace(/^[ -]+/, "");
  // A path may have spaces; a title ends at one.
  return path.basename(program.startsWith("/") ? program : program.split(" ")[0]).replace(/:$/, "");
}
