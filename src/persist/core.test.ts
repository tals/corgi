import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime, Pane, Launch } from "../runtime";
import { Workspace } from "../workspace";
import { Terminal } from "../pane/terminal";
import { Text } from "../agents";
import * as locations from "../providers/pi/locations";
import * as launch_command from "../launch/command";
import * as json from "../json";
import * as checkpoint from "./checkpoint";
import * as cold from "./cold";
import * as core from "./core";
import * as formats from "./formats";
import * as transfer from "./transfer";
import * as state_formats from "./state_formats";
import * as resume_commands from "./revisions/20261118_090242_b6611ab7ace3_preserve_generated_resume_commands";

function fixture(cwd = "/tmp") {
  const runtime = new Runtime(),
    workspace = new Workspace(1, cwd, "workspace"),
    pane = new Pane(workspace.model.newTab("saved"), Terminal.create(20, 4), cwd);
  runtime.workspaces.items.push(workspace);
  runtime.workspaces.next_id = 2;
  runtime.workspaces.next_pane_id = workspace.model.next_id;
  runtime.panes.push(pane);
  pane.terminal.exited = true;
  pane.dormant = true;
  return runtime;
}

function handoff(runtime: Runtime, readable = transfer.info().formats) {
  return transfer.encode(
    runtime,
    {
      runtime: checkpoint.capture(runtime, true),
      requester: -1,
      request_id: null,
      start_lock: -1,
      older_updater: false,
    },
    readable,
    [],
  );
}

test("archived one-time commands remain separate from launchers through handoff and cold recovery", async () => {
  using original = fixture();
  original.workspaces.items.push(new Workspace(2, "/tmp", "active"));
  original.workspaces.next_id = 3;
  original.archiveWorkspace(1);
  original.panes[0].manual_command = "npm run dev";
  for (const readable of [transfer.info().formats, [formats.baseline]]) {
    using handed = new Runtime();
    await checkpoint.restore(
      handed,
      transfer.decode(json.clone(handoff(original, readable))).runtime,
      true,
      "/tmp/unused",
      process.execPath,
      false,
    );
    using recovered = new Runtime();
    const saved = transfer.recovery(handed, checkpoint.capture(handed, false));
    await checkpoint.restore(
      recovered,
      (await cold.read(json.stringify(saved), "/tmp/unused", process.execPath)).value,
      false,
      "/tmp/unused",
      process.execPath,
      false,
    );
    for (const runtime of [handed, recovered]) {
      const pane = runtime.panes[0];
      expect(pane.launch).toBeNull();
      expect(pane.restoring()).toBe("npm run dev");
      pane.attachment.select(runtime.conversations.get("claude", "later-session"));
      pane.resume_hint.observe(pane.agent());
      pane.manual_resume = false;
      pane.manual_command = null;
      expect(pane.restoring()).toBe("claude --resume later-session");
    }
  }
});

test.each([
  { named: false, long: true },
  { named: true, long: false },
  { named: true, long: true },
])("core retains the executable resume command across metadata loss: %j", async ({ named, long }) => {
  const directory = mkdtempSync(join(tmpdir(), "corgi-core-resume-")),
    previous = process.env.PI_CODING_AGENT_DIR,
    state = process.env.XDG_STATE_HOME,
    account = join(directory, named ? "work account's" : "default"),
    transcript = join(directory, ...(long ? Array(12).fill("d".repeat(180)) : []), "session's transcript.jsonl"),
    bin = join(directory, "bin");
  process.env.PI_CODING_AGENT_DIR = join(directory, "default");
  process.env.XDG_STATE_HOME = join(directory, "state");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "pi"),
    `#!${process.execPath}\nconsole.log(JSON.stringify({ account: process.env.PI_CODING_AGENT_DIR, args: process.argv.slice(2) }));\n`,
    { mode: 0o755 },
  );
  const verify = async (runtime: Runtime) => {
    const pane = runtime.panes[0],
      launch = pane.resumeLaunch(),
      child = Bun.spawn(["/bin/sh", "-c", pane.restoring()], {
        env: {
          ...process.env,
          PATH: bin + ":" + process.env.PATH,
          ...Object.fromEntries(launch?.agent?.env ?? []),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
    const [output, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(output)).toEqual({ account, args: ["--session", transcript] });
  };
  try {
    locations.remember("retained-session", transcript, named ? account : "");
    using original = fixture(directory);
    const pane = original.panes[0];
    pane.launch = new Launch({ provider: "pi", env: named ? [["PI_CODING_AGENT_DIR", account]] : [] });
    pane.resume_hint.provider = "pi";
    pane.resume_hint.session = new Text("retained-session");
    await verify(original);
    const command = core.capture(original, checkpoint.capture(original, true)).panes[0].command!;
    if (long) expect(Buffer.byteLength(command)).toBeGreaterThan(2048);
    for (const readable of [transfer.info().formats, [formats.baseline]]) {
      using handed = new Runtime();
      await checkpoint.restore(
        handed,
        transfer.decode(json.clone(handoff(original, readable))).runtime,
        true,
        "/tmp/unused",
        process.execPath,
        false,
      );
      await verify(handed);
      using returned = new Runtime();
      await checkpoint.restore(
        returned,
        transfer.decode(json.clone(handoff(handed))).runtime,
        true,
        "/tmp/unused",
        process.execPath,
        false,
      );
      await verify(returned);
      for (const source of [original, returned]) {
        const saved = transfer.recovery(source, checkpoint.capture(source, false));
        for (const unknown of [false, true]) {
          const state = json.clone(saved);
          if (unknown) state.transfer.format = "f".repeat(12);
          using recovered = new Runtime();
          const decoded = await cold.read(json.stringify(state), "/tmp/unused", process.execPath);
          await checkpoint.restore(recovered, decoded.value, false, "/tmp/unused", process.execPath, false);
          await verify(recovered);
        }
      }
    }
    // A live agent can rediscover its hint after the core-only transfer.
    pane.dormant = false;
    using rediscovered = new Runtime();
    await checkpoint.restore(
      rediscovered,
      transfer.decode(json.clone(handoff(original, [formats.baseline]))).runtime,
      true,
      "/tmp/unused",
      process.execPath,
      false,
    );
    const restored = rediscovered.panes[0];
    restored.dormant = true;
    restored.resume_hint.provider = "pi";
    restored.resume_hint.session = new Text("retained-session");
    await verify(rediscovered);
    using recovered = new Runtime();
    const saved = transfer.recovery(rediscovered, checkpoint.capture(rediscovered, false));
    await checkpoint.restore(
      recovered,
      (await cold.read(json.stringify(saved), "/tmp/unused", process.execPath)).value,
      false,
      "/tmp/unused",
      process.execPath,
      false,
    );
    await verify(recovered);
    if (named && !long) {
      // An opaque launcher may choose an account only the running process reveals.
      pane.launch = new Launch(undefined, "./start-selected-account");
      pane.running_account = account;
      pane.detection.pid = 123;
      pane.dormant = true;
      using observed = new Runtime();
      await checkpoint.restore(
        observed,
        transfer.decode(json.clone(handoff(original, [formats.baseline]))).runtime,
        true,
        "/tmp/unused",
        process.execPath,
        false,
      );
      await verify(observed);
    }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    if (state === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = state;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("long commands stay executable in legacy exports without exceeding old reader limits", async () => {
  const directory = mkdtempSync(join(tmpdir(), "corgi-legacy-command-")),
    previous = process.env.XDG_STATE_HOME,
    output = "saved ".repeat(500),
    command = `printf '%s' '${output}'`;
  process.env.XDG_STATE_HOME = directory;
  try {
    using runtime = fixture();
    const pane = runtime.panes[0];
    pane.manual_resume = true;
    pane.manual_command = command;
    for (const live of [true, false]) {
      const saved = checkpoint.capture(runtime, live),
        legacy = live ? transfer.downgrade(runtime, { runtime: saved }).runtime : transfer.recovery(runtime, saved),
        restored = legacy.panes[0];
      expect(Buffer.byteLength(restored.manual_command!)).toBeLessThanOrEqual(2048);
      const child = Bun.spawn([launch_command.shell(), "-c", restored.manual_command!], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(status, stderr).toBe(0);
      expect(stdout).toBe(output);
      const upgraded = transfer.upgrade({ runtime: legacy }).runtime;
      expect(upgraded.panes[0].manual_command).toBe(command);
    }
    const envelope = handoff(runtime, [formats.baseline]);
    expect(Buffer.byteLength(envelope.core.panes[0].command!)).toBeLessThanOrEqual(2048);
    expect(transfer.decode(json.clone(envelope)).runtime.panes[0].manual_command).toBe(command);
    expect(pane.manual_command).toBe(command);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("process-revealed accounts retain custom launcher options through reload and recovery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "corgi-resume-account-")),
    account = join(directory, "work"),
    command = "claude --model opus --append-system-prompt house-rules";
  try {
    using original = fixture(directory);
    const pane = original.panes[0];
    pane.launch = new Launch(undefined, command);
    pane.attachment.select(original.conversations.get("claude", "retained-session"));
    pane.running_account = account;
    pane.detection.pid = 123;
    for (const live of [true, false]) {
      const decoded = live
        ? transfer.decode(json.clone(handoff(original))).runtime
        : (
            await cold.read(
              json.stringify(transfer.recovery(original, checkpoint.capture(original, false))),
              "/tmp/unused",
              process.execPath,
            )
          ).value;
      using restored = new Runtime();
      await checkpoint.restore(restored, decoded, live, "/tmp/unused", process.execPath, false);
      const resumed = restored.panes[0],
        launch = resumed.resumeLaunch()!;
      expect(resumed.launch?.command).toBe(command);
      expect(resumed.restoring()).toBe(command + " --resume retained-session");
      expect(launch.account("claude")).toBe(account);
      expect(launch.run(process.execPath, resumed.resume_hint.args()).env).toContainEqual([
        "CLAUDE_CONFIG_DIR",
        account,
      ]);
      expect(core.capture(restored, checkpoint.capture(restored, live)).panes[0].command).toContain(account);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each([
  { from: undefined, to: "/tmp/new-claude" },
  { from: "/tmp/old-claude", to: undefined },
  { from: "/tmp/old-claude", to: "/tmp/new-claude" },
])("changing the provider executable retains launcher metadata: %j", async ({ from, to }) => {
  const previous = process.env.CORGI_CLAUDE_BIN,
    select = (value: string | undefined) => {
      if (value === undefined) delete process.env.CORGI_CLAUDE_BIN;
      else process.env.CORGI_CLAUDE_BIN = value;
    };
  try {
    select(from);
    using original = fixture();
    const pane = original.panes[0];
    pane.launch = new Launch({ provider: "claude", yolo: true, model: "opus", args: ["--verbose"] });
    pane.attachment.select(original.conversations.get("claude", "retained-session"));
    const live = json.clone(handoff(original)),
      saved = json.stringify(transfer.recovery(original, checkpoint.capture(original, false)));
    select(to);
    for (const [isLive, decoded] of [
      [true, transfer.decode(live).runtime],
      [false, (await cold.read(saved, "/tmp/unused", process.execPath)).value],
    ] as const) {
      using restored = new Runtime();
      await checkpoint.restore(restored, decoded, isLive, "/tmp/unused", process.execPath, false);
      const resumed = restored.panes[0];
      expect(resumed.launch?.toJSON()).toEqual(pane.launch.toJSON());
      expect(resumed.resume_hint.session.text()).toBe("retained-session");
      expect(resumed.resume_hint.executable).toBe(from ?? "claude");
      expect(resumed.manual_resume).toBe(false);
      expect(core.capture(restored, checkpoint.capture(restored, isLive)).panes[0].command).toBe(
        `${to ?? "claude"} --resume retained-session`,
      );
    }
  } finally {
    select(previous);
  }
});

test("cold recovery keeps launcher options when a Claude background job has ended", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "corgi-resume-background-"))),
    account = join(directory, "work"),
    session = "0f0e0d0c-1111-2222-3333-444455556666",
    job = join(account, "sessions", "job.json");
  mkdirSync(join(account, "sessions"), { recursive: true });
  try {
    using original = fixture(directory);
    const pane = original.panes[0];
    pane.launch = new Launch({ provider: "claude", yolo: true, env: [["CLAUDE_CONFIG_DIR", account]] });
    pane.attachment.select(original.conversations.get("claude", session));
    writeFileSync(job, JSON.stringify({ kind: "bg", sessionId: session, pid: process.pid, jobId: "job_1" }));
    const saved = transfer.recovery(original, checkpoint.capture(original, false));
    expect(saved.transfer.core.panes[0].command).toContain("--resume " + session);
    expect(pane.resume_hint.attach(account)).toBe("claude attach job_1");
    rmSync(job);
    using restored = new Runtime();
    const decoded = await cold.read(json.stringify(saved), "/tmp/unused", process.execPath);
    expect(decoded.discarded).toBe(false);
    await checkpoint.restore(restored, decoded.value, false, "/tmp/unused", process.execPath, false);
    const resumed = restored.panes[0];
    expect(resumed.manual_resume).toBe(false);
    expect(resumed.restoring()).toBe("claude --dangerously-skip-permissions --resume " + session);
    expect(resumed.resumeLaunch()?.account()).toBe(account);
    checkpoint.capture(restored, false);
    expect(resumed.resumeLaunch()?.account()).toBe(account);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the resume-command revision drops only metadata too long for older readers", () => {
  const long = "x".repeat(2049),
    saved = {
      runtime: {
        panes: [{ launch: { command: long }, manual_command: long, recovery_command: long }],
        closed: [{ launch: { command: long } }, { launch: { command: "retained" } }],
      },
    },
    history = new formats.History(resume_commands.revision.id, state_formats.revisions),
    parent = resume_commands.revision.parent!,
    down = history.down(saved, parent);
  expect(down).toEqual({
    runtime: {
      panes: [{ launch: null, manual_command: null, recovery_command: null }],
      closed: [{ launch: null }, { launch: { command: "retained" } }],
    },
  });
  expect(history.up(saved, parent)).toEqual(saved);
  expect(saved.runtime.panes[0].launch.command).toBe(long);
});
