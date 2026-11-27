import { Call, Tracker, clip } from "../../activity/tools";
import { Text } from "../../activity/summary";
import { field, str } from "../common";
import { messageText } from "./worker";

/** Tool inputs describe the work; results and edit bodies stay out of summaries. */
function describe(part: unknown) {
  const call = new Call(),
    input = field(field(part, "state"), "input");
  call.describe(str(input, "description") || str(input, "title"));
  call.append(str(part, "name") + ": ");
  const patch = str(input, "patchText");
  if (patch) {
    const start = Buffer.byteLength(call.text());
    call.patchFiles(patch);
    call.bound(start, false);
    return call;
  }
  const detail = ["description", "command", "query", "pattern"].map(key => str(input, key)).find(Boolean),
    path = str(input, "path") || str(input, "url");
  if (detail || path) call.detail([detail, path].filter(Boolean).join(" "));
  else if (str(input, "code")) {
    if (!call.script(str(input, "code"))) call.detail(str(input, "code"));
  } else call.detail(str(input, "id"));
  return call;
}

/** Only the current turn contributes work, even when its latest message has no text. */
export function progress(messages: Record<string, unknown>[]) {
  const start = messages.findLastIndex(m => m.type === "user");
  const tools = new Tracker();
  if (start < 0) return { calls: [], evidence: new Text() };
  let latest = "";
  for (const message of messages.slice(start + 1)) {
    if (message.type !== "assistant") continue;
    latest = messageText(message) || latest;
    const parts = field(message, "content");
    for (const part of Array.isArray(parts) ? parts : []) {
      if (str(part, "type") !== "tool") continue;
      const state = field(part, "state"),
        status = str(state, "status");
      if (status === "streaming") continue;
      const call = describe(part);
      call.id = tools.key(str(part, "id"));
      if (status === "completed" || status === "error" || typeof field(field(part, "time"), "completed") === "number") {
        call.outcome = status === "error" ? "failure" : status === "completed" ? "success" : null;
        tools.finish(call, true);
      } else tools.save(call, true);
    }
  }
  const view = tools.view();
  const work = clip(view.evidence.text(), 1200),
    update = latest ? "Latest agent update: " + clip(latest, 600) + "\n" : "",
    request = "User request: " + messageText(messages[start]);
  return {
    calls: view.calls,
    evidence: new Text(clip(work + (work && !work.endsWith("\n") ? "\n" : "") + update + request, 2048)),
  };
}
