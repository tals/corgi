import * as fs from "node:fs";
import { Agent, Text } from "../../src/agents";
import { Tail } from "../../src/usage/worker";
import { adapter } from "../../src/providers";
import * as checklist from "../../src/activity/checklist";
import { clip } from "../../src/activity/tools";
import type { TranscriptReader } from "../../src/providers/adapter";
import type { Event, Provider } from "./history";

/** How the snapshot states what the user asked: as production does, or experiments on it. */
export type Requests = "latest" | "queued" | "list";
type Row = Record<string, any>;
const joined = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter(b => b?.type === "text" || b?.type === "input_text")
          .map(b => String(b.text ?? ""))
          .join("\n")
      : "";
/** A person's message in a transcript record; `queued` when Claude delivered it while the agent was working. */
export function human(value: unknown, provider: Provider): { text: string; queued: boolean } | null {
  const v = value as Row;
  if (!v || typeof v !== "object") return null;
  if (provider === "claude") {
    if (v.type === "attachment" && v.attachment?.type === "queued_command" && v.attachment.origin?.kind === "human")
      return { text: joined(v.attachment.prompt), queued: true };
    if (v.type !== "user" || v.isMeta || v.isCompactSummary) return null;
    const text = joined(v.message?.content);
    return text && !text.startsWith("<task-notification>") ? { text, queued: false } : null;
  }
  if (v.type !== "response_item" || v.payload?.type !== "message" || v.payload.role !== "user") return null;
  const text = joined(v.payload.content);
  return text ? { text, queued: false } : null;
}
const ends = (value: unknown) => {
  const v = value as Row;
  return (
    (v?.type === "system" && v.subtype === "turn_duration") ||
    (v?.type === "event_msg" && ["task_complete", "turn_complete", "turn_aborted"].includes(v.payload?.type))
  );
};
const outcomes = "Recent tool outcomes (oldest to newest):\n";

/** Replays the production readers, with only the observations available at each checkpoint. */
export class Signals {
  /** This turn's messages, oldest first; a message after the turn ended starts the list again. */
  asked: { text: string; queued: boolean }[] = [];
  ended = true;
  tail = new Tail();
  records: unknown[];
  cursor = 0;
  session = "";
  turn = 0;
  reader: TranscriptReader;
  constructor(
    readonly source: string,
    readonly provider: Provider,
    readonly requests: Requests = "latest",
  ) {
    this.reader = adapter(provider).transcript!.reader(() => []);
    this.records = fs
      .readFileSync(source, "utf8")
      .split("\n")
      .map(line => (line.trim() ? JSON.parse(line) : {}));
    const row = this.records.find(v => v && typeof v === "object" && ("sessionId" in v || "payload" in v)) as
      { sessionId?: string; payload?: { id?: string } } | undefined;
    this.session = row?.sessionId ?? row?.payload?.id ?? "synthetic";
  }
  batch(events: Event[]): Event[] {
    const agent = new Agent();
    agent.provider = this.provider;
    agent.session = new Text(this.session);
    agent.state = "working";
    const last = events.at(-1)!;
    if (last.turn !== this.turn) {
      this.turn = last.turn;
      this.tail.progress.bind(String(this.turn));
    }
    agent.setTurn(String(this.turn));
    const req = { actor: 1, workspace: 1, since: 0, child: false, tracked_since: 0, agent };
    while (this.cursor < last.line) {
      const value = this.records[this.cursor++];
      const message = human(value, this.provider);
      if (message) {
        if (this.ended) this.asked = [];
        this.ended = false;
        this.asked.push(message);
      } else if (ends(value)) this.ended = true;
      this.reader.record(this.tail, req, value, true, null);
    }
    const progress = this.tail.progress.view(),
      list = this.tail.checklist ?? new checklist.List();
    // The same heading the daemon writes, so a finished turn reads as it does live.
    const ended = last.kind === "lifecycle" && /task_complete|turn_complete|turn_duration/.test(last.text);
    const text =
      `Turn ${this.turn}; lifecycle: ${ended ? "idle" : "working"}\n` +
      clip(progress.evidence.text() + progress.commentary.text(), 2048) +
      "\n" +
      this.road(progress.road_evidence.text()) +
      "\nTODO snapshot: " +
      JSON.stringify(list);
    return events.map(e => ({
      ...e,
      kind: "assistant",
      text: e.id === last.id ? clip(text, 6000) : "[Observed only through the interval snapshot below]",
    }));
  }
  /** The request line as the experiment words it; the tool outcomes stay as the daemon wrote them. */
  road(text: string) {
    if (this.requests === "latest" || !this.asked.length) return text;
    const at = text.indexOf(outcomes),
      rest = at < 0 ? "" : text.slice(at);
    if (this.requests === "queued") return `User request: ${clip(this.asked.at(-1)!.text, 512)}\n${rest}`;
    const shown = this.asked.slice(-4);
    if (shown.length === 1) return `User request: ${clip(shown[0].text, 512)}\n${rest}`;
    return (
      "User requests this turn (oldest to newest):\n" +
      shown
        .map(
          (m, i) =>
            `${i + 1}. ${clip(m.text, 300).replace(/\s+/g, " ")}${m.queued ? " [sent while the agent was working]" : ""}\n`,
        )
        .join("") +
      rest
    );
  }
}
