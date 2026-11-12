import * as configFile from "./config";
import * as git from "./git";
import * as github from "./github";
import { Live } from "./live";
import * as liveEvents from "./live_events";
import type { Sink } from "./live_events";
import * as listView from "./list_view";
import { outcomeCard } from "./live_render";
import * as run from "./run";
import * as sources from "./sources";
import { TaskView } from "./task_view";

const usage = `usage: scripts/custom-build [--dir <path>] <command> [args]

commands:
  add <source> [--description <text>]   add a patch (branch, #123, owner/repo#12, owner/repo:branch)
  remove <source> [--reason <text>]     retire a patch
  list [--retired]                      show the patch list
  rebuild [--rebase=<mode>] [--push] [--in-worktree] [--verbose]
                                       rebase own branches, rebuild the custom branch and dist/corgi-custom
  rebase [--rebase=<mode>] [--push] [--in-worktree] [--verbose]
                                       only rebase own branches onto upstream
  rebase --skip-branch [--verbose]      give up the branch a rebase run stopped at
  continue [--verbose]                  resume a stopped run
  rollback [--verbose]                  return to the last successful build
  status                                show a stopped run and which patches need a rebase

<mode> is all (default), conflicting or off. On a terminal, rebuild, rebase and
continue show a live view; --verbose pins it above the full log. rollback shows
its steps, and with --verbose the install's output instead.

See docs/custom-builds.md.`;

export type IO = {
  cwd: string;
  env: Record<string, string | undefined>;
  out: (text: string) => void;
  err: (text: string) => void;
  now?: () => Date;
  /** Asks for a line on a terminal; null when there is none. */
  ask?: (question: string) => string | null;
  /** Whether stdout is a terminal that takes colors and hyperlinks. */
  color?: boolean;
  /** The terminal's width, when stdout is one. */
  columns?: number;
  /** The terminal's height, when stdout is one. */
  rows?: number;
  /** Test hook: receives the live events of `rebuild`, `rebase` and `continue`, drawing nothing. */
  sink?: Sink;
  /** Test hook: draws the live view into `out` at `columns` and `rows`, in this thread. */
  live?: "inline";
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
/** `--rebase=<mode>`, validated; undefined when absent. */
function rebaseMode(args: string[]): configFile.RebaseMode | undefined {
  const value = option(args, "rebase");
  if (value === null) return undefined;
  if (!configFile.rebaseModes.includes(value as configFile.RebaseMode))
    throw new Usage(`--rebase must be one of ${configFile.rebaseModes.join(", ")}`);
  return value as configFile.RebaseMode;
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
  let view: Live | null = null,
    tasks: TaskView | null = null;
  /** Live mode: the `warning:` progress lines, which the card shows. */
  const warnings: string[] = [];
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
        ask: io.ask,
        color: io.color,
        signal: io.sink,
      };
    /** Turns the live view on once the arguments are good: on a terminal, or the test hook. */
    const live = (verbose: boolean): Live | null => {
      if (io.sink || !(io.color || io.live === "inline")) return null;
      const started = Live.start({
        verbose,
        color: !!io.color,
        command: command!,
        ...(io.live === "inline" ? { inline: { write: io.out, rows: io.rows ?? 24, cols: io.columns ?? 80 } } : {}),
      });
      const sink = started.sink,
        ask = io.ask,
        decoder = new TextDecoder();
      ctx.progress = line => {
        if (line.startsWith("warning:")) warnings.push(line);
        sink({ t: "log", text: `custom-build: ${line}\n` });
      };
      ctx.echo = chunk => sink({ t: "log", text: decoder.decode(chunk, { stream: true }) });
      ctx.signal = sink;
      ctx.ask = ask && (question => started.ask(question, ask));
      return started;
    };
    let outcome: run.Outcome;
    switch (command) {
      case "rebuild": {
        const push = flag(args, "push"),
          rebase = rebaseMode(args),
          inWorktree = flag(args, "in-worktree"),
          verbose = flag(args, "verbose");
        noMore(args);
        view = live(verbose);
        outcome = await run.rebuild(ctx, { push, rebase, inWorktree });
        break;
      }
      case "rebase": {
        const verbose = flag(args, "verbose");
        if (flag(args, "skip-branch")) {
          noMore(args);
          view = live(verbose);
          outcome = await run.skipBranch(ctx);
          break;
        }
        const push = flag(args, "push"),
          rebase = rebaseMode(args),
          inWorktree = flag(args, "in-worktree");
        noMore(args);
        view = live(verbose);
        outcome = await run.rebaseCommand(ctx, { push, rebase, inWorktree });
        break;
      }
      case "continue": {
        const verbose = flag(args, "verbose");
        noMore(args);
        view = live(verbose);
        outcome = await run.resume(ctx);
        break;
      }
      case "rollback": {
        const verbose = flag(args, "verbose");
        noMore(args);
        // On a terminal, a checklist of the rollback's steps; --verbose streams the install's output instead.
        if (!verbose && !io.sink && (io.color || io.live === "inline")) {
          const shown = (tasks = new TaskView({
            write: io.out,
            rows: () => (io.live === "inline" ? io.rows : process.stdout.rows || io.rows) ?? 24,
            cols: () => (io.live === "inline" ? io.columns : process.stdout.columns || io.columns) ?? 80,
            color: !!io.color,
            command: "rollback",
            branch: ctx.config.branch,
            ...(io.now ? { now: () => io.now!().getTime() } : {}),
            hooks: io.live !== "inline",
          }));
          ctx.task = (id, state, detail) => shown.task(id, state, detail);
          ctx.progress = line => void (line.startsWith("warning:") && warnings.push(line));
          ctx.echo = () => {};
        }
        outcome = await run.rollback(ctx);
        break;
      }
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
        outcome = list(ctx, retired, io);
        break;
      }
      default:
        throw new Usage(`unknown command ${command}`);
    }
    // The card holds the outcome's lines; the run's own end has its report and time.
    if (view) await view.end(warned(view.received ?? ended(outcome), warnings));
    else if (tasks) tasks.finish(warned(ended(outcome), warnings));
    else if (outcome.lines.length) {
      // A rollback on a terminal ends in a card like the views'; other commands print as they are.
      const lines =
        command === "rollback" && io.color
          ? outcomeCard(ended(outcome), { width: io.columns ?? 80, color: true })
          : outcome.lines;
      io.out(lines.join("\n") + "\n");
    }
    return outcome.code;
  } catch (error) {
    if (error instanceof Usage) return usageError(io, error.message);
    const message = (error as Error).message,
      explained = error instanceof run.Explained ? error : null,
      details = explained?.lines ?? [],
      // A card shows the commands to go on with below it: its headline can be the short one.
      failure = warned(
        ended({ code: 1, lines: [`custom-build: ${explained?.headline ?? message}`, ...details] }),
        warnings,
      );
    // The view ends with the error, so the terminal is put back and the error shows.
    if (view) await view.end(failure);
    else if (tasks) tasks.finish(failure);
    else if (io.color)
      io.err(outcomeCard(failure, { width: io.columns ?? 80, color: true, command: command! }).join("\n") + "\n");
    else io.err([`custom-build: ${message}`, ...details].join("\n") + "\n");
    return 1;
  }
}
/** An outcome as the live view's end. */
const ended = (outcome: { code: number; lines: string[] }) =>
  liveEvents.end(outcome, null) as Extract<liveEvents.LiveEvent, { t: "end" }>;
/** The end with the run's warnings after its headline, as plain output shows them on stderr. */
const warned = (e: ReturnType<typeof ended>, warnings: string[]): ReturnType<typeof ended> =>
  warnings.length ? { ...e, lines: [...warnings.map(line => `  ${line}`), ...e.lines] } : e;
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
  // The tool resets the custom branch and replaces its backup on every run.
  const owned = [ctx.config.branch, `${ctx.config.branch}-prev`];
  if (source.kind === "branch" && owned.includes(source.name))
    throw Error(`${display} is a branch the tool resets (${owned.join(", ")}); rename it or set another branch`);
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

function list(ctx: run.Context, retired: boolean, io: IO): run.Outcome {
  const { repo, config } = ctx,
    // Own branches link into the fork; only a terminal shows links.
    fork = io.color && git.hasRemote(repo, "origin") ? git.remoteTarget(repo, "origin", "push") : null,
    upstream = `${git.resolveUpstreamRemote(repo, config)}/${config.upstream.branch}`;
  return {
    code: 0,
    lines: listView.render(config, { retired, upstream, fork, color: !!io.color, columns: io.columns }),
  };
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
    color: !!process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb",
    columns: process.stdout.isTTY ? process.stdout.columns : undefined,
    rows: process.stdout.isTTY ? process.stdout.rows : undefined,
  });
