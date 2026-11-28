import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { Reading } from "../../usage/context_window";
import type { IntegrationStepResult } from "../adapter";
import { field, number, str } from "../common";
import * as hooksFile from "../hooks_file";
import { Model } from "../model";
import { directory, validSession } from "./config";

/** agy's percentage describes the current window. Its total token counters span the whole conversation. */
export function context(v: unknown) {
  const session = str(v, "conversation_id");
  if (!validSession(session)) return null;
  const data = field(v, "context_window"),
    window = number(data, "context_window_size"),
    pct = field(data, "used_percentage");
  if (
    !window ||
    window > BigInt(Number.MAX_SAFE_INTEGER) ||
    typeof pct !== "number" ||
    !Number.isFinite(pct) ||
    pct < 0 ||
    pct > 100 ||
    (pct === 0 && !field(data, "current_usage"))
  )
    return null;
  const reading = new Reading();
  reading.model = Model.resolve(str(field(v, "model"), "id"));
  reading.window = window;
  reading.used = BigInt(Math.round((Number(window) * pct) / 100));
  return { session, reading };
}

const command = hooksFile.command("antigravity");
const reporter = { type: "command", command, stack_with_default: true };
export function integration(op: "install" | "uninstall" | "status", account: string): IntegrationStepResult[] {
  const dir = directory(account),
    file = new hooksFile.File("antigravity", dir, "settings.json", []),
    base = { item: "context meter", path: file.path };
  try {
    if (!existsSync(dir)) {
      if (op !== "install") return [{ ...base, outcome: "no_config" }];
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    let outcome: IntegrationStepResult["outcome"] = "absent";
    const change = (text: string) => {
      const root = JSON.parse(text.replace(/^\uFEFF/, ""));
      if (!root || typeof root !== "object" || Array.isArray(root)) throw Error("InvalidSettings");
      if (root.statusLine === undefined) {
        outcome = op === "install" ? "added" : "absent";
        if (op !== "install") return null;
        root.statusLine = reporter;
      } else if (str(root.statusLine, "command") === command) {
        outcome = op === "uninstall" ? "removed" : field(root.statusLine, "enabled") === false ? "partial" : "present";
        if (op !== "uninstall") return null;
        delete root.statusLine.command;
        if (root.statusLine.type === reporter.type) delete root.statusLine.type;
        if (root.statusLine.stack_with_default === true) delete root.statusLine.stack_with_default;
        if (!Object.keys(root.statusLine).length) delete root.statusLine;
      } else {
        outcome = op === "uninstall" ? "absent" : "partial";
        return null;
      }
      return JSON.stringify(root, null, 2);
    };
    if (op === "status") change(existsSync(file.path) ? readFileSync(file.path, "utf8") : "{}");
    else file.edit(change, op === "install");
    return [{ ...base, outcome }, ...(op === "uninstall" ? file.cleanup([file.path + ".corgi-backup"]) : [])];
  } catch (error) {
    return [hooksFile.failed(base.item, file.path, error)];
  }
}
