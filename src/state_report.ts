//! What Corgi shows when a saved session didn't load cleanly: a release
//! turned it down before an update, or a load repaired it. Either is a bug,
//! so it apologizes, shows the report and a link to file it, and plays
//! fleas until the user types y.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as animation from "./corgi_animation";
import * as bugReport from "./bug_report";
import * as json from "./json";

export type Failure = {
  error: string;
  why: string | null;
  frames: string[];
  state: { summary: string; items: string[]; repairs: string[]; recent: string[]; anonymized: string };
};
/** A report as `__update-check` or a repair record wrote it, with defaults for what's missing. */
export function failure(value: any): Failure {
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []),
    text = (v: unknown, otherwise: string) => (typeof v === "string" ? v : otherwise);
  return {
    error: text(value?.error, "unknown"),
    why: typeof value?.why === "string" ? value.why : null,
    frames: strings(value?.frames),
    state: {
      summary: text(value?.state?.summary, "not described"),
      items: strings(value?.state?.items),
      repairs: strings(value?.state?.repairs),
      recent: strings(value?.state?.recent),
      anonymized: text(value?.state?.anonymized, "null"),
    },
  };
}
/** Shows the repaired session the daemon on `socket` recorded, if there's one; once. */
export async function showRepairs(socket: string): Promise<void> {
  const recorded = (await import("./persist/recovery")).takeRepairs(socket);
  if (recorded) await show({ kind: "repaired", release: recorded.release }, failure(recorded.report));
}
/** What happened: `candidate` couldn't load what `current` saved, so the
 * update didn't happen; or `release` repaired what it loaded. */
export type Event =
  { kind: "turned_down"; current: string; candidate: string; running: boolean } | { kind: "repaired"; release: string };

/** The anonymized saved state with what happened to it, so it reads on its own once attached. */
export function attachment(e: Event, f: Failure, space?: number): string {
  let checkpoint: unknown = null;
  try {
    checkpoint = json.parse(f.state.anonymized);
  } catch {}
  const what =
    e.kind === "turned_down"
      ? { written_by: e.current, checked_by: e.candidate, failed_check: f.why ?? f.error }
      : { repaired_by: e.release };
  return json.stringify(
    {
      report: {
        ...what,
        ...(f.state.repairs.length ? { repairs: f.state.repairs } : {}),
        anonymized:
          "private text is a token, the same wherever the same value appears; fields at their default and launcher settings are left out; times are seconds before the save",
      },
      checkpoint,
    },
    space,
  );
}
/** Writes the anonymized saved state to attach to the issue, as ssh-agent
 * keeps its socket: in a new folder in the temp dir that only this user can
 * open, never over a file that's there. Its path, or null. */
function writeState(e: Event, f: Failure): string | null {
  try {
    const path = join(mkdtempSync(join(tmpdir(), "corgi-session-")), "saved_session.anonymized.json");
    writeFileSync(path, attachment(e, f, 1) + "\n", { mode: 0o600, flag: "wx" });
    return path;
  } catch {
    return null;
  }
}
/** The report, as it goes in the issue. */
export function report(e: Event, f: Failure): string {
  const list = (title: string, lines: string[]) => (lines.length ? [title, ...lines.map(line => `  - ${line}`)] : []);
  const head =
    e.kind === "turned_down"
      ? [
          `${e.candidate} couldn't load the session ${e.current} saved, so the update didn't happen.`,
          "",
          `- Failed check: ${f.why ?? `not named (${f.error}${f.frames.length ? `, in ${f.frames.join(" < ")}` : ""})`}`,
          `- Update: ${e.current} → ${e.candidate}`,
        ]
      : [`${e.release} repaired the session it loaded.`, "", ...list("- Repaired:", f.state.repairs)];
  return [
    ...head,
    `- This build: ${bugReport.build()}`,
    `- Saved state: ${f.state.summary}`,
    ...list("- Panes and sessions:", f.state.items),
    ...(e.kind === "turned_down" ? list("- Repaired while loading, before the check failed:", f.state.repairs) : []),
    ...list("- Recent changes, before the save:", f.state.recent),
  ].join("\n");
}
/** The issue, with the anonymized state inline when the link has room;
 * else, with `attached`, a note to attach its file; null when even that's too long. */
export function issue(e: Event, f: Failure, attached = false): string | null {
  const happened =
      e.kind === "turned_down"
        ? `Before updating, Corgi checked that ${e.candidate} could load the running session, and it couldn't. Corgi stayed on ${e.current}.`
        : `Corgi ${e.release} found a problem in the saved session it loaded and repaired it.`,
    title =
      e.kind === "turned_down"
        ? `Update to ${e.candidate} couldn't load the saved session: ${f.why ?? f.error}`
        : `Corgi repaired a saved session: ${f.state.repairs[0] ?? "unknown"}`;
  const body = (state: string[]) =>
    [
      "### What happened?",
      "",
      happened,
      "",
      "### Details",
      "",
      report(e, f),
      "",
      "### Saved state, anonymized",
      "",
      ...state,
      "",
    ].join("\n");
  return attached
    ? bugReport.issueLink(title, body(["<!-- Please attach saved_session.anonymized.json. -->"]))
    : bugReport.issueLink(title, body(["```json", attachment(e, f), "```"]));
}
export async function show(e: Event, f: Failure): Promise<void> {
  const out = process.stderr,
    links = bugReport.hyperlinks(process.env, true),
    inline = issue(e, f),
    // The state goes in a file only when it doesn't fit in the link.
    attached = inline === null ? writeState(e, f) : null,
    url = inline ?? issue(e, f, attached !== null);
  const apology =
    e.kind === "repaired"
      ? [
          "Sorry! Corgi found a problem in your saved session and repaired it.",
          "Nothing was lost, but it's a bug we're tracking down; please send the report below.",
        ]
      : [
          `Sorry! Corgi ${e.candidate} couldn't load your session, so Corgi stayed on ${e.current}.`,
          e.running
            ? "Nothing was lost: your shells and agents are still running."
            : `Nothing was lost: ${e.current} will start from your saved session.`,
        ];
  out.write(
    [
      "",
      ...apology,
      "",
      bugReport.boxed(report(e, f) + "\n") +
        (attached
          ? `\x1b[1mWrote your saved session, anonymized, to ${attached}; please attach it to the issue.\x1b[22m\n`
          : "") +
        bugReport.footer(url, links),
      "",
      fleas(0),
      "",
    ].join("\n"),
  );
  const prompt = "Type y to continue: ";
  out.write(prompt);
  let tick = 0;
  // The fleas play on the line above the prompt; saving the cursor keeps what's typed.
  const timer = setInterval(() => {
    tick = (tick + 1) % animation.flea_cycle_ticks;
    out.write(`\x1b7\x1b[1A\r${fleas(tick)}\x1b[K\x1b8`);
  }, animation.fleas_tick_ms);
  process.stdin.resume();
  try {
    for (;;) {
      const line = await answer();
      // Closed input can't type y; it shouldn't hold the update lock forever.
      if (line === null) {
        out.write("\n");
        break;
      }
      if (/^y(es)?$/i.test(line.trim())) break;
      out.write(`\x1b[1A\r\x1b[K${prompt}`);
    }
  } finally {
    clearInterval(timer);
    process.stdin.pause();
  }
}
/** The next line typed, or null once input ends or fails. */
function answer(): Promise<string | null> {
  return new Promise(resolve => {
    const done = (line: string | null) => {
        process.stdin.off("data", data);
        process.stdin.off("end", end);
        process.stdin.off("error", end);
        resolve(line);
      },
      data = (b: Buffer) => done(b.toString()),
      end = () => done(null);
    process.stdin.on("data", data);
    process.stdin.once("end", end);
    process.stdin.once("error", end);
  });
}
function fleas(tick: number): string {
  return " " + animation.writeFleaCycle(animation.fleas_width, tick) + "\x1b[39m";
}
