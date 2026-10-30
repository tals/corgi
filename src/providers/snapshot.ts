//! What a provider's own protocol shows of a conversation, as its observer
//! reads it.
import { BoundedText, Path } from "../bounded_text";
import { Inventory } from "../activity/background_tasks";
import { Text as SummaryText } from "../activity/summary";
import type { Text } from "./common";
import type { State } from "../agents";
import type { Location } from "../worktrees";
import type { Tokens } from "../usage/live";
import type { Reading } from "../usage/context_window";
import type { Model } from "./model";
export class Name extends BoundedText(160) {}
export class Role extends BoundedText(80) {}
export class Turn extends BoundedText(128) {}
/** A pane whose title names a session, or, with `actor`, a conversation to follow. */
export type Request = {
  pane: number;
  pid: number;
  prefix: Text;
  actor: number;
  generation: bigint;
  title_revision: bigint;
};
export class Child {
  session = "";
  name = new Name();
  role = new Role();
  transcript = new Path();
  state: State = "unknown";
  updated_at = 0;
}
export class Snapshot {
  /** False when the source identifies a session but does not own its live state. */
  lifecycle = true;
  model = "";
  model_info: Model | null = null;
  tool_active: boolean | null = null;
  /** Whether the provider reports an active compaction; null when it can't tell. */
  compacting: boolean | null = null;
  tool = "";
  usage: { total: Tokens; last: Tokens | null } | null = null;
  /** How full the context window was at the model's last call. */
  context: Reading | null = null;
  background_tasks = new Inventory();
  children: Child[] = [];
  children_complete = false;
  subagents = { running: 0, blocked: 0, waiting: false };
  evidence = new SummaryText();
  name = new Name();
  request: Request;
  session: string;
  state: State;
  transcript = new Path();
  turn = new Turn();
  cwd = new Path();
  location: Location | null = null;
  outcome: "completed" | "interrupted" | "failed" | null = null;
  /** A thread the provider keeps no history of, such as a Codex `/btw` side conversation. */
  ephemeral = false;
  observed_at = Date.now() * 1000;
  updated_at = 0;
  constructor(request: Request, session: string, state: State) {
    this.request = request;
    this.session = session;
    this.state = state;
  }
}
