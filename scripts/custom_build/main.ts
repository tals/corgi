import * as configFile from "./config";
import * as git from "./git";
import * as github from "./github";
import * as run from "./run";
import * as sources from "./sources";

const usage = `usage: scripts/custom-build [--dir <path>] <command> [args]

commands:
  add <source> [--description <text>]   add a patch (branch, #123, owner/repo#12, owner/repo:branch)
  remove <source> [--reason <text>]     retire a patch
  list [--retired]                      show the patch list
  rebuild [--push]                      rebuild the custom branch and dist/corgi-custom
  continue                              resume a stopped run
  rollback                              return to the last successful build
  status                                show a stopped run and which patches need a rebase

See docs/custom-builds.md.`;

export type IO = {
  cwd: string;
  env: Record<string, string | undefined>;
  out: (text: string) => void;
  err: (text: string) => void;
  now?: () => Date;
  /** Asks for a line on a terminal; null when there is none. */
  ask?: (question: string) => string | null;
};
class Usage extends Error {}

/** `--name value` or `--name=value` from `args`, removing it; null when absent. */
function option(args: string[], name: string): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}`) {
      const value = args[i + 1];
      if (value === undefined) throw new Usage(`--${name} needs a value`);
      args.splice(i, 2);
      return value;
    }
    if (args[i].startsWith(`--${name}=`)) {
      const value = args[i].slice(name.length + 3);
      args.splice(i, 1);
      return value;
    }
  }
  return null;
}
function flag(args: string[], name: string): boolean {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}
function noMore(args: string[]) {
  if (args.length) throw new Usage(`unexpected ${args.join(" ")}`);
}

/** Runs one command; the exit codes are listed in docs/custom-builds.md. */
export async function main(argv: string[], io: IO): Promise<number> {
  const args = [...argv];
  let dirOption: string | null = null;
  while (args[0] === "--dir" || args[0]?.startsWith("--dir=")) {
    if (args[0] === "--dir") {
      if (args[1] === undefined) return usageError(io, "--dir needs a value");
      dirOption = args[1];
      args.splice(0, 2);
    } else dirOption = args.shift()!.slice("--dir=".length);
  }
  const command = args.shift();
  if (!command || command === "help" || command === "--help" || command === "-h") {
    (command ? io.out : io.err)(usage + "\n");
    return command ? 0 : 1;
  }
  try {
    const repo = io.env.CORGI_CUSTOM_BUILD_REPO || git.repoRoot(io.cwd),
      dir = configFile.resolveDir({ dir: dirOption, env: io.env, repoRoot: repo, cwd: io.cwd }),
      ctx: run.Context = {
        repo,
        dir,
        config: configFile.load(dir),
        env: io.env,
        tool: import.meta.dir,
        now: io.now ?? (() => new Date()),
        progress: line => io.err(`custom-build: ${line}\n`),
        echo: chunk => io.err(new TextDecoder().decode(chunk)),
      };
    let outcome: run.Outcome;
    switch (command) {
      case "rebuild": {
        const push = flag(args, "push");
        noMore(args);
        outcome = await run.rebuild(ctx, { push });
        break;
      }
      case "continue":
        noMore(args);
        outcome = await run.resume(ctx);
        break;
      case "rollback":
        noMore(args);
        outcome = await run.rollback(ctx);
        break;
      case "status":
        noMore(args);
        outcome = await run.status(ctx);
        break;
      case "add":
        outcome = add(ctx, args);
        break;
      case "remove":
        outcome = remove(ctx, args, io);
        break;
      case "list": {
        const retired = flag(args, "retired");
        noMore(args);
        outcome = list(ctx.config, retired);
        break;
      }
      default:
        throw new Usage(`unknown command ${command}`);
    }
    if (outcome.lines.length) io.out(outcome.lines.join("\n") + "\n");
    return outcome.code;
  } catch (error) {
    if (error instanceof Usage) return usageError(io, error.message);
    io.err(`custom-build: ${(error as Error).message}\n`);
    return 1;
  }
}
const today = (ctx: run.Context) => ctx.now().toISOString().slice(0, 10);
function named(ctx: run.Context, args: string[]): { source: sources.PatchSource; display: string } {
  const arg = args.shift();
  if (!arg) throw new Usage("name the patch source");
  const source = sources.parse(arg, ctx.config.upstream.repo);
  const problem = source.kind === "fork-branch" && source.url ? sources.urlProblem(source.url) : null;
  if (problem) throw Error(problem);
  if (source.kind === "branch" && !git.validBranchName(ctx.repo, source.name))
    throw Error(`${arg} is neither a PR, another repository's branch nor a valid branch name`);
  return { source, display: sources.display(source) };
}

/** Appends a patch; a PR without `--description` takes its title. */
function add(ctx: run.Context, args: string[]): run.Outcome {
  let description = option(args, "description");
  const { source, display } = named(ctx, args);
  noMore(args);
  if (ctx.config.patches.some(p => sources.display(p.source) === display))
    throw Error(`${display} is already in the list`);
  if (!description && source.kind === "pr") {
    const info = github.prInfo(source.repo, source.number, ctx.env);
    if (info?.title) description = github.stripArea(info.title);
  }
  description = description?.replace(/\s+/g, " ").trim() ?? "";
  if (!description) throw Error(`${display} needs --description (no PR title to take it from)`);
  ctx.config.patches.push({ source, description, added: today(ctx) });
  configFile.save(ctx.dir, ctx.config);
  run.exclude(ctx);
  return { code: 0, lines: [`added ${display}: ${description}`] };
}

/** Moves a patch to the retired list with today's date and a reason. */
function remove(ctx: run.Context, args: string[], io: IO): run.Outcome {
  let reason = option(args, "reason");
  const { display } = named(ctx, args);
  noMore(args);
  const index = ctx.config.patches.findIndex(p => sources.display(p.source) === display);
  if (index < 0) throw Error(`${display} is not in the list`);
  if (!reason) reason = io.ask?.(`Why is ${display} retired? `)?.trim() ?? null;
  if (!reason) throw Error(`removing ${display} needs --reason`);
  const [patch] = ctx.config.patches.splice(index, 1);
  ctx.config.retired.push({ ...patch, retired: today(ctx), reason });
  configFile.save(ctx.dir, ctx.config);
  return { code: 0, lines: [`retired ${display}: ${reason}`] };
}

function list(config: configFile.Config, retired: boolean): run.Outcome {
  const rows = retired
    ? config.retired.map(p => `${sources.display(p.source)}  ${p.description}  (retired ${p.retired}: ${p.reason})`)
    : config.patches.map(p => `${sources.display(p.source)}  ${p.description}  (added ${p.added})`);
  return { code: 0, lines: rows.length ? rows : [retired ? "no retired patches" : "no patches"] };
}

function usageError(io: IO, message: string): number {
  io.err(`custom-build: ${message}\n${usage}\n`);
  return 1;
}

if (import.meta.main)
  process.exitCode = await main(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    out: text => process.stdout.write(text),
    err: text => process.stderr.write(text),
    ask: question => (process.stdin.isTTY ? prompt(question) : null),
  });
