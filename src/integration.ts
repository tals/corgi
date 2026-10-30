import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Provider, adapter } from "./providers";
import type { IntegrationStepResult } from "./providers/adapter";
import { atomicWrite } from "./os";
import * as discovery from "./discovery";
import * as rpc from "./rpc";
import * as accounts from "./accounts";
export async function hook(provider: Provider, path: string): Promise<void> {
  const id = Number(process.env.CORGI_PANE);
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) return;
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const b = Buffer.from(chunk);
    size += b.length;
    if (size > 1024 * 1024) return;
    parts.push(b);
  }
  let event: any;
  try {
    event = JSON.parse(Buffer.concat(parts).toString());
  } catch {
    return;
  }
  const a = adapter(provider),
    origin = a.origin ? a.origin(event) : { pid: 0, background: false };
  if (!origin) return;
  try {
    await rpc.request(path, "hook", {
      provider,
      event,
      pane: id,
      seq: Date.now() * 1000,
      background: origin.background,
      pid: origin.pid,
    });
  } catch {}
}
export async function launch(provider: Provider, args: string[], _executable: string): Promise<never> {
  if (process.env.CORGI_PANE === undefined) throw Error("LaunchInsideCorgi");
  // Like execvp: a bare name (Claude, or an override) is looked up on PATH.
  const binary = await discovery.resolve(provider),
    path = binary.includes("/") ? binary : discovery.onPath(binary);
  if (path === null) throw Error("ProviderNotFound");
  const prepared = await adapter(provider).launch.prepare?.(args, path);
  if (prepared) {
    args = prepared.args;
    for (const [key, value] of prepared.env ?? []) process.env[key] = value;
    if (prepared.event)
      await rpc.request(process.env.CORGI_SOCKET!, "hook", {
        provider,
        event: prepared.event,
        pane: Number(process.env.CORGI_PANE),
        seq: Date.now() * 1000,
        background: false,
        pid: process.pid,
      });
  }
  process.execve!(path, [binary, ...args], process.env as Record<string, string>);
  throw Error("ExecFailed");
}
/** Config directories the user uninstalled Corgi from, which startup leaves
 * alone. It sits under the base state directory, so temporary and named
 * environments, which share the providers' configs, see it too. */
function removalsPath() {
  const e = process.env;
  return join(e.CORGI_ENV_BASE ?? e.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "corgi", "integrations.json");
}
function removals(): string[] {
  try {
    const value = JSON.parse(readFileSync(removalsPath(), "utf8")).uninstalled;
    return Array.isArray(value) ? value.filter(v => typeof v === "string") : [];
  } catch {
    return [];
  }
}
export function uninstalled(provider: Provider, account = ""): boolean {
  return removals().includes(adapter(provider).integration.directory(account));
}
function remember(provider: Provider, account: string, gone: boolean) {
  const directory = adapter(provider).integration.directory(account),
    saved = removals();
  if (saved.includes(directory) === gone) return;
  const next = saved.filter(d => d !== directory),
    text = JSON.stringify({ uninstalled: gone ? [...next, directory] : next }, null, 2) + "\n";
  atomicWrite(removalsPath(), text, 0o600, false);
}
/** Every account of each provider, the default first. */
function everyAccount(only: Provider | null = null) {
  return (only ? [only] : Provider.all).flatMap(provider => [
    { provider, account: "" },
    ...accounts
      .known()
      .filter(a => a.provider === provider)
      .map(a => ({ provider, account: a.dir })),
  ]);
}
/** The accounts this process has set up, and how that went. */
const prepared = new Map<string, Promise<void>>();
/** Adds what each account needs at daemon start, unless the user took it out. */
export async function startup(handoff: boolean) {
  for (const { provider, account } of everyAccount()) await prepare(provider, account, handoff);
}
/** Adds what an account needs before an agent starts in it, unless the
 * user took it out. Each account is set up once per process. */
export function prepare(provider: Provider, account: string, handoff = false): Promise<void> {
  const key = provider + "\0" + account;
  let done = prepared.get(key);
  if (!done)
    prepared.set(
      key,
      (done = (async () => {
        try {
          if (!uninstalled(provider, account)) await adapter(provider).integration.startup(account, handoff);
        } catch (error) {
          console.error("hook setup:", error);
        }
      })()),
    );
  return done;
}
type Op = "status" | "install" | "uninstall";
type Line = { provider: Provider; account: string } & (
  IntegrationStepResult | { item: "startup"; path: string; outcome: "off" }
);
async function steps(provider: Provider, account: string, op: Op): Promise<Line[]> {
  const { integration } = adapter(provider);
  if (op !== "status") remember(provider, account, op === "uninstall");
  const results = await integration[op](account),
    lines: Line[] = results.map(result => ({ provider, account, ...result }));
  if (op === "status" && uninstalled(provider, account))
    lines.push({ provider, account, item: "startup", outcome: "off", path: integration.directory(account) });
  return lines;
}
function describe(line: Line, home: string, op: Op): string {
  const at = home && line.path.startsWith(home + "/") ? "~" + line.path.slice(home.length) : line.path;
  if (line.outcome === "off") return "off, so Corgi won't add them when it starts";
  const what = line.subject ? line.subject + " " : "",
    note = line.note ?? "";
  switch (line.outcome) {
    case "added":
      return `${what}added to ${at}${note}`;
    case "present":
      return (op === "status" ? `${what}in ${at}` : `${what}already in ${at}`) + note;
    case "partial":
      return `${what}in ${at}; \`corgi integration install\` adds the rest`;
    case "removed":
      return (line.item === "backup" ? `deleted ${at}` : `${what}removed from ${at}`) + note;
    case "absent":
      return op === "status" && !what ? `not in ${at}` : `${what ? "no " + what : "none "}in ${at}`;
    case "no_config":
      return `${op === "status" ? "" : "skipped, "}no ${at}`;
    case "failed":
      return `failed in ${at}: ${line.error}`;
  }
}
/** The lines `corgi integration` prints, aligned. */
function format(lines: Line[], op: Op): string[] {
  const label = (l: Line) =>
      adapter(l.provider).label + (l.account ? " · " + accounts.label(l.provider, l.account) : ""),
    labels = Math.max(...lines.map(l => label(l).length)),
    items = Math.max(...lines.map(l => l.item.length)),
    home = process.env.HOME ?? "";
  return lines.map(
    line => `${mark(line, op)} ${label(line).padEnd(labels)}  ${line.item.padEnd(items)}  ${describe(line, home, op)}`,
  );
}
/** What `corgi integration status` prints, for every agent and account. */
export async function status(): Promise<string[]> {
  const lines: Line[] = [];
  for (const { provider, account } of everyAccount()) lines.push(...(await steps(provider, account, "status")));
  return format(lines, "status");
}
function mark(line: Line, op: Op): string {
  if (line.outcome === "failed" || line.outcome === "partial" || ("todo" in line && line.todo)) return "✗";
  return line.outcome === (op === "status" ? "present" : "added") || line.outcome === "removed" ? "✓" : "·";
}
export const help = `Usage: corgi integration COMMAND [${Provider.all.join("|")}] [--account NAME]

  status      show what Corgi has added to each agent's settings
  install     add what each agent needs to report to Corgi
  uninstall   remove everything Corgi added; startup won't add it back

Without an agent, a command covers ${Provider.all.map(p => adapter(p).label).join(" and ")}, in
every account Corgi knows; --account picks one ("default" for your own).
`;
/** `corgi integration status|install|uninstall [PROVIDER] [--account NAME]`:
 * one line per thing Corgi adds. False when any step failed. */
export async function command(op: Op, only: Provider | null, named: string | null = null): Promise<boolean> {
  const chosen = named === null ? null : named === "default" ? "" : accounts.named(named, only)?.dir;
  if (chosen === undefined) throw Error("UnknownAccount");
  const lines: Line[] = [];
  for (const { provider, account } of everyAccount(only))
    if (chosen === null || chosen === account) lines.push(...(await steps(provider, account, op)));
  for (const text of format(lines, op)) process.stdout.write(text + "\n");
  if (op === "uninstall")
    process.stdout.write("Corgi won't add them back when it starts; `corgi integration install` does.\n");
  else if (op === "install" && lines.some(l => l.item === "hooks" && l.outcome === "added"))
    process.stdout.write("Agents started from now on report to Corgi; restart running ones.\n");
  return !lines.some(l => l.outcome === "failed");
}
