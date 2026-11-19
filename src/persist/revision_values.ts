//! JSON operations shared by saved-state revisions.
class RawBytes extends String {
  constructor(public bytes: Buffer) {
    super(bytes.toString("utf8"));
  }
  toJSON() {
    return [...this.bytes];
  }
}
export function object(value: any): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("InvalidCheckpoint");
  return value;
}
export function items(value: any, key: string): any[] {
  const field = object(value)[key];
  if (field === undefined) return [];
  if (!Array.isArray(field)) throw Error("InvalidCheckpoint");
  return field;
}
export function integer(value: any, max = Number.MAX_SAFE_INTEGER): number {
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
  else if (Array.isArray(bytes)) buffer = Buffer.from(bytes.map(byte => integer(byte, 255)));
  else throw Error("InvalidCheckpoint");
  if (n > buffer.length) throw Error("InvalidCheckpoint");
  const selected = buffer.subarray(0, n);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(selected);
  } catch {
    return new RawBytes(selected);
  }
}
export function paired(fields: any, key: string, len: string) {
  if (!(key in fields)) return;
  fields[key] = fixedText(fields[key], fields[len]);
  delete fields[len];
}
export function wrapped(fields: any, key: string) {
  if (!(key in fields) || fields[key] === null) return;
  const saved = object(fields[key]);
  fields[key] = fixedText(saved.bytes, saved.len);
}
export function byProvider(fields: any, key: string, tag: string) {
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
export function optionalProvider(value: any, key: string) {
  const fields = object(value);
  if (!(key in fields)) return;
  const field = object(fields[key]);
  if (field.provider === "other") field.provider = null;
}
export function identity(agent: any): { provider: string; session: string } | null {
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
export function promote(value: any) {
  const fields = object(value);
  if (!("conversations" in fields)) fields.conversations = [];
  if (!("next_conversation" in fields)) fields.next_conversation = 1;
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
      let actor = actors.find(candidate => {
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
export function agentText(agent: any) {
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
export function recentText(recent: any) {
  const fields = object(recent);
  const entries = items(recent, "recent");
  for (let i = 0; i < entries.length; i++) {
    const box = { text: entries[i] };
    wrapped(box, "text");
    entries[i] = box.text;
  }
  wrapped(fields, "previous");
}
export function joined(first: any = "", second: any = "") {
  if (typeof first !== "string" || typeof second !== "string") throw Error("InvalidCheckpoint");
  return Buffer.concat([Buffer.from(first, "base64"), Buffer.from(second, "base64")]).toString("base64");
}
export function client(fields: any, state: Record<string, unknown>) {
  fields.client = {
    state: {
      pid: fields.pid ?? -1,
      input: fields.input ?? "",
      output: joined(fields.output, fields.deferred),
      exited: fields.exited === true,
      ready: fields.ready === true,
      ...state,
    },
    handles: [fields.stdin ?? -1, fields.stdout ?? -1].every(fd => fd >= 0) ? [fields.stdin, fields.stdout] : [],
  };
  for (const key of ["pid", "stdin", "stdout", "input", "output", "deferred"]) delete fields[key];
}
export function requestText(request: any) {
  const fields = object(request);
  for (const key of ["session", "turn", "name"]) paired(fields, key, key + "_len");
  wrapped(fields, "evidence");
  if ("conversation" in fields) recentText(fields.conversation);
}
export function slotText(slot: any) {
  const fields = object(slot);
  if ("request" in fields) requestText(fields.request);
  wrapped(fields, "commentary");
  wrapped(fields, "tool_evidence");
  if (fields.result === undefined || fields.result === null) return;
  const result = object(fields.result);
  if ("request" in result) requestText(result.request);
  wrapped(result, "label");
}
