import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { directory, customizations } from "./config";

const prefix = "corgi-agy-";
export function temporary() {
  return mkdtempSync(join(tmpdir(), prefix));
}
export function remove(root: string) {
  if (dirname(root) === tmpdir() && new RegExp("^" + prefix + "[a-zA-Z0-9]{6}$").test(basename(root)))
    rmSync(root, { recursive: true, force: true });
}
/** agy writes every conversation. A private home gives ephemeral clients their own history. */
export function create(account: string, inference: boolean) {
  const root = temporary();
  try {
    const data = directory(root),
      source = directory(account),
      workspace = join(root, "workspace");
    mkdirSync(data, { recursive: true });
    mkdirSync(workspace);
    const token = "antigravity-oauth-token";
    if (existsSync(join(source, token))) symlinkSync(join(source, token), join(data, token));
    if (!inference) {
      if (existsSync(join(source, "settings.json")))
        copyFileSync(join(source, "settings.json"), join(data, "settings.json"));
      if (existsSync(customizations(account))) symlinkSync(customizations(account), customizations(root));
    } else {
      const agents = join(customizations(root), "agents");
      mkdirSync(agents, { recursive: true });
      writeFileSync(
        join(agents, "corgi-summary.md"),
        "---\nname: corgi-summary\ndescription: Answer Corgi's text-only requests.\ntools: [finish]\nsubagent: false\n---\nRespond with the requested text.\n",
      );
      // agy gives even a restricted custom agent built-in task tools.
      writeFileSync(
        join(customizations(root), "hooks.json"),
        JSON.stringify({
          "Corgi private inference": {
            PreToolUse: [
              {
                matcher: "",
                hooks: [
                  { type: "command", command: `printf '%s\\n' '{"decision":"deny","reason":"Text-only inference"}'` },
                ],
              },
            ],
          },
        }),
      );
    }
    return root;
  } catch (e) {
    remove(root);
    throw e;
  }
}
