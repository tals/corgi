import { basename } from "node:path";
import * as cli_args from "./cli_args";
import * as cli_help from "./cli_help";
import * as config from "./build_config";
import * as errors from "./errors";
import { Provider } from "./providers/names";
import skill from "../assets/corgi-skill.md" with { type: "text" };

export function providerAlias(argv0: string): Provider | null {
  return Provider.parse(basename(argv0));
}

/** Help, version and skill output need no native libraries, terminal or runtime. */
export async function run(args = process.argv.slice(2)): Promise<void> {
  const alias = providerAlias(process.argv0),
    invocation = alias ? { kind: "command" as const, args, agent: null } : cli_args.parse(args);
  switch (invocation.kind) {
    case "help":
      process.stdout.write(cli_help.render(invocation.topic));
      return;
    case "version":
      process.stdout.write(`corgi ${config.releaseVersion} (${config.releaseCommit})\n`);
      return;
    case "skill":
      process.stdout.write(skill);
      return;
    case "command": {
      const app = await import("./app");
      try {
        await app.run(invocation.args, invocation.agent, alias);
      } catch (error) {
        if (!import.meta.main) throw error;
        process.stderr.write(app.failure(invocation.args, error));
        if (process.env.CORGI_DEBUG) console.error(error);
        process.exitCode = errors.is(error, "Usage") || errors.is(error, "UnknownCommand") ? 2 : 1;
      }
      return;
    }
  }
}

if (import.meta.main)
  run().catch(error => {
    const args = process.argv.slice(2);
    process.stderr.write(
      errors.is(error, "UnknownCommand")
        ? `corgi: unknown help topic ${args.join(" ")}; see corgi --help\n`
        : `corgi: ${errors.name(error) ?? String(error)}\n`,
    );
    if (process.env.CORGI_DEBUG) console.error(error);
    process.exitCode = errors.is(error, "UnknownCommand") ? 2 : 1;
  });
