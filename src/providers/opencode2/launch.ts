import type { Progress } from "../../startup";
import { API, data, model, modelRef, validSession } from "./api";
import { str } from "../common";
import { resolve } from "node:path";
import { statSync } from "node:fs";
const CLI_CONFIG = "OPENCODE_CLI_CONFIG_CONTENT";
/** Corgi owns the session list, so hide OpenCode's tabs and details sidebar
 * unless the user set the inline CLI config. */
function environment(): [string, string][] {
  return process.env[CLI_CONFIG] === undefined
    ? [[CLI_CONFIG, JSON.stringify({ session: { sidebar: "hide" }, tabs: { mode: "off" } })]]
    : [];
}
/** Corgi-only options are consumed here, before the UI sees them. */
export async function prepare(args: string[], executable: string, progress?: Progress) {
  if (
    args.some(v => ["--help", "-h", "--version", "-v", "--wizard", "--completions"].includes(v)) ||
    [
      "upgrade",
      "update",
      "uninstall",
      "acp",
      "api",
      "debug",
      "auth",
      "mcp",
      "plugin",
      "models",
      "stats",
      "mini",
      "run",
      "session",
      "service",
      "reload",
      "pair",
      "serve",
    ].includes(args[0])
  )
    return { args };
  const kept: string[] = [];
  let session = "",
    fork = "",
    name = "",
    chosen = "",
    continuing = false,
    cwd = process.cwd();
  for (let i = 0; i < args.length; i++) {
    const word = args[i],
      [flag, inline] = word.split(/=(.*)/s);
    const value = () => {
      const v = inline ?? args[++i];
      if (!v || v.startsWith("--")) throw Error("MissingArgument");
      return v;
    };
    switch (flag) {
      case "--session":
      case "-s":
        session = value();
        break;
      case "--corgi-fork":
        fork = value();
        break;
      case "--corgi-name":
        name = value();
        break;
      case "--model":
      case "-m":
        chosen = value();
        break;
      case "--server":
        throw Error("OpenCodeRemoteUnsupported");
      case "--continue":
      case "-c":
        continuing = true;
        break;
      case "--standalone":
        throw Error("OpenCodeStandaloneUnsupported");
      case "--prompt":
      case "--log-level":
        kept.push(flag, value());
        break;
      case "--auto":
      case "--print-logs":
        kept.push(word);
        break;
      default:
        if (word.startsWith("-")) throw Error("UnsupportedOpenCodeFlag");
        cwd = resolve(process.cwd(), word);
        if (!statSync(cwd).isDirectory()) throw Error("InvalidDirectory");
        kept.push(word);
    }
  }
  const api = new API(executable, cwd, true, progress);
  if (continuing && !session) {
    const history = await api.sessions("&parentID=null&directory=" + encodeURIComponent(cwd), () => false);
    session = str(history.entries[0], "id");
  }
  if ((session && !validSession(session)) || (fork && !validSession(fork))) throw Error("InvalidSession");
  const info = fork
    ? data(await api.call("POST", `/api/session/${fork}/fork`, {}))
    : session
      ? data(await api.call("GET", `/api/session/${session}`))
      : data(
          await api.call("POST", "/api/session", {
            location: { directory: cwd },
            ...(chosen ? { model: modelRef(chosen) } : {}),
          }),
        );
  session = str(info, "id");
  if (!validSession(session)) throw Error("BadOpenCodeResponse");
  if (name) await api.call("PATCH", `/api/session/${session}`, { title: name });
  if (chosen && (fork || args.some(a => a === "--session" || a === "-s" || a.startsWith("--session=")) || continuing))
    await api.call("POST", `/api/session/${session}/model`, { model: modelRef(chosen) });
  return {
    args: [...kept, "--session", session],
    env: environment(),
    event: {
      hook_event_name: "SessionStart",
      session_id: session,
      cwd: str(info.location, "directory") || cwd,
      model: chosen || model(info.model),
      permission_mode: kept.includes("--auto") ? "bypassPermissions" : "default",
    },
  };
}
