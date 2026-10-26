import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { JsonSocket, EXE, quote, registerCase, run, shellJoin, sleep, versioned, writeExecutable } from "./support";
import * as protocol from "../src/protocol";
import { byProvider } from "../src/providers";
import { Runtime } from "./runtime";
import { Viewer } from "./viewer_client";
import { CodexObserver, write_codex_terminal } from "./provider_sim";

// Rewrites current state the way the previous build wrote it (checkpoint 4,
// handoff 3), because a relabeled current file isn't a valid old one. It
// inverts checkpoint4To5 and handoff3To4, and is source text because
// candidate() pastes it into a separate script.
const DOWNGRADE = `
const size = s => Buffer.byteLength(s, 'utf8');
const copy = v => v === null || typeof v !== 'object' || JSON.isRawJSON(v) ? v
  : Array.isArray(v) ? v.map(copy) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)]));
function paired(o, key, len = key + '_len') {
  if (typeof o?.[key] === 'string') o[len] = size(o[key]);
}
function wrapped(o, key) {
  if (typeof o?.[key] === 'string') o[key] = { bytes: o[key], len: size(o[key]) };
}
function byProvider(o, key) {
  const v = o?.[key];
  if (v && typeof v === 'object' && !Array.isArray(v)) o[key] = [v.codex, v.claude];
}
function agentV4(a) {
  for (const key of ['name', 'transcript', 'turn', 'last_finished_turn', 'recent', 'session', 'activity', 'tool', 'cwd'])
    paired(a, key);
}
function recentV4(r) {
  if (Array.isArray(r?.recent)) r.recent.forEach((_, i) => wrapped(r.recent, i));
  wrapped(r, 'previous');
}
function checkpointV4(state) {
  for (const c of state.conversations ?? []) { agentV4(c.agent); recentV4(c.status_inference); }
  for (const e of [...state.panes ?? [], ...state.sessions ?? []]) {
    agentV4(e.binding?.provisional);
    paired(e.resume_hint, 'name');
    paired(e.resume_hint, 'session', 'len');
  }
  for (const p of state.panes ?? []) {
    const actor = p.binding?.actor;
    p.agent = copy(actor ? state.conversations.find(c => c.id === actor).agent : p.binding?.provisional);
    wrapped(p, 'label');
  }
  for (const p of state.closed ?? []) wrapped(p, 'label');
  for (const e of state.link_labels?.entries ?? []) wrapped(e, 'name');
  for (const c of state.agent_commands ?? []) {
    if ('command' in c) { c.bytes = c.command; delete c.command; }
    paired(c, 'bytes', 'len');
    paired(c, 'original');
    wrapped(c, 'name');
    for (const key of ['suggested_name', 'model', 'account', 'mode']) wrapped(c.semantics, key);
  }
  byProvider(state, 'agent_yolo');
  byProvider(state, 'agent_hidden');
}
function requestV3(r) {
  for (const key of ['session', 'turn', 'name']) paired(r, key);
  wrapped(r, 'evidence');
  recentV4(r?.conversation);
}
function handoffV3(m) {
  for (const { slot } of m.summaries?.slots ?? []) {
    requestV3(slot?.request);
    wrapped(slot, 'commentary');
    wrapped(slot, 'tool_evidence');
    requestV3(slot?.result?.request);
    wrapped(slot?.result, 'label');
  }
  for (const r of m.summaries?.link_results ?? []) wrapped(r, 'name');
  for (const { launch_preview: saved } of m.clients ?? []) {
    paired(saved, 'cwd', 'len');
    const preview = saved?.preview;
    byProvider(preview, 'options');
    byProvider(preview, 'installed');
    for (const o of preview?.options ?? [])
      for (const key of ['model', 'source', 'account', 'plan', 'usage_error']) wrapped(o, key);
  }
}
`;

class Reloads extends Runtime {
  async pair(pane: number, session: string) {
    const terminal = write_codex_terminal(join(this.temp.name, "codex"), session);
    const observer = new CodexObserver(this.env.CODEX_HOME!, [session]);
    try {
      await this.command("pane.input", { target: pane, data: `exec ${quote(terminal)}\r` });
      await this.until(
        async () => (await this.session()).panes.find((p: any) => p.id === pane).agent.session === session,
      );
    } finally {
      await observer.close();
    }
  }

  async new(command = "exec /bin/sh", title = "") {
    return (
      await this.command("pane.create", {
        workspace: (await this.session()).workspaces[0].id,
        cwd: this.temp.name,
        command,
        title,
      })
    ).pane;
  }
  reload(exe = EXE) {
    return this.rpc({ op: "server.reload", executable: exe });
  }
  async test_management_version_is_strict_and_independent_of_runtime() {
    const pane = await this.new(),
      before = await this.session();
    const socket = await JsonSocket.connect(this.path);
    try {
      await socket.request(versioned({ op: "hello" }));
      for (const op of ["hello", "server.reload"]) {
        for (const version of [0, 2, 999, -1, "1", undefined]) {
          const reply = await socket.request({ op, protocol: version, executable: EXE });
          this.assertEqual(reply.err, version === undefined ? "ProtocolRequired" : "UnsupportedManagementProtocol");
        }
      }
      this.assertEqual((await this.session()).server_pid, before.server_pid);
      this.assertEqual(
        (await socket.request(versioned({ op: "hello", runtime_protocol: 999 }))).protocol,
        protocol.version,
      );
      this.assertEqual((await socket.request({ op: "session.snapshot" })).err, "ProtocolRequired");
      this.assertEqual((await socket.request(versioned({ op: "server.reload", executable: EXE }))).ok, true);
    } finally {
      socket.close();
    }
    const after = await this.session();
    this.assertNotEqual(after.server_pid, before.server_pid);
    this.assertEqual(after.panes.find((p: any) => p.id === pane).pid, before.panes.find((p: any) => p.id === pane).pid);
    await this.command("pane.input", { target: pane, data: "printf 'MANAGEMENT_RELOADED\\n'\r" });
    await this.until(async () => (await this.screen(pane)).includes("MANAGEMENT_RELOADED"));
  }
  candidate(mutation: string) {
    const candidate = join(this.temp.name, "candidate"),
      transformer = join(this.temp.name, "mutate.ts");
    writeExecutable(
      transformer,
      `#!/usr/bin/env bun
import { readFileSync, writeSync, ftruncateSync } from 'node:fs';
import { dlopen, FFIType } from 'bun:ffi';
const libc = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  lseek: { args: [FFIType.i32, FFIType.i64, FFIType.i32], returns: FFIType.i64 }
});
const fd = Number(process.argv[2]);
// Preserve u64 terminal fingerprints and selection hashes exactly.
const m = JSON.parse(readFileSync(fd, 'utf8'), (_key, value, context) =>
  typeof value === 'number' && !Number.isSafeInteger(value)
    ? JSON.rawJSON(context.source) : value);
${mutation};
libc.symbols.lseek(fd, 0n, 0);
ftruncateSync(fd, 0); writeSync(fd, JSON.stringify(m));
libc.symbols.lseek(fd, 0n, 0);
`,
    );
    writeFileSync(candidate, `#!/bin/sh\nbun ${quote(transformer)} "$2"\nexec ${quote(EXE)} "$@"\n`, { mode: 0o700 });
    chmodSync(candidate, 0o700);
    return candidate;
  }
  async screen(pane: number) {
    return (await this.command("pane.read", { target: pane, view: "screen" })).text;
  }
  /** Its output with wrapped lines joined, so a long prompt can't split a command. */
  async history(pane: number) {
    return (await this.command("pane.read", { target: pane, view: "history" })).text;
  }

  async test_workspace_names_survive_handoff() {
    const first = await this.new(),
      folder = join(this.temp.name, "project");
    mkdirSync(folder);
    const ws = (await this.session()).workspaces[0].id,
      name = (await this.session()).workspaces[0].name;
    await this.command("workspace.edit", { target: ws, cwd: folder });
    await this.reload();
    this.assertEqual((await this.session()).workspaces[0].name, name);
    await this.command("workspace.edit", { name: "Override", target: ws });
    await this.reload();
    await this.command("pane.input", { target: first, data: "cd /\r" });
    await this.until(async () => (await this.session()).panes[0].cwd === "/");
    this.assertEqual((await this.session()).workspaces[0].name, "Override");
    const empty = await this.raw_rpc({
      op: "session.command",
      command: { "workspace.edit": { name: "", target: ws } },
    });
    this.assertEqual(empty.err, "InvalidName");
    this.assertEqual((await this.session()).workspaces[0].name, "Override");
  }
  async test_handoff_preserves_processes_viewers_and_queued_controls() {
    const first = await this.new(),
      second = await this.new();
    const a = await Viewer.create(this),
      b = await Viewer.create(this);
    await a.focus(first);
    await b.focus(second);
    await a.input("\x02");
    let before = await this.session();
    await this.rpc({
      op: "action",
      name: "rename",
      value: "After handoff",
      viewer: (await this.rpc({ op: "viewer.list" })).viewers[1].id,
    });
    for (let i = 0; i < 3; i++) {
      const result = await this.reload();
      this.assertNotEqual(result.server_pid, before.server_pid);
      const after = await this.session();
      this.assertEqual(
        before.panes.map((p: any) => [p.id, p.pid]),
        after.panes.map((p: any) => [p.id, p.pid]),
      );
      before = after;
    }
    this.assertTrue((await a.poll()).prefix);
    this.assertEqual(a.state.pane, first);
    this.assertEqual((await b.poll()).pane, second);
    this.assertIn("After handoff", b.state.data);
    await a.input("\x1b");
    await a.input("printf 'AFTER_%s\\n' RELOAD\r");
    await this.until(async () => (await this.screen(first)).includes("AFTER_RELOAD"));
    await this.command("pane.input", { target: first, data: "exit\r" });
    await this.until(async () => !(await this.session()).panes.some((p: any) => p.id === first));
  }
  async test_failed_candidate_rolls_back_and_can_retry() {
    const first = await this.new(),
      a = await Viewer.create(this),
      before = await this.session();
    for (const executable of ["/does/not/exist", "/usr/bin/false"]) {
      const response = await this.raw_rpc({
        op: "server.reload",
        executable,
      });
      this.assertEqual(response.err, "ReloadCandidateFailed");
      this.assertEqual(before.server_pid, (await this.session()).server_pid);
      this.assertEqual(before.panes[0].pid, (await this.session()).panes[0].pid);
      this.assertEqual((await a.poll()).pane, first);
    }
    await this.reload();
    await a.input("printf 'STILL_%s\\n' HERE\r");
    await this.until(async () => (await this.screen(first)).includes("STILL_HERE"));
  }
  async test_v2_migration_preserves_processes_viewers_and_inference_counts() {
    const first = await this.new(),
      viewer = await Viewer.create(this);
    const before = await this.session();
    const executable = this.candidate(`${DOWNGRADE}
handoffV3(m);
checkpointV4(m.runtime);
m.version = 1;
m.runtime.version = 2;
for (const p of m.runtime.panes) {
  for (const a of [p.agent, p.resume_hint, p.binding.provisional])
    if (a.provider === null) a.provider = 'other';
}
for (const command of m.runtime.agent_commands)
  if (command.semantics.provider === null) command.semantics.provider = 'other';
m.summaries.launches = { codex: 7, claude: 4, latest: 'claude' };
`);
    const result = await this.raw_rpc({ op: "server.reload", executable });
    this.assertTrue(result.ok, readFileSync(join(this.temp.name, "server.log"), "utf8"));
    this.assertNotEqual(result.server_pid, before.server_pid);
    const after = await this.session();
    this.assertEqual(
      before.panes.map((p: any) => [p.id, p.pid]),
      after.panes.map((p: any) => [p.id, p.pid]),
    );
    this.assertEqual(
      after.inference.launches,
      byProvider(p => (p === "codex" ? 7 : p === "claude" ? 4 : 0)),
    );
    this.assertEqual((await viewer.poll()).pane, first);
    await viewer.input("printf 'MIGRATED_%s\\n' ALIVE\r");
    await this.until(async () => (await this.screen(first)).includes("MIGRATED_ALIVE"));
    const saved = (await this.rpc({ op: "recovery.save" })).path;
    const state = JSON.parse(readFileSync(saved, "utf8"));
    this.assertEqual(state.version, 6);
    this.assertEqual(state.panes[0].binding.provisional.provider, null);
    await this.reload();
    this.assertEqual((await viewer.poll()).pane, first);
  }
  async test_cold_migration_upgrades_only_after_successful_restore() {
    const first = await this.new("printf 'MIGRATION_%s\\n' HISTORY; exec /bin/sh");
    await this.until(async () => (await this.screen(first)).includes("MIGRATION_HISTORY"));
    const before = await this.session();
    const saved = (await this.rpc({ op: "recovery.save" })).path;
    await this.run_cli("shutdown");
    await this.until(() => {
      try {
        process.kill(before.server_pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    const original = JSON.parse(readFileSync(saved, "utf8"));
    new Function("state", `${DOWNGRADE}checkpointV4(state);`)(original);
    original.version = 2;
    original.panes[0].agent.provider = "other";
    original.panes[0].binding.provisional.provider = "other";
    original.panes[0].resume_hint.provider = "other";
    for (const bad of [
      { ...original, version: 999 },
      { ...original, next_pane: 0 },
    ]) {
      const bytes = JSON.stringify(bad);
      writeFileSync(saved, bytes);
      const failed = await run([EXE, "start"], { env: this.env, check: false });
      this.assertNotEqual(failed.code, 0);
      this.assertIn(bad.version === 999 ? "UnsupportedStateVersion" : "InvalidCheckpoint", failed.stderr);
      this.assertEqual(readFileSync(saved, "utf8"), bytes);
    }
    // Failed attempts leave no backup; a successful migration keeps the
    // original bytes beside the upgraded file.
    this.assertFalse(existsSync(`${saved}.v2`));
    writeFileSync(saved, JSON.stringify(original));
    await this.run_cli("start");
    this.assertEqual(JSON.parse(readFileSync(saved, "utf8")).version, 6);
    this.assertEqual(statSync(saved).mode & 0o777, 0o600);
    this.assertEqual(readFileSync(`${saved}.v2`, "utf8"), JSON.stringify(original));
    this.assertEqual(statSync(`${saved}.v2`).mode & 0o777, 0o600);
    this.assertEqual((await this.session()).panes[0].id, first);
    await this.until(async () => (await this.screen(first)).includes("MIGRATION_HISTORY"));
  }
  async test_fragmented_rpc_and_paste_survive() {
    const first = await this.new(),
      a = await Viewer.create(this);
    await a.input("\x1b[200~printf PASTE_");
    const client = await JsonSocket.connect(this.path);
    try {
      client.socket.write('{"op":"session.snap');
      await sleep(0.05);
      await this.reload();
      client.socket.write(`shot","protocol":${protocol.version}}\n`);
      this.assertEqual((await client.read()).type, "session");
    } finally {
      client.close();
    }
    await a.input("SURVIVED\\n\x1b[201~\r");
    await this.until(async () => (await this.screen(first)).includes("PASTE_SURVIVED"));
  }
  async test_headless_session_retains_pid_approvals_and_transport() {
    const session = (
      await this.rpc({
        op: "headless.start",
        prompt: "test/init",
        provider: "codex",
        cwd: this.temp.name,
      })
    ).session;
    await this.until(async () => (await this.rpc({ op: "headless.list" })).sessions[0].ready);
    await this.headless_command(session, "test/approval");
    await this.until(async () => (await this.rpc({ op: "headless.list" })).sessions[0].pending_requests === 1);
    const before = await this.rpc({ op: "headless.events", provider: "codex", session });
    const pid = (await this.rpc({ op: "headless.list" })).sessions[0].pid;
    await this.reload();
    await this.reload(
      this.candidate(
        "for (const s of m.runtime.sessions) delete s.session; for (const c of m.clients) delete c.headless_start",
      ),
    );
    this.assertEqual(
      (await this.rpc({ op: "headless.events", provider: "codex", session })).pending_requests,
      before.pending_requests,
    );
    this.assertEqual((await this.rpc({ op: "headless.list" })).sessions[0].pid, pid);
    await this.headless_answer(session, "codex");
    await this.until(async () => (await this.rpc({ op: "headless.list" })).sessions[0].pending_requests === 0);
    await this.headless_command(session, "test/exit");
    await this.until(async () => (await this.rpc({ op: "headless.list" })).sessions[0].exited);
  }
  async test_cold_recovery_preserves_layout_cwd_history_and_resume_hint() {
    this.env.SHELL = "/bin/bash";
    await this.restart_runtime();
    const project = join(this.temp.name, "project");
    mkdirSync(project);
    const physicalProject = realpathSync(project);
    const first = await this.new("printf 'BEFORE_%s\\n' CRASH; exec /bin/sh", "Kept title");
    await this.command("pane.input", {
      target: first,
      data: `cd ${quote(project)}\r`,
    });
    await this.until(async () => (await this.session()).panes[0].cwd === physicalProject);
    await this.pair(first, "01901234-1234-1234-1234-123456789abc");
    await this.rpc({
      op: "hook",
      provider: "codex",
      pane: first,
      event: {
        hook_event_name: "SessionStart",
        session_id: "01901234-1234-1234-1234-123456789abc",
        cwd: physicalProject,
      },
    });
    await this.until(
      async () => (await this.session()).panes[0].agent.session === "01901234-1234-1234-1234-123456789abc",
    );
    const before = await this.session(),
      saved = (await this.rpc({ op: "recovery.save" })).path;
    this.assertTrue(saved.startsWith(join(this.env.XDG_STATE_HOME!, "corgi", "recovery") + "/"));
    this.assertEqual(statSync(saved).mode & 0o777, 0o600);
    process.kill(before.server_pid, "SIGKILL");
    await this.until(
      async () =>
        (
          await run([EXE, "ping"], {
            env: this.env,
            timeout: 3000,
            check: false,
          })
        ).code !== 0,
    );
    await this.run_cli("start");
    const after = await this.session();
    this.assertEqual(
      before.workspaces.map((w: any) => [w.id, w.model.tabs]),
      after.workspaces.map((w: any) => [w.id, w.model.tabs]),
    );
    this.assertEqual(after.panes[0].id, first);
    this.assertEqual([after.panes[0].dormant, after.panes[0].pid], [true, -1]);
    this.assertEqual(after.panes[0].restoring, "codex resume 01901234-1234-1234-1234-123456789abc");
    this.assertIn("BEFORE_CRASH", await this.screen(first));
    await this.command("pane.wake", { target: first, shell: true });
    await this.until(async () =>
      (await this.history(first)).includes("codex resume 01901234-1234-1234-1234-123456789abc"),
    );
    this.assertNotEqual((await this.session()).panes[0].pid, before.panes[0].pid);
    const text = await this.history(first);
    this.assertIn("BEFORE_CRASH", text);
    this.assertIn("codex resume 01901234-1234-1234-1234-123456789abc", text);
    this.assertEqual(after.panes[0].cwd, physicalProject);
    const restored = after.panes[0].agent;
    this.assertEqual(restored.provider, "codex");
    this.assertEqual(restored.session, "01901234-1234-1234-1234-123456789abc");
    this.assertEqual(restored.state, "unknown");
    this.assertEqual(restored.conversation, before.panes[0].agent.conversation);
    const actor = after.conversations.find((a: any) => a.id === restored.conversation);
    this.assertEqual(actor.observed_at, 0);
    await this.command("pane.input", {
      target: first,
      data: "\x15printf 'NEW_%s\\n' SHELL\r",
    });
    await this.until(async () => (await this.screen(first)).includes("NEW_SHELL"));
  }
  async test_recovery_prefills_editable_command_until_enter() {
    const fish = await run(["which", "fish"], { check: false });
    for (const shell of [
      "/bin/bash",
      existsSync("/bin/zsh") ? "/bin/zsh" : "",
      fish.code === 0 ? fish.stdout.trim() : "",
    ]) {
      if (!shell) continue;
      this.env.SHELL = shell;
      await this.restart_runtime();
      const first = await this.new(),
        marker = join(this.temp.name, "resumed");
      rmSync(marker, { force: true });
      const body = `printf '%s' "$*" > ${quote(marker)}`;
      if (shell.endsWith("fish")) {
        const config = join(this.temp.name, ".config/fish/config.fish");
        mkdirSync(join(this.temp.name, ".config/fish"), { recursive: true });
        writeFileSync(
          config,
          `set -g fish_greeting; function fish_prompt; printf '❯ '; end; function codex; printf '%s ' $argv > ${quote(marker)}; end\n`,
        );
      } else {
        const config = join(
          this.temp.name,
          shell.endsWith("zsh") ? ".zshrc" : process.platform === "darwin" ? ".profile" : ".bashrc",
        );
        writeFileSync(config, `codex() { ${body}; }\n`);
      }
      await this.pair(first, "01901234-1234-1234-1234-123456789def");
      await this.rpc({
        op: "hook",
        provider: "codex",
        pane: first,
        event: { hook_event_name: "SessionStart", session_id: "01901234-1234-1234-1234-123456789def" },
      });
      await this.until(async () =>
        (await this.session()).panes.some(
          (p: any) => p.id === first && p.agent.session === "01901234-1234-1234-1234-123456789def",
        ),
      );
      await this.rpc({ op: "recovery.save" });
      await this.restart_runtime();
      await this.command("pane.wake", { target: first, shell: true });
      await this.until(async () =>
        (await this.history(first)).includes("codex resume 01901234-1234-1234-1234-123456789def"),
      );
      this.assertFalse(existsSync(marker));
      await this.command("pane.input", { data: "\r", target: first });
      await this.until(
        () =>
          existsSync(marker) && readFileSync(marker, "utf8").trim() === "resume 01901234-1234-1234-1234-123456789def",
      );
      this.assertEqual(readFileSync(marker, "utf8").trim(), "resume 01901234-1234-1234-1234-123456789def");
      await this.command("pane.input", { target: first, data: "exit\r" });
      await this.until(async () => !(await this.session()).panes.some((p: any) => p.id === first));
    }
  }
  async test_cold_recovery_resumes_the_agent_in_its_pane_once_focused() {
    const resumes = join(this.temp.name, "resumes.jsonl"),
      session = "01901234-1234-1234-1234-123456789aaa";
    this.env.CORGI_CODEX_BIN = writeExecutable(
      join(this.temp.name, "codex-resume"),
      `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (!args.includes('resume')) process.exit(0);
appendFileSync(${JSON.stringify(resumes)}, JSON.stringify(args) + '\\n');
console.log('RESUMED_FIXTURE');
await Bun.sleep(120000);
`,
    );
    await this.restart_runtime();
    const first = await this.new("printf 'BEFORE_%s\\n' CRASH; exec /bin/sh");
    await this.until(async () => (await this.screen(first)).includes("BEFORE_CRASH"));
    await this.pair(first, session);
    await this.rpc({ op: "recovery.save" });
    await this.restart_runtime();
    const pane = async () => (await this.session()).panes.find((p: any) => p.id === first);
    this.assertEqual([(await pane()).dormant, (await pane()).pid], [true, -1]);
    this.assertEqual((await pane()).restoring, `codex resume ${session}`);
    await this.reload();
    this.assertTrue((await pane()).dormant);
    const viewer = await Viewer.create(this);
    await viewer.focus(first);
    await this.until(() => existsSync(resumes));
    this.assertEqual(JSON.parse(readFileSync(resumes, "utf8")).slice(-2), ["resume", session]);
    const woken = await pane();
    this.assertEqual([woken.dormant, woken.pid > 0], [false, true]);
    this.assertEqual((await this.session()).panes.length, 1);
    await this.until(async () => (await this.screen(first)).includes("RESUMED_FIXTURE"));
    this.assertNotIn("BEFORE_CRASH", await this.history(first));
  }
  async test_candidate_rejects_incompatible_or_partly_restored_state_without_killing_panes() {
    const first = await this.new();
    await this.new();
    const before = await this.session();
    for (const [mutation, expected] of [
      ["m.version = 999", "UnsupportedStateVersion"],
      ["m.runtime.version = 999", "UnsupportedStateVersion"],
      ["delete m.runtime.version", "MissingStateVersion"],
      ["m.runtime.version = 0", "InvalidStateVersion"],
      ["m.runtime.panes[1].screen.data = 'invalid base64!'", "ReloadCandidateFailed"],
    ]) {
      const candidate = this.candidate(mutation);
      const response = await this.raw_rpc({
        op: "server.reload",
        executable: candidate,
      });
      this.assertEqual(response.err, expected);
      this.assertEqual(before.server_pid, (await this.session()).server_pid);
      this.assertEqual(
        before.panes.map((p: any) => [p.id, p.pid]),
        (await this.session()).panes.map((p: any) => [p.id, p.pid]),
      );
    }
    await this.command("pane.input", {
      target: first,
      data: "printf 'ROLLBACK_%s\\n' OK\r",
    });
    await this.until(async () => (await this.screen(first)).includes("ROLLBACK_OK"));
  }
  async test_reload_drops_input_a_blocked_pane_never_read() {
    const program = join(this.temp.name, "blocked.ts"),
      gate = join(this.temp.name, "gate"),
      received = join(this.temp.name, "received");
    writeExecutable(
      program,
      `#!/usr/bin/env bun
import { existsSync, openSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
spawnSync('stty', ['raw', '-echo'], { stdio: 'inherit' });
console.log('READY');
while (!existsSync(process.argv[2])) await Bun.sleep(10);
const fd = openSync(process.argv[3], 'w');
process.stdin.on('data', data => writeSync(fd, data));
process.stdin.resume();
`,
    );
    const first = await this.new(shellJoin(["bun", program, gate, received]));
    await this.until(async () => (await this.screen(first)).includes("READY"));
    const before = await this.session();
    for (let i = 0; i < 8; i++)
      await this.command("pane.input", {
        data: "a".repeat(65536),
        target: first,
      });
    await this.reload();
    this.assertNotEqual((await this.session()).server_pid, before.server_pid);
    writeFileSync(gate, "");
    await this.command("pane.input", { data: "END", target: first });
    await this.until(() => existsSync(received) && readFileSync(received).toString().endsWith("END"));
    this.assertTrue(statSync(received).size < 8 * 65536 + 3);
  }
  async test_headless_cold_recovery_displays_resume_without_starting_agent() {
    this.env.SHELL = "/bin/bash";
    await this.restart_runtime();
    const ident = (
      await this.rpc({
        op: "headless.start",
        prompt: "test/init",
        provider: "codex",
        cwd: this.temp.name,
      })
    ).session;
    await this.until(async () => (await this.rpc({ op: "headless.list" })).sessions[0].ready);
    await this.headless_command(ident, "test/approval");
    await this.until(async () => (await this.rpc({ op: "headless.list" })).sessions[0].pending_requests === 1);
    await this.rpc({ op: "recovery.save" });
    await this.restart_runtime();
    const sessions = (await this.rpc({ op: "headless.list" })).sessions;
    this.assertTrue(sessions[0].exited);
    this.assertEqual(sessions[0].pid, -1);
    this.assertEqual((await this.session()).panes.length, 1);
    const pane = (await this.session()).panes[0].id;
    await this.until(async () => (await this.screen(pane)).includes("codex resume t"));
    const text = await this.screen(pane);
    this.assertIn("codex resume t", text);
    this.assertIn("requestApproval", text);
  }
  async test_missing_directory_and_removed_socket_directory_do_not_lose_recovery() {
    const folder = join(this.temp.name, "gone");
    mkdirSync(folder);
    const first = await this.new();
    await this.command("pane.input", {
      target: first,
      data: `cd ${quote(folder)}\r`,
    });
    await this.until(async () => (await this.session()).panes[0].cwd === realpathSync(folder));
    await this.rpc({ op: "recovery.save" });
    await this.run_cli("shutdown");
    await this.until(() => !existsSync(this.path));
    rmdirSync(folder);
    const workspaceState = `${this.path}.workspaces.json`;
    if (existsSync(workspaceState)) rmSync(workspaceState);
    await this.run_cli("start");
    this.assertEqual((await this.session()).panes[0].id, first);
    this.assertIn("# Recovered saved output; new shell.", await this.screen(first));
    this.assertEqual((await this.session()).panes[0].cwd, realpathSync(this.temp.name));
  }
  async test_pipelined_requests_remain_ordered_across_handoff() {
    await this.new();
    const before = (await this.session()).server_pid;
    const client = await JsonSocket.connect(this.path);
    try {
      client.socket.write(
        JSON.stringify(versioned({ op: "server.reload", executable: EXE })) +
          "\n" +
          JSON.stringify(versioned({ op: "session.snapshot" })) +
          "\n",
      );
      const first = await client.read(),
        second = await client.read();
      this.assertTrue(first.ok);
      this.assertNotEqual(first.server_pid, before);
      this.assertEqual(second.type, "session");
      this.assertEqual(first.server_pid, second.server_pid);
    } finally {
      client.close();
    }
  }
  async test_headless_partial_initialization_and_deferred_request_survive() {
    const gate = join(this.temp.name, "headless-gate"),
      provider = join(this.temp.name, "provider");
    writeExecutable(
      provider,
      `#!/usr/bin/env bun
import { existsSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('codex-fixture'); process.exit(); }
let buffer = '';
let pending = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => {
  buffer += data;
  while (buffer.includes('\\n')) {
    const end = buffer.indexOf('\\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    pending = pending.then(async () => {
      const v = JSON.parse(line);
      if (v.method === 'initialize') {
        process.stdout.write(JSON.stringify({ id: v.id, result: {} }).slice(0, -3));
        while (!existsSync(${JSON.stringify(gate)})) await Bun.sleep(10);
        process.stdout.write('{}}\\n');
      } else if (v.method === 'thread/start') {
        console.log(JSON.stringify({ id: v.id, result: { thread: { id: 't' } } }));
      } else if (v.method === 'turn/start') {
        console.log(JSON.stringify({ method: 'turn/started', params: { threadId: 't', turn: { id: 'deferred-survived' } } }));
        console.log(JSON.stringify({ id: v.id, result: {} }));
      }
    });
  }
});
process.stdin.resume();
`,
    );
    const cancelled = await JsonSocket.connect(this.path);
    cancelled.send(versioned({ op: "headless.start", prompt: "ping", provider: "codex", cwd: this.temp.name }));
    await this.until(async () => (await this.rpc({ op: "headless.list" })).sessions.length === 1);
    cancelled.close();
    await this.until(async () => (await this.rpc({ op: "headless.list" })).sessions.length === 0);
    const client = await JsonSocket.connect(this.path);
    try {
      client.send(
        versioned({ op: "headless.start", prompt: "ping", provider: "codex", cwd: this.temp.name, request_id: 41 }),
      );
      client.send({ op: "ping", request_id: 42 });
      await this.until(async () => (await this.rpc({ op: "headless.list" })).sessions.length === 1);
      const starting = (await this.rpc({ op: "headless.list" })).sessions[0];
      this.assertEqual(starting.session, null);
      this.assertTrue((await this.rpc({ op: "ping" })).ok);
      await this.reload();
      writeFileSync(gate, "");
      const started = await client.read();
      this.assertEqual(started, { ok: true, provider: "codex", session: "t", request_id: 41 });
      const pong = await client.read();
      this.assertTrue(pong.ok);
      this.assertEqual(pong.request_id, 42);
      this.assertEqual(starting.pid, (await this.rpc({ op: "headless.list" })).sessions[0].pid);
      await this.until(async () =>
        (await this.rpc({ op: "headless.events", provider: "codex", session: started.session })).events.some(
          (e: any) => e.event.kind === "turn" && e.event.turn === "deferred-survived",
        ),
      );
    } finally {
      client.close();
    }
  }
  async test_removed_attachment_cannot_create_a_shell_or_block_reload() {
    const before = await this.session();
    for (const op of ["attach", "input", "size"]) {
      const reply = await this.raw_rpc({
        op,
        cols: 80,
        rows: 24,
        data: "echo unsafe\r",
      });
      this.assertEqual(reply.err, "UnknownOperation");
    }
    this.assertEqual((await this.session()).panes, before.panes);
    const pane = await this.new(),
      a = await Viewer.create(this);
    await this.reload();
    this.assertEqual((await a.poll()).pane, pane);
    this.assertNotEqual(before.server_pid, (await this.session()).server_pid);
  }
}
registerCase("Reloads", Reloads, { inherited: false });
