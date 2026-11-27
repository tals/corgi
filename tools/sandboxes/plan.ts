/** One agent at work on a scripted session, so its tooltip's plan grows as you watch. */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { table, type World } from "../sandbox";
import * as rpc from "../../src/rpc";

const name = "Login redirect";
type Beat =
  | { say: string; queued?: boolean }
  | { run: string; result: string; failed?: boolean }
  | { edit: string }
  | { end: true };
/** What the agent does, a beat every few seconds. */
const beats: Beat[] = [
  { say: "After signing in, users land on the home page instead of the page they came from. Fix it." },
  {
    run: "rg -n 'redirect' src/auth",
    result: "src/auth/login.ts:41:  return redirect('/')\nsrc/auth/session.ts:12:export function returnPath(req)",
  },
  { run: "bun test src/auth/login.test.ts -t 'returns to the page'", result: "1 pass\n0 fail" },
  { edit: "src/auth/login.ts" },
  {
    run: "bun test src/auth",
    result:
      "23 pass\n2 fail\nexpired session > redirects to /login?next=: expected '/login?next=%2Fsettings' received '/login'",
    failed: true,
  },
  { say: "make a PR when you're done", queued: true },
  { edit: "src/auth/session.ts" },
  { run: "bun test src/auth", result: "25 pass\n0 fail" },
  {
    run: "git commit -am 'auth: return to the page that asked for sign-in'",
    result: "[login-redirect 4c1e9ab] auth: return to the page that asked for sign-in\n 2 files changed",
  },
  {
    run: "git push -u origin login-redirect",
    result: "branch 'login-redirect' set up to track 'origin/login-redirect'",
  },
  {
    run: "gh pr create --title 'auth: return to the page that asked for sign-in'",
    result: "https://github.com/example/web/pull/42",
  },
  { run: "gh pr checks 42 --watch", result: "All checks were successful" },
  { end: true },
];
/** The plan the stand-in model reports as each beat's evidence arrives. */
const script = [
  {
    when: "rg -n 'redirect'",
    step: "s1",
    lines: [
      "mkdir /e1 active Fix sign-in return page",
      "set /e1 subtitle Users should land on the page that sent them to sign in",
      "mkdir /e1/s1 active Find where sign-in redirects",
      "set /s1 subtitle login.ts always redirects to the home page",
    ],
  },
  {
    when: "login\\.ts(?!:)",
    step: "s2",
    lines: [
      "set /s1 done",
      "mkdir /e1/s2 active Redirect to the saved return path",
      "set /s2 subtitle Use session.returnPath instead of the home page",
    ],
  },
  {
    when: "2 fail",
    step: "s3",
    lines: [
      "set /s2 done",
      "mkdir /e1/s3 failed Run the auth tests",
      "set /s3 subtitle Two expired-session tests fail",
      "error /s3 verification Expired sessions lose the ?next= return path",
    ],
  },
  {
    when: "session\\.ts(?!:)",
    step: "s4",
    lines: [
      "mkdir /e1/s4 active Keep the return path for expired sessions",
      "set /s4 subtitle Carry ?next= through the expired-session redirect",
    ],
  },
  {
    when: "25 pass",
    step: "s4",
    lines: ["error /s3 resolved All 25 auth tests pass with the return path kept", "set /s4 done"],
  },
  {
    when: "git commit",
    step: "s5",
    lines: ["mkdir /e1/s5 done Commit the fix", "set /s5 subtitle Committed on login-redirect"],
  },
  {
    when: "git push",
    step: "s6",
    lines: [
      "mkdir /e2 active PR 42: sign-in return page",
      "set /e2 subtitle The pull request asked for while the fix was under way",
      "mkdir /e2/s6 active Push the branch and open the PR",
      "set /s6 subtitle Pushed login-redirect",
    ],
  },
  {
    when: "pull/42",
    step: "s7",
    lines: [
      "set /s6 subtitle Opened pull request 42",
      "set /s6 done",
      "mkdir /e2/s7 active Wait for checks",
      "set /s7 subtitle Watching CI on pull request 42",
    ],
  },
  { when: "All checks were successful", step: "s7", lines: ["set /s7 subtitle All checks passed on pull request 42"] },
];

export const world: World = {
  configure(s) {
    // The plan comes from the tests' stand-in model, not a real one.
    Object.assign(s.env, {
      CORGI_INFERENCE_PROVIDER: "codex",
      CORGI_INFERENCE_BIN: join(s.root, "tests/inference_harness.ts"),
      CORGI_INFERENCE_TEST_CONTROL: join(s.dir, "plan.json"),
    });
  },
  seed(s) {
    s.write(join(s.dir, "web/README.md"), "# web\n\nA workspace for watching an agent's plan.\n");
    s.write(join(s.dir, "plan.json"), JSON.stringify({ delay: 0, label: "Fixing sign-in redirect", script }));
    s.write(
      join(s.home, ".claude/.claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "sandbox@example.com", accountUuid: "sandbox" },
        hasCompletedOnboarding: true,
      }),
    );
  },
  async arrange(s) {
    const web = s.corgi(["workspace", "new", "web", "--cwd", join(s.dir, "web")]);
    const tab = s.corgi([
      "tab",
      "new",
      "--workspace",
      String(web.workspace),
      "--name",
      name,
      "--cwd",
      join(s.dir, "web"),
      "--command",
      `claude --sandbox-name '${name}' --sandbox-state working`,
    ]);
    const connection = new rpc.Connection(s.env.CORGI_SOCKET);
    try {
      for (const deadline = Date.now() + 15000; ; await Bun.sleep(100)) {
        const agent = (await connection.call("session.list")).result.panes.find(p => p.id === tab.pane)?.agent;
        if (agent?.state === "working" && agent.session) {
          // The agent's transcript plays on its own, after this command returns.
          Bun.spawn(["bun", import.meta.path, join(s.home, `${agent.session}.jsonl`), agent.session], {
            stdio: ["ignore", "ignore", "ignore"],
            detached: true,
          }).unref();
          break;
        }
        if (Date.now() > deadline) throw Error("the sandbox agent did not start working");
      }
    } finally {
      connection.close();
    }
  },
  intro() {
    return [
      "An agent fixes a sign-in redirect, and is asked for a PR while it works.",
      ...table([
        ["hover", `"${name}" in the sidebar: its plan grows for about a minute`],
        ["watch", "a failed test run keeps its note, crossed out once the tests pass"],
      ]),
    ];
  },
};

if (import.meta.main) {
  const [file, session] = process.argv.slice(2);
  let n = 0;
  const record = (type: string, more: object) =>
    appendFileSync(
      file,
      JSON.stringify({ type, sessionId: session, timestamp: new Date().toISOString(), ...more }) + "\n",
    );
  const call = async (tool: string, input: object, result: string, failed = false) => {
    const id = `tool-${++n}`,
      usage = { input_tokens: 900, cache_read_input_tokens: 21000 + n * 1500, output_tokens: 240 };
    record("assistant", {
      message: {
        id: `msg-${n}`,
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "tool_use", id, name: tool, input }],
        usage,
      },
    });
    await Bun.sleep(1200);
    record("user", {
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result, is_error: failed }] },
    });
  };
  for (const beat of beats) {
    if ("say" in beat)
      beat.queued
        ? record("attachment", { attachment: { type: "queued_command", prompt: beat.say, origin: { kind: "human" } } })
        : record("user", { message: { role: "user", content: beat.say } });
    else if ("run" in beat) await call("Bash", { command: beat.run }, beat.result, beat.failed);
    else if ("edit" in beat) await call("Edit", { file_path: beat.edit }, "The file has been updated.");
    else record("system", { subtype: "turn_duration" });
    await Bun.sleep(3500);
  }
}
