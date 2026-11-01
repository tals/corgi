//! What the prompt's attachments read where the daemon can give it: a pane's
//! recent screen and the workspace's uncommitted changes. The prompt card
//! and a Corgi pane share it, and the image on this machine's clipboard.
import * as subprocess from "./subprocess";
import { saveImage } from "./host_clipboard";
import { clean } from "./prompt_session";

/** The bytes a pane's screen and a selection keep, from their end. */
export const screen_bytes = 16 * 1024;
const diff_bytes = 32 * 1024;

/** The last `bytes` of `text`, whole lines, saying what was cut. */
export function tail(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  const kept = Buffer.from(text)
    .subarray(-bytes)
    .toString()
    .replace(/^[^\n]*\n/, "");
  return `(earlier lines cut)\n${kept}`;
}
/** A pane's last 80 lines as the daemon reads them, cleaned and cut. */
export async function paneScreen(call: (op: string, payload: object) => Promise<any>, pane: number): Promise<string> {
  const reply = await call("session.command", {
    command: { "pane.read": { target: pane, lines: 80n, view: "history" } },
  });
  return tail(clean(typeof reply?.result?.text === "string" ? reply.result.text : "", true).trimEnd(), screen_bytes);
}
/** `git diff` of `cwd` against HEAD, its stat first, cut at 32 KB. It runs
 * off the UI path, with a timeout. */
export async function workspaceDiff(cwd: string): Promise<string> {
  const git = async (args: string[]) => {
    const out = await subprocess.run(["git", "-C", cwd, "-c", "core.quotepath=false", ...args], {
      timeout_ms: 5000,
      max_output: 1024 * 1024,
      stderr: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    });
    if (!out.ok()) throw Error(out.stderr.toString().trim().split("\n")[0] || "GitFailed");
    return out.stdout.toString();
  };
  // A checkout without a commit yet has no HEAD to compare against.
  const against = await git(["rev-parse", "--verify", "-q", "HEAD"]).then(
    () => ["HEAD"],
    () => [],
  );
  const [stat, patch] = await Promise.all([git(["diff", "--stat", ...against]), git(["diff", ...against])]);
  if (!patch.trim()) return "No uncommitted changes.";
  const text = clean(`${stat.trimEnd()}\n\n${patch}`, true);
  if (Buffer.byteLength(text) <= diff_bytes) return text;
  const head = Buffer.from(text)
    .subarray(0, diff_bytes)
    .toString()
    .replace(/\n[^\n]*$/, "");
  return `${head}\n(diff cut at 32 KB)`;
}
/** The PNG on this machine's clipboard, saved in `folder`; null when it
 * holds none or there's no way to read it here. macOS hands it over as
 * AppleScript's hex «data PNGf…»; Wayland and X through their clipboard tools. */
export async function clipboardImage(folder: string, now: number): Promise<string | null> {
  const read = async (argv: string[]) => {
    try {
      const out = await subprocess.run(argv, { timeout_ms: 5000, max_output: 80 * 1024 * 1024 });
      return out.ok() ? out.stdout : null;
    } catch {
      return null;
    }
  };
  let png: Buffer | null = null;
  if (process.platform === "darwin") {
    const hex = (await read(["osascript", "-e", "the clipboard as «class PNGf»"]))?.toString() ?? "";
    const data = /«data PNGf([0-9A-Fa-f]+)»/.exec(hex)?.[1];
    if (data) png = Buffer.from(data, "hex");
  } else
    png =
      (await read(["wl-paste", "--no-newline", "--type", "image/png"])) ??
      (await read(["xclip", "-selection", "clipboard", "-t", "image/png", "-o"]));
  if (!png?.length) return null;
  try {
    return saveImage(folder, "image/png", png, now);
  } catch {
    return null;
  }
}
