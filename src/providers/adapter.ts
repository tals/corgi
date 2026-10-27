import type { Hook, Text } from "./common";
import type { Quit } from "../subprocess";
import type { Info as Account } from "../usage/account";
import type { Entry as Session, Store } from "../launch/history";
import type { Terminal } from "../pane/terminal";
import type { Actor, Registry } from "../conversations";
import type { Agent, State } from "../agents";
import type { Outcome } from "../observation";
import type { Counts } from "../usage/tokens";
import type { Tokens } from "../usage/live";
import type { Request as UsageRequest, Result as UsageResult, Tail as UsageTail } from "../usage/worker";
import type { Request as ObserverRequest, Snapshot } from "./snapshot";
import type { Runtime } from "../runtime";
/** What the launcher shows about a provider. Corgi opens one per launcher
 * worker and closes it with that worker. */
export interface Launcher {
  /** Its account, plan and usage limits. Usage is fetched again once the
   * reading, which folders signed in to the same account share, is `max_age`
   * seconds old; 0 fetches it now, even while a failed read waits. */
  account(quit: Quit, max_age: number): Promise<Account>;
  /** The model it would start with in `cwd`, and the setting that chose it.
   * Corgi asks after `account`, whose sign-in may name the default. */
  model(cwd: string, quit: Quit): Promise<{ model: string; model_name?: string; source: string }>;
  /** Files whose changes change what it reads; Corgi reads it again when one does. */
  watches?(): string[];
  close(): void;
}
/** What core asks of a headless client. A prompt or interrupt without a
 * session goes to the conversation it shows. */
export type Input =
  | { kind: "prompt"; text: string; session?: string }
  | { kind: "answer"; request: string; allow: boolean; message?: string }
  | { kind: "interrupt"; session?: string };
/** What a request asks: `tool` when it is a tool waiting to run. */
export type Ask = { tool: boolean; name: string; summary: string };
/** What a client tells core, decoded from its provider's own protocol. Every
 * event names its conversation, "" for the one it shows before it has an ID. */
export type Event =
  | { kind: "ready" }
  | { kind: "conversation"; session: string; parent: string | null; role: string | null; shown: boolean }
  | { kind: "turn"; session: string; turn: string; phase: "started" }
  | { kind: "turn"; session: string; turn: string; phase: "ended"; outcome: Outcome }
  | { kind: "message"; session: string; text: string }
  | { kind: "tool"; session: string; turn: string; id: string; done: boolean; wrote: string[] }
  | { kind: "request"; session: string; id: string; ask: Ask }
  | { kind: "request_closed"; session: string; id: string; running: boolean }
  | {
      kind: "usage";
      session: string;
      turn: string;
      /** One request's tokens, counted once however often `id` reports them. */
      part?: { id: string; tokens: Tokens };
      /** The conversation's running total, and its last request. */
      total?: { total: Tokens; last: Tokens | null };
    }
  | { kind: "ended" };
/** A client's state for a checkpoint or handoff. A handoff passes `handles`
 * to the next daemon, renumbered. */
export type Saved = { state: unknown; handles: number[] };
/** A provider session Corgi drives without a terminal, however the provider
 * runs it: a process Corgi starts, or one of its own daemons. */
export interface Client {
  readonly ready: boolean;
  send(input: Input): void;
  /** What happened since the last call. Never blocks. */
  take(): Event[];
  /** Resolves once there may be something to take, or at `deadline`. */
  wait(deadline: number): Promise<void>;
  close(): void;
  save(live: boolean): Saved;
  /** The processes it runs, for the resource list. */
  processes?(): number[];
  /** A client restored from a handoff is the old daemon's until adopted. */
  adopt?(): void;
}
/** Where a client runs: `account` names a provider account, "" the default. */
export type Place = { cwd: string; account: string; executable: string };
/** A provider's session transcripts, read as they grow. */
export interface Transcript {
  /** Initial user evidence for Corgi naming, only when the provider has no automatic titles. */
  naming?(agent: Agent): Promise<string | null>;
  /** Throws unless `head`, a transcript's first record, says it is `session`'s. */
  verify?(head: unknown, session: string): void;
  /** How a record ends `agent`'s current turn, if it does. */
  completion(agent: Agent, value: unknown): Outcome | null;
  /** Shows what transcripts found while nothing better reports the agent;
   * true when its activity moved. */
  fallback(r: UsageResult, agent: Agent, now: number): boolean;
  /** Where the transcript of `session` lives when a record of the one at
   * `transcript` says it continues there. */
  continuation?(transcript: string, session: string): string;
  /** A reader for the usage worker, closed with it. `accounts` lists the
   * folders of the accounts besides the default. */
  reader(accounts: () => string[]): TranscriptReader;
}
export interface TranscriptReader {
  /** Runs once a pass, before any transcript is read. */
  refresh?(): Promise<void>;
  /** Readies `t` for a file it just opened; `head` is the file's first record. */
  open(t: UsageTail, req: UsageRequest, head: unknown, catch_up: boolean): void;
  /** Folds one record into `t`; the tokens and tools it counted. */
  record(t: UsageTail, req: UsageRequest, value: any, appended: boolean, stamp: number | null): Counts;
  /** A session's name, when it comes from somewhere besides its transcript:
   * Corgi then follows the session even without one. */
  name?(session: string): Text;
  close?(): void;
}
/** Watches a provider's conversations over its own protocol, for what its
 * hooks and transcripts leave out. Corgi starts one with the daemon. */
export interface Observer {
  running: boolean;
  stopping: boolean;
  /** Chooses the panes and conversations to ask about next. */
  reconcile(runtime: Runtime): void;
  run(): Promise<void>;
  /** What it saw since the last call. */
  take(): Snapshot[];
  /** Panes whose title names a session it couldn't find. */
  takeMissed(): ObserverRequest[];
  stop(): void;
}
/** How a provider renames a session. */
export interface Rename {
  /** Sets an automatic title only if the provider still has no explicit name. */
  suggest?(session: string, name: string, account: string): Promise<"named" | "exists" | "unavailable">;
  /** Renames `session`, in `account`, through the provider's own channel, if
   * one is open now; `connected` when its protocol spoke in the last few
   * seconds. */
  channel(session: string, connected: boolean, account: string): Promise<((name: string) => Promise<void>) | null>;
  /** Types the rename into its composer instead. */
  typed?: { command(name: string): string; empty(t: Terminal): boolean; holds(t: Terminal, text: string): boolean };
}
/** The past sessions the launcher offers to resume. Corgi opens one per
 * history worker and closes it with that worker. */
export interface SessionHistory {
  /** Directories whose changes can change its sessions. */
  roots(): string[];
  /** Its sessions; not `complete` when it could list only some. */
  list(stopping: () => boolean): Promise<{ sessions: Session[]; complete: boolean }>;
  /** Folds changes at `paths`, under its roots, into `store`. */
  changed(paths: string[], store: Store, stopping: () => boolean): Promise<void>;
  close(): void;
}
/** A pane running the provider, as its watcher reads it. */
export interface PaneView {
  readonly id: number;
  readonly title: string;
  /** The screen's text, read only if asked. */
  text(): string;
}
/** What a watcher keeps about a pane between reads. Core keeps it with the
 * pane, saves it, and clears it when the pane runs a new process. */
export interface PaneMemory {
  /** The state the screen has shown lately, and how many reads in a row. */
  candidate: State | null;
  confirmations: number;
  /** The screen has shown idle since the process started. */
  ready: boolean;
  /** Explicit identity can establish work before the first idle screen. */
  readonly allow_initial_work?: boolean;
  idle_since: number;
  /** When the user last pressed a key that interrupts, if lately. */
  interrupt_key_at: number;
}
/** What a watcher keeps about a conversation's prompts between reads. */
export interface PromptMemory {
  seen: boolean;
  covered: number;
  open: number;
}
/** What Corgi knows of the conversation a pane shows, for a watcher deciding
 * what its screen adds. */
export type Known = {
  state: State;
  /** Hooks, a transcript or the protocol spoke for it lately. */
  authoritative: boolean;
  /** A stop it reported still waits on confirmation. */
  pending_stop: boolean;
  /** A permission hook said a prompt may show, without saying it does. */
  permission_review: boolean;
  prompt: PromptMemory;
};
/** What a pane's screen adds to what the agent's other sources say. */
export type Seen = {
  /** The state the screen shows, confirmed, for an agent nothing else
   * speaks for; null while it can't tell. */
  shown: { state: State; tool: boolean } | null;
  /** Whether a compaction shows, while the agent works; null when it can't tell. */
  compacting: boolean | null;
  /** The turn its hooks call working ended without them saying so. */
  interrupted: boolean;
  /** A prompt its hooks blocked on was answered, and what it does now. */
  answered: State | null;
  /** Whether a permission prompt its hooks announced shows; null when none was announced. */
  prompt: boolean | null;
};
/** How a provider judges its own clues: which pane a hook is about, and
 * what a screen says that hooks don't. Core keeps one per provider and
 * account, and applies what it decides. */
export interface Watcher {
  /** The pane whose conversation a hook is about, given the pane it says
   * it came from and the pane that shows a session; `binds` when the hook
   * may make that pane show its session. Null drops the hook. */
  route(
    hook: NonNullable<Hook>,
    from: number | null,
    showing: (session: string) => number | null,
  ): { pane: number; binds: boolean } | null;
  read(pane: PaneView, memory: PaneMemory, known: Known | null, now: number): Seen;
}
/** A launcher command, split: the variables it sets, then its words from
 * the program on. `flagged` when an option came before the program. */
export type CommandLine = { env: [string, string][]; args: string[]; flagged: boolean; cwd: string };
/** What a launcher command sets up for the agent it starts. */
export type Inspection = {
  permissions: Permissions;
  /** Empty when it doesn't choose one. */
  model: string;
  /** The account, as the launcher shows it; empty when it can't say. */
  account: string;
  /** It signs in as the user's own default account. */
  default_account: boolean;
};
/** Who signed in: the email the provider shows, and what tells two logins
 * apart, since one email can sign in to a personal plan and a team's. */
export type Login = { email: string; id: string };
/** What a first run shows while someone signs in: how to sign in, a link
 * whose page comes back to this machine, a link whose page gives a code to
 * paste here, or a link and a code to type on the page. */
export type SigninStep = "method" | "browser" | "code" | "device";
/** Its own first-run sign-in, which `corgi account add` frames. */
export type Signin = {
  /** Whether its screen shows something to answer yet. Until it does, or a
   * deadline passes, the frame says it's starting. */
  started(text: string): boolean;
  /** The step a screen of its first run shows; null for any other screen. */
  step(text: string): SigninStep | null;
  /** What the frame says under a step: what its own screen leaves out. */
  hints: Partial<Record<SigninStep, string>>;
  /** Its first run at `directory` is over, so a session there opens at the prompt. */
  ready(directory: string): boolean;
  /** Arguments, run with the variable set, that exit 0 once someone signed
   * in: its own word, as a login can live outside the folder. A function
   * chooses arguments for the provider saved in that directory. */
  check: string[] | ((directory: string) => string[]);
  /** Arguments that sign out, run the same way, before Corgi deletes a
   * folder a cancelled sign-in made. A provider without a logout CLI can
   * remove its local credentials directly. */
  logout: string[] | ((directory: string) => void);
  /** Arguments its first run in a new account's folder starts with. */
  first: string[];
  /** Arguments that sign in to a folder it has run in before, for one whose
   * own screens then don't offer to; null when they do. */
  again: string[] | null;
};
/** How a provider keeps accounts: each in a settings directory of its own,
 * which a variable picks. */
export type Accounts = {
  /** The variable that picks the directory. */
  env: string;
  /** The directory it uses when the variable is unset. */
  home(env?: NodeJS.ProcessEnv): string;
  /** What a second directory is often called, this then a name, which
   * names a folder an agent ran in. */
  prefix: string;
  /** Who signed in at `directory`, as it caches that; null when no one has. */
  identity(directory: string): Login | null;
  /** What a directory Corgi makes links to in the default one: folders,
   * and files the default has. */
  shared: { dirs: string[]; files: string[] };
  /** Null when the provider only supports its existing default account. */
  signin: Signin | null;
};
/** What a provider is called. */
export type Info = {
  /** How data names it: the wire, checkpoints and the CLI. */
  id: string;
  label: string;
  name: string;
  /** Marks its processes in the resource list. */
  glyph: string;
  launcher_key: string;
  /** The executable a user types to start it. */
  command: string;
  /** False when permission policy belongs to extensions, with no CLI bypass. */
  bypass?: boolean;
  /** How its processes show; the native layer gets these too. */
  programs: Programs;
};
/** An agent CLI's executable names, paths only its installs contain, and the
 * scripts an interpreter runs for it. */
export type Programs = { names: string[]; markers?: string[]; scripts?: string[] };
/** How an agent asks before acting: as its own settings say, or never. */
export type Permissions = "default" | "bypass";
/** What a launch asks of a new agent: its permission checks and model, as
 * the agent last reported them, and the options a resume or fork keeps from
 * the command that first started it. */
export type Settings = { permissions: Permissions; model: string | null; args: string[] };
/** What a resume or fork keeps of a command someone typed to start an agent. */
export type Kept = { args: string[]; env: [string, string][] };
/** One kind of request a tool-less model answers. */
export type Inference = { instructions: string; model: string | null; schema: string | null };
/** An authenticated chat model; prices are catalog dollars per million tokens. */
export type InferenceModel = {
  id: string;
  name: string;
  /** The signed-in user for this model's provider, when available. */
  user?: string;
  /** A known subscription tier, not inferred from model prices. */
  plan?: string;
  subscription: boolean;
  input_cost: number | null;
  output_cost: number | null;
  /** A successful or failed tool-less probe; null/absent means untested. */
  ready?: boolean | null;
};
export type Fork = {
  args: string[];
  /** The fork's session, when the provider lets Corgi pick it. */
  session: string | null;
  /** Whether `args` names the fork; if not, core renames it once it shows up. */
  named: boolean;
};
/** How a provider behaves, wherever core has to know. */
export type Caps = {
  /** A prompt's hook ID names the turn it opens. */
  prompt_turns: boolean;
  /** The subagent list its Stop hook reports holds until the next one. */
  children_at_stop: boolean;
  /** The cwd its hooks report follows the shell's `cd`. */
  follows_cd: boolean;
  /** Its chat view titles the terminal; the screen it shows while a session loads doesn't. */
  titles_once_loaded: boolean;
  /** Its transcripts show which tools run, beyond what its hooks report. */
  transcript_tools: boolean;
};
/** What a provider's hooks tell beyond its lifecycle. */
export interface Conversation {
  /** Keeps an actor's background work as a hook it accepted reports it. */
  hooked?(actor: Actor, event: Hook, now: number): void;
  /** Follows a hook an actor applied: its subagents, a pause. */
  applied?(registry: Registry, actor: Actor, event: Hook, seq: bigint, now: number): void;
  /** Follows a child's start or stop, which leaves the actor's own state alone. */
  child?(registry: Registry, actor: Actor, event: Hook, now: number): void;
  /** Whether the process holding an actor's pause still runs. */
  holds?(pid: number): boolean;
}
/** Everything core asks a provider. Each one lives in `providers/<name>/`. */
export interface Adapter extends Info {
  caps: Caps;
  inspect(c: CommandLine): Inspection;
  /** Where it may be installed besides PATH, most likely first. `root`
   * prefixes system locations so tests can stand in for them. */
  installs(at: { home: string | null; root: string }): string[];
  /** Whether a candidate's `--version` says it is this provider. Without it,
   * the first `command` on PATH is. */
  version?(stdout: string): boolean;
  /** The versions `version` takes, as a sign-in says it: "1.0.0 or newer". */
  requires?: string;
  accounts: Accounts;
  /** Its judge of hooks and screens, for an account ("" for the default). */
  watch(account: string): Watcher;
  hook(v: unknown): Hook;
  /** Where a hook comes from, as `corgi hook` reads it inside the agent: the
   * process it runs under, and whether that is a background session rather
   * than its pane's own. Null drops a hook its pane didn't send. */
  origin?(event: unknown): { pid: number; background: boolean } | null;
  /** Clears what tells a process it runs inside this provider, so an agent a
   * pane starts isn't taken for one nested in the agent Corgi started from. */
  unnest?(env: Record<string, string | undefined>): void;
  /** The session a terminal title names, for a provider that titles it so;
   * the pane then shows the conversation its title names. */
  titleSession?(title: string): Text | null;
  launch: {
    /** Prepares a terminal session before exec, reporting its identity when
     * the provider's UI cannot report it itself, and variables the session
     * needs that the pane's shell does not set. */
    prepare?(
      args: string[],
      executable: string,
    ): Promise<{ args: string[]; event?: unknown; env?: [string, string][] }>;
    /** Arguments that start an agent. */
    start(s: Settings): string[];
    /** Arguments, after the ones it started with, that resume `session`. */
    resume(session: string, account?: string): string[];
    /** Arguments, after the command, that attach to `session` where it
     * already runs in `account`, such as a daemon of the provider's own,
     * instead of resuming it. */
    attach?(session: string, account: string): string[] | null;
    /** Arguments, after the ones it started with, that fork `from` in `cwd`; null
     * while there is nothing to fork yet. */
    fork(from: { session: string; transcript: string; cwd: string }, name: string | null): Fork | null;
    /** What a resume or fork keeps of a command line someone typed: the
     * account, MCP servers and feature flags it chose. Not its session,
     * prompt, model or permission checks, which the agent reports as they
     * change. */
    keep?(c: CommandLine): Kept;
  };
  rename?: Rename;
  /** Runs it headless, for a daemon-hosted session. */
  headless?: {
    start(at: Place): Client;
    restore(saved: Saved, live: boolean): Client;
  };
  inference: {
    model: string;
    /** Native catalogs share one model provider across account folders. */
    catalog?: "native";
    /** The model provider's display name for a native inference choice. */
    source?: string;
    /** Models for private inference; a provider may probe tool-less access. */
    models?(account: string, quit: Quit): Promise<InferenceModel[]>;
    /** A private, tool-less client for `r`'s conversations. Its answer to a
     * prompt is the last message before the turn ends. */
    start(r: Inference, at: Place): Client;
    restore(saved: Saved, live: boolean): Client;
    /** Starts `r` on `c` in place of its conversation, when one process can
     * hold several; false when it can't. */
    renew?(c: Client, r: Inference): boolean;
  };
  /** What the launcher shows about `account`, "" for the default. */
  launcher?(account: string): Promise<Launcher>;
  history?(account: string): Promise<SessionHistory>;
  transcript?: Transcript;
  conversation?: Conversation;
  /** Watches the conversations of panes in `account`. */
  observer?(account: string): Observer;
  /** What it needs in an account's settings to report to Corgi. */
  integration: {
    /** Where the account's settings live; an uninstall is remembered for it. */
    directory(account: string): string;
    install(account: string): Promise<IntegrationStepResult[]>;
    uninstall(account: string): Promise<IntegrationStepResult[]>;
    status(account: string): Promise<IntegrationStepResult[]>;
    /** Runs for each account when the daemon starts or takes over from an
     * older one in a handoff, unless the user uninstalled it there. */
    startup(account: string, handoff: boolean): Promise<void>;
    /** Settings that make it report to Corgi, to add by hand. */
    snippet(executable: string): string;
  };
}
/** One thing `corgi integration` added, found or removed. */
export type IntegrationStepResult = {
  /** What it is, as the command lists it: "hooks", "title", "backup". */
  item: string;
  path: string;
  outcome: "added" | "present" | "partial" | "removed" | "absent" | "no_config" | "failed";
  /** What the line names, when it isn't the item itself: "thread ID". */
  subject?: string;
  /** The provider's own words after the line. */
  note?: string;
  /** The user still has something to do. */
  todo?: boolean;
  error?: string;
};
