//! One daemon as the viewer sees it: what it reported, what's selected
//! there, the connection its requests take, and what this viewer keeps
//! about its workspaces and panes. A controller lists every machine's
//! workspaces and shows one machine's panes at a time.
import { Runtime, type Transport } from "./mirror";
import { State as Navigation } from "./navigation";
import type * as launcherResume from "./launcher_resume";
import type { Target as OrderTarget } from "./agent_order";
import type { Provider } from "./providers";
import { Tasks } from "./tasks";
import type { WorkspaceEntry } from "./sidebar";
import * as worktreeAgents from "./worktree_agents";

/** A conversation a pane stopped running, and when, in seconds. */
export interface Stopped {
  provider: Provider;
  session: string;
  at: number;
}
/** Where to go on a machine once it's shown: a workspace, or an agent. */
export type Focus = { workspace: number } | OrderTarget;
/** How a machine's connection stands, as its sidebar rows say. */
export interface Presence {
  online: boolean;
  connecting: boolean;
  /** Why it isn't online. */
  description: string;
  /** Its rows from the last time it answered, until it does this session. */
  cached: WorkspaceEntry[];
  /** It has answered at some point, so rows name their machine. */
  seen: boolean;
  /** Its cached rows came from a daemon since replaced; their ids name
   * nothing on the new one. */
  stale: boolean;
}
export class Machine {
  order_scope = "";
  runtime = new Runtime();
  navigation = new Navigation();
  /** Work handed to this daemon; see tasks.ts. */
  readonly tasks: Tasks;
  /** Told when a task fails or settles: the controller showing the machine. */
  failed: (error: unknown) => void = () => {};
  settled: () => void = () => {};
  /** This viewer's id on the daemon, and the last control taken from it. */
  viewer_id = 0;
  last_control = 0n;
  /** Links point at the daemon's machine, so they're shown, not opened here. */
  remote_links = false;
  /** Workspace ids whose group is folded in the grouped "All" list. */
  folded_groups: number[] = [];
  /** Its worktree groups' folds, and the worktree being browsed. */
  worktree_agents = new worktreeAgents.State();
  /** Panes marked unread from the agent menu, each with whether it had
   * focus when last shown. Showing one doesn't read it until focus moves
   * onto it, it takes input, or it leaves view. */
  marked_unread = new Map<number, boolean>();
  /** Conversations panes run, and recent ones that stopped, with when. */
  running: launcherResume.Open[] = [];
  stopped: Stopped[] = [];
  presence: () => Presence = () => ({
    online: true,
    connecting: false,
    description: "",
    cached: [],
    seen: false,
    stale: false,
  });
  constructor(
    public connection: Transport,
    readonly name = "local",
    /** Another computer's daemon, over SSH. */
    readonly remote = false,
  ) {
    this.tasks = new Tasks(
      () => this.connection,
      error => this.failed(error),
      () => this.settled(),
    );
  }
  /** Drops what a daemon reported, once another has replaced it: its ids
   * mean nothing to the new one. */
  forget(): void {
    this.runtime.destroy();
    this.runtime = new Runtime();
    this.navigation = new Navigation();
    this.viewer_id = 0;
    this.last_control = 0n;
    this.folded_groups = [];
    this.worktree_agents = new worktreeAgents.State();
    this.marked_unread.clear();
    this.running = [];
    this.stopped = [];
  }
}
