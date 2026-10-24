import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { configHome } from "../common";
import type { IntegrationStepResult } from "../adapter";
import { atomicWrite } from "../../os";
import source from "./extension.txt" with { type: "text" };
// omp reads Pi's variable for its agent folder.
export const configDir = (env = process.env) => configHome(env, "PI_CODING_AGENT_DIR", ".omp/agent");
export const directory = (account = "") => account || configDir();
export { source };
export function extension(op: "install" | "status" | "uninstall", account = ""): IntegrationStepResult {
  const root = directory(account),
    path = join(root, "extensions", "corgi.js");
  const result: IntegrationStepResult = { item: "hooks", path, outcome: "absent" };
  try {
    if (!existsSync(root) && op !== "install") return { ...result, path: root, outcome: "no_config" };
    let old: string | null = null;
    if (existsSync(path)) {
      if (!lstatSync(path).isFile()) throw Error("NotRegular");
      old = readFileSync(path, "utf8");
      if (!old.startsWith("// Corgi's omp integration.")) throw Error("ExtensionAlreadyExists");
    }
    if (op === "status") return { ...result, outcome: old === source ? "present" : old ? "partial" : "absent" };
    if (existsSync(join(root, "extensions")) && lstatSync(join(root, "extensions")).isSymbolicLink())
      throw Error("SharedExtensionsDirectory");
    if (op === "uninstall") {
      if (old !== null) unlinkSync(path);
      return { ...result, outcome: old !== null ? "removed" : "absent" };
    }
    if (old === source) return { ...result, outcome: "present" };
    if (old !== null) atomicWrite(path + ".corgi-backup", old, 0o600, false);
    atomicWrite(path, source, 0o600, false);
    return { ...result, outcome: "added" };
  } catch (e) {
    return { ...result, outcome: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}
