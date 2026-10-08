//! Released pure JSON migrations, mirrored from persist/steps.zig.
class RawBytes extends String {
  constructor(public bytes: Buffer) {
    super(bytes.toString("utf8"));
  }
  toJSON() {
    return [...this.bytes];
  }
}
export type Step = (value: any) => void;
export function object(value: any): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("InvalidCheckpoint");
  return value;
}
function items(value: any, key: string): any[] {
  const field = object(value)[key];
  if (field === undefined) return [];
  if (!Array.isArray(field)) throw Error("InvalidCheckpoint");
  return field;
}
function integer(value: any, max = Number.MAX_SAFE_INTEGER): number {
  if (
    (typeof value !== "number" && typeof value !== "bigint") ||
    value < 0 ||
    value > max ||
    (typeof value === "number" && !Number.isInteger(value))
  )
    throw Error("InvalidCheckpoint");
  return Number(value);
}
export function fixedText(bytes: any = "", len: any = 0): string | RawBytes {
  const n = integer(len);
  let buffer: Buffer;
  if (typeof bytes === "string") buffer = Buffer.from(bytes);
  else if (Array.isArray(bytes))
    buffer = Buffer.from(bytes.map((byte) => integer(byte, 255)));
  else throw Error("InvalidCheckpoint");
  if (n > buffer.length) throw Error("InvalidCheckpoint");
  const selected = buffer.subarray(0, n);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(selected);
  } catch {
    return new RawBytes(selected);
  }
}
function paired(fields: any, key: string, len: string) {
  if (!(key in fields)) return;
  fields[key] = fixedText(fields[key], fields[len]);
  delete fields[len];
}
function wrapped(fields: any, key: string) {
  if (!(key in fields) || fields[key] === null) return;
  const saved = object(fields[key]);
  fields[key] = fixedText(saved.bytes, saved.len);
}
function byProvider(fields: any, key: string, tag: string) {
  if (!(key in fields)) return;
  const list = fields[key];
  if (!Array.isArray(list) || list.length > 2) throw Error("InvalidCheckpoint");
  fields[key] = Object.fromEntries(
    list.map((item, i) => {
      if (tag === "object") object(item);
      else if (tag === "integer") integer(item);
      else if (typeof item !== tag) throw Error("InvalidCheckpoint");
      return [["codex", "claude"][i], item];
    }),
  );
}
function table(value: any) {
  const fields = object(value);
  if (!("conversations" in fields)) fields.conversations = [];
  if (!("next_conversation" in fields)) fields.next_conversation = 1;
}
function optionalProvider(value: any, key: string) {
  const fields = object(value);
  if (!(key in fields)) return;
  const field = object(fields[key]);
  if (field.provider === "other") field.provider = null;
}
function identity(agent: any): { provider: string; session: string } | null {
  const fields = object(agent);
  if (fields.provider === undefined || fields.provider === null) return null;
  if (typeof fields.provider !== "string") throw Error("InvalidCheckpoint");
  const len = integer(fields.session_len ?? 0);
  if (len === 0) return null;
  return {
    provider: fields.provider,
    session: JSON.stringify(fixedText(fields.session, len)),
  };
}
function promote(value: any) {
  table(value);
  for (const collection of ["panes", "sessions"])
    for (const entry of items(value, collection)) {
      const fields = object(entry);
      if (fields.binding !== undefined && fields.binding !== null) continue;
      let legacy: any;
      if (collection === "panes") legacy = structuredClone(fields.agent ?? {});
      else {
        legacy = {};
        for (const key of ["provider", "state", "attention", "observation"])
          if (key in fields) legacy[key] = structuredClone(fields[key]);
        if ("resume_hint" in fields) {
          const hint = object(fields.resume_hint);
          if ("session" in hint) legacy.session = structuredClone(hint.session);
          if ("len" in hint) legacy.session_len = hint.len;
        }
      }
      const id = identity(legacy);
      if (!id) {
        fields.binding = { provisional: legacy };
        continue;
      }
      const actors = items(value, "conversations");
      let actor = actors.find((candidate) => {
        const saved = object(candidate);
        if (!("agent" in saved)) throw Error("InvalidCheckpoint");
        const other = identity(saved.agent);
        return other?.provider === id.provider && other.session === id.session;
      });
      let actorId: number;
      if (actor) {
        actorId = integer(actor.id, 0xffffffff);
        if (!actorId) throw Error("InvalidCheckpoint");
      } else {
        actorId = integer(value.next_conversation, 0xfffffffe);
        if (!actorId) throw Error("InvalidCheckpoint");
        value.next_conversation = actorId + 1;
        actors.push({ id: actorId, agent: legacy });
      }
      fields.binding = { actor: actorId, generation: 2, known: [actorId] };
    }
}
function checkpoint2To3(value: any) {
  for (const collection of ["panes", "sessions"])
    for (const entry of items(value, collection)) {
      if (collection === "panes") optionalProvider(entry, "agent");
      optionalProvider(entry, "resume_hint");
      if (entry.binding !== undefined && entry.binding !== null)
        optionalProvider(entry.binding, "provisional");
    }
  for (const actor of items(value, "conversations"))
    optionalProvider(actor, "agent");
  for (const command of items(value, "agent_commands"))
    optionalProvider(command, "semantics");
  promote(value);
}
function checkpoint3To4(value: any) {
  for (const command of items(value, "agent_commands")) {
    try {
      const info = object(object(command).semantics),
        mode = object(info.mode);
      if (
        mode.len === 23 &&
        fixedText(mode.bytes, mode.len) === "Skips permission checks"
      )
        info.yolo = true;
    } catch {}
  }
}
function agentText(agent: any) {
  const fields = object(agent);
  for (const key of [
    "name",
    "transcript",
    "turn",
    "last_finished_turn",
    "recent",
    "session",
    "activity",
    "tool",
    "cwd",
  ])
    paired(fields, key, key + "_len");
}
function recentText(recent: any) {
  const fields = object(recent);
  const entries = items(recent, "recent");
  for (let i = 0; i < entries.length; i++) {
    const box = { text: entries[i] };
    wrapped(box, "text");
    entries[i] = box.text;
  }
  wrapped(fields, "previous");
}
function checkpoint4To5(value: any) {
  for (const actor of items(value, "conversations")) {
    const fields = object(actor);
    if ("agent" in fields) agentText(fields.agent);
    if ("status_inference" in fields) recentText(fields.status_inference);
  }
  for (const collection of ["panes", "sessions"])
    for (const entry of items(value, collection)) {
      const fields = object(entry);
      if (fields.binding !== undefined && fields.binding !== null) {
        const binding = object(fields.binding);
        if ("provisional" in binding) agentText(binding.provisional);
      }
      if ("resume_hint" in fields) {
        const hint = object(fields.resume_hint);
        paired(hint, "name", "name_len");
        paired(hint, "session", "len");
      }
    }
  for (const pane of items(value, "panes")) {
    delete object(pane).agent;
    wrapped(pane, "label");
  }
  for (const pane of items(value, "closed")) wrapped(object(pane), "label");
  if ("link_labels" in object(value))
    for (const entry of items(value.link_labels, "entries"))
      if (entry !== null) wrapped(object(entry), "name");
  for (const command of items(value, "agent_commands")) {
    const fields = object(command);
    paired(fields, "bytes", "len");
    if ("bytes" in fields) {
      fields.command = fields.bytes;
      delete fields.bytes;
    }
    paired(fields, "original", "original_len");
    wrapped(fields, "name");
    if ("semantics" in fields)
      for (const key of ["suggested_name", "model", "account", "mode"])
        wrapped(object(fields.semantics), key);
  }
  byProvider(value, "agent_yolo", "boolean");
  byProvider(value, "agent_hidden", "boolean");
}
function handoff1To2(value: any) {
  const summaries = object(value).summaries;
  if (summaries === undefined || summaries === null) return;
  const launches = object(summaries).launches;
  if (launches === undefined) return;
  const fields = object(launches);
  if (!("count" in fields))
    fields.count = { values: [fields.codex ?? 0, fields.claude ?? 0] };
  delete fields.codex;
  delete fields.claude;
}
function handoff2To3(value: any) {
  for (const client of items(value, "clients")) {
    const saved = object(client).launch_preview;
    if (saved === undefined || saved === null) continue;
    const preview = object(saved).preview;
    if (preview === undefined) continue;
    for (const option of items(preview, "options")) {
      const fields = object(option);
      if (fields.usage_metered === true) fields.limits = { metered: {} };
      delete fields.usage;
      delete fields.usage_metered;
      delete fields.resets;
    }
  }
}
function requestText(request: any) {
  const fields = object(request);
  for (const key of ["session", "turn", "name"])
    paired(fields, key, key + "_len");
  wrapped(fields, "evidence");
  if ("conversation" in fields) recentText(fields.conversation);
}
function slotText(slot: any) {
  const fields = object(slot);
  if ("request" in fields) requestText(fields.request);
  wrapped(fields, "commentary");
  wrapped(fields, "tool_evidence");
  if (fields.result === undefined || fields.result === null) return;
  const result = object(fields.result);
  if ("request" in result) requestText(result.request);
  wrapped(result, "label");
}
function handoff3To4(value: any) {
  const summaries = object(value).summaries;
  if (summaries !== undefined && summaries !== null) {
    const fields = object(summaries);
    if ("launches" in fields) {
      const launches = object(fields.launches);
      if ("count" in launches) {
        const count = object(launches.count);
        if (!("values" in count)) throw Error("InvalidCheckpoint");
        launches.count = count.values;
        byProvider(launches, "count", "integer");
      }
    }
    for (const entry of items(summaries, "slots"))
      if ("slot" in object(entry)) slotText(entry.slot);
    for (const result of items(summaries, "link_results"))
      if (result !== null) wrapped(object(result), "name");
  }
  for (const client of items(value, "clients")) {
    const saved = object(client).launch_preview;
    if (saved === undefined || saved === null) continue;
    const fields = object(saved);
    paired(fields, "cwd", "len");
    if (!("preview" in fields)) continue;
    for (const option of items(fields.preview, "options"))
      for (const key of ["model", "source", "account", "plan", "usage_error"])
        wrapped(object(option), key);
    byProvider(fields.preview, "options", "object");
    byProvider(fields.preview, "installed", "boolean");
  }
}
export const checkpoint: Step[] = [
  table,
  checkpoint2To3,
  checkpoint3To4,
  checkpoint4To5,
];
export const handoff: Step[] = [handoff1To2, handoff2To3, handoff3To4];
