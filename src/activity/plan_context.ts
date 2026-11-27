import * as protocol from "./plan_protocol";
import type { State } from "./plan";
import type { Input } from "./roadmap";
import type { Request } from "../inference/harness";
import type { Tokens } from "../usage/live";
import * as text from "../text";

const signature = (state: State) => JSON.stringify([state.through, state.nodes]);

function hint(reason: string) {
  switch (reason) {
    case "RewrittenFailure":
      return "A failed STEP stays failed permanently, including one marked failed earlier in this response. Remove active/done state edits on that attempt. Use resolve for recovery; create a NEW step for the successful retry and assign its work there.";
    case "InvalidEvidence":
      return "Use one positive observed event ID for each work/note/skip endpoint. Do not output citations or event-ID lists for edits.";
    case "InvalidSubtitle":
    case "InvalidBump":
      return "Every new node needs a nonempty subtitle. Subtitles and setback details must be one line, at most 120 characters; aim below 90.";
    case "InvalidTitle":
      return "Titles must contain 2-7 words and at most 64 characters.";
    case "InvalidCreation":
      return "Use new only for IDs absent from accepted. Change an existing node with state/sub/title instead of recreating it.";
    case "InvalidCoverage":
    case "IncompleteCoverage":
      return "Each work/note/skip takes ONE integer endpoint. Cover the supplied range exactly once in increasing order; the final endpoint must equal range[1].";
    case "InvalidOperation":
      return "Return one complete BEGIN_PLAN block. No second block, code fences or closing commentary. Every line must follow the command grammar.";
    default:
      return "Follow the validation rules in the system instructions.";
  }
}

/** Accepted state is authoritative. Missing conversations always receive a complete seed. */
export class Context {
  constructor(
    private readonly wire: Pick<Request, "instructions" | "schema"> & {
      encode?: (input: protocol.Envelope) => string;
      hint?: (reason: string) => string;
      repeat?: "focused";
      support?: "active";
    } = protocol,
    private readonly budget: { tokens: number; turns: number } | null = null,
  ) {}
  private encode(input: protocol.Envelope) {
    return (this.wire.encode ?? protocol.encode)(input);
  }
  private input(input: Input): Input {
    if (this.wire.support !== "active") return input;
    const byId = new Map(input.state.nodes.map(n => [n.id, n])),
      kept = new Set(input.support.slice(-8).map(e => e.id));
    let id = protocol.focus(input);
    while (id) {
      const node = byId.get(id);
      if (!node) break;
      for (const event of node.evidence) kept.add(event);
      id = node.parent;
    }
    for (const node of input.state.nodes)
      if (node.bump?.state === "open") for (const event of node.bump.evidence) kept.add(event);
    return { ...input, support: input.support.filter(e => kept.has(e.id)) };
  }
  private previous: Input | null = null;
  private expected = "";
  private key = "";
  private turns = 0;
  private used: bigint | null = null;
  invalidate() {
    this.previous = null;
  }
  prepare(input: Input): Request {
    input = this.input(input);
    if (!this.previous || this.expected !== signature(input.state) || this.turns >= (this.budget?.turns ?? 16)) {
      this.previous = null;
      this.key = "plan:" + crypto.randomUUID();
      this.turns = 0;
      this.used = null;
    }
    const fresh = this.encode(protocol.envelope(input));
    let content = fresh;
    if (this.previous) {
      const nodes = new Map(this.previous.state.nodes.map(n => [n.id, JSON.stringify(n)])),
        support = new Map([...this.previous.support, ...this.previous.events].map(e => [e.id, e.text]));
      const changed = input.state.nodes.filter(n => n.bump?.state === "open" || nodes.get(n.id) !== JSON.stringify(n));
      let updates: State["nodes"];
      if (this.wire.repeat === "focused") {
        const byId = new Map(input.state.nodes.map(n => [n.id, n])),
          included = new Set(changed.map(n => n.id)),
          focus = protocol.focus(input);
        if (focus) included.add(focus);
        for (const id of included) {
          const parent = byId.get(id)?.parent;
          if (parent) included.add(parent);
        }
        updates = input.state.nodes.filter(n => included.has(n.id));
      } else {
        const included = new Set(changed.map(n => n.id));
        updates = input.state.nodes.filter(n => n.kind !== "step" || included.has(n.id));
      }
      const notes = protocol.notes(input);
      content = this.encode({
        ...(notes.length ? { notes } : {}),
        tree_updates: updates.map(protocol.node),
        support: input.support.filter(e => !support.get(e.id)?.startsWith(e.text)).map(protocol.event),
        focus: protocol.focus(input),
        range: [input.events[0].id, input.events.at(-1)!.id],
        events: input.events.map(protocol.event),
      });
    }
    // Use observed prior usage plus a conservative byte bound for the next delta.
    // Leave headroom for provider framing below Haiku's 100k price boundary.
    if (
      this.budget &&
      this.used !== null &&
      this.used + BigInt(text.byteLength(content)) > BigInt(this.budget.tokens)
    ) {
      this.previous = null;
      this.key = "plan:" + crypto.randomUUID();
      this.turns = 0;
      this.used = null;
      content = fresh;
    }
    return {
      instructions: this.wire.instructions,
      schema: this.wire.schema,
      content,
      fresh_content: fresh,
      conversation: this.key,
    };
  }
  accept(input: Input, state: State, usage?: Pick<Tokens, "input" | "output">) {
    this.previous = structuredClone(this.input(input));
    this.expected = signature(state);
    this.turns++;
    this.used = usage ? usage.input + usage.output : null;
  }

  retry(input: Input, rejected: string, reason: string, usage: Pick<Tokens, "input" | "output">): Request {
    input = this.input(input);
    const correction = `The previous response was rejected atomically: ${reason}. ${(this.wire.hint ?? hint)(reason)} NONE of its edits or assignments were applied. accepted lists the unchanged authoritative nodes; never recreate those IDs. Replace the ENTIRE response for events ${input.events[0].id} through ${input.events.at(-1)!.id}, using the original evidence still in this conversation. Return only the corrected operations.`,
      content = this.encode({
        correction,
        accepted: input.state.nodes.map(protocol.node),
        range: [input.events[0].id, input.events.at(-1)!.id],
        focus: protocol.focus(input),
        support: [],
        events: [],
      }),
      fresh = this.encode({ ...protocol.envelope(input), correction, rejected });
    this.turns++;
    this.used = usage.input + usage.output;
    if (
      this.turns >= (this.budget?.turns ?? 16) ||
      (this.budget && this.used + BigInt(text.byteLength(content)) > BigInt(this.budget.tokens))
    ) {
      this.invalidate();
      return { ...this.prepare(input), content: fresh, fresh_content: fresh };
    }
    return {
      instructions: this.wire.instructions,
      schema: this.wire.schema,
      content,
      fresh_content: fresh,
      conversation: this.key,
    };
  }
}

export const priceBudget = { tokens: 90_000, turns: 16 };
