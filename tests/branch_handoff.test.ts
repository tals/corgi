import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Runtime, EXE } from "./runtime";
import * as support from "./support";
import * as formats from "../src/persist/formats";
import * as handoff_info from "../src/persist/handoff_info";

class BranchHandoff extends Runtime {
  async test_compiled_format_probe_reads_the_registry_without_loading_the_daemon() {
    const reply = await support.run([EXE, "__handoff-info"], {
      env: { ...this.env, CORGI_NATIVE_ROOT: join(this.temp.name, "absent-native-libraries") },
    });
    this.assertEqual(JSON.parse(reply.stdout), handoff_info.info());
  }
  candidate(name: string, reject = false) {
    const path = join(this.temp.name, name),
      info = JSON.stringify({ handoff: 1, formats: [randomBytes(6).toString("hex"), formats.baseline] });
    writeFileSync(
      path,
      `#!/bin/sh
if [ "$1" = __handoff-info ]; then
  printf '%s\\n' ${support.quote(info)}
  exit 0
fi
${reject ? "printf 'InvalidHandoffCore\\n' >&4; exit 1" : `exec ${support.quote(EXE)} "$@"`}
`,
      { mode: 0o700 },
    );
    return path;
  }
  async pane() {
    return (
      await this.command("pane.create", { workspace: (await this.session()).workspaces[0].id, command: "exec /bin/sh" })
    ).pane as number;
  }
  async read(pane: number) {
    return (await this.command("pane.read", { target: pane, view: "screen" })).text as string;
  }
  async test_divergent_formats_preserve_shell_identity_and_memory_in_both_directions() {
    const pane = await this.pane();
    await this.command("pane.input", { target: pane, data: "branch_token=memory_only\r" });
    const before = await this.session(),
      pid = before.panes.find((p: any) => p.id === pane).pid;
    for (const candidate of [
      this.candidate("branch-a"),
      this.candidate("branch-b"),
      EXE,
      this.candidate("branch-a-again"),
    ]) {
      await this.rpc({ op: "server.reload", executable: candidate });
      this.assertEqual((await this.session()).panes.find((p: any) => p.id === pane).pid, pid);
      await this.command("pane.input", { target: pane, data: 'printf \'SURVIVED_%s_%s\\n\' "$branch_token" "$$"\r' });
      await this.until(async () => (await this.read(pane)).includes(`SURVIVED_memory_only_${pid}`));
    }
  }
  async test_rejected_candidate_keeps_the_source_and_its_shell_usable() {
    const pane = await this.pane(),
      before = await this.session();
    const result = await this.raw_rpc({ op: "server.reload", executable: this.candidate("rejected", true) });
    this.assertTrue(typeof result.err === "string");
    const after = await this.session();
    this.assertEqual(after.server_pid, before.server_pid);
    this.assertEqual(after.panes.find((p: any) => p.id === pane).pid, before.panes.find((p: any) => p.id === pane).pid);
    await this.command("pane.input", { target: pane, data: "printf 'SOURCE_%s\\n' ALIVE\r" });
    await this.until(async () => (await this.read(pane)).includes("SOURCE_ALIVE"));
  }
  async test_compiled_branch_round_trip_preserves_the_shell() {
    const pane = await this.pane(),
      before = await this.session(),
      other = process.env.CORGI_BRANCH_EXE!;
    await this.command("pane.input", { target: pane, data: "compiled_branch=still_here\r" });
    for (const executable of [other, EXE, other, EXE]) {
      await this.rpc({ op: "server.reload", executable });
      const after = await this.session();
      this.assertEqual(
        after.panes.find((p: any) => p.id === pane).pid,
        before.panes.find((p: any) => p.id === pane).pid,
      );
      await this.command("pane.input", { target: pane, data: "printf 'COMPILED_%s\\n' \"$compiled_branch\"\r" });
      await this.until(async () => (await this.read(pane)).includes("COMPILED_still_here"));
    }
  }
  async test_cold_recovery_restarts_and_exercises_every_shell() {
    const panes: number[] = [];
    for (let i = 0; i < 8; i++) {
      const pane = await this.pane();
      panes.push(pane);
      await this.command("pane.input", { target: pane, data: `stty -echo; printf 'BEFORE_%s\\n' ${pane}\r` });
      await this.until(async () => (await this.read(pane)).includes(`BEFORE_${pane}`));
    }
    const before = await this.session();
    await this.rpc({ op: "recovery.save" });
    process.kill(before.server_pid, "SIGKILL");
    await this.until(() => {
      try {
        process.kill(before.server_pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    await this.run_cli("start");
    const after = await this.session();
    for (const id of panes) {
      const pane = after.panes.find((p: any) => p.id === id);
      this.assertGreater(pane.pid, 0);
      this.assertFalse(pane.dormant);
      this.assertNotEqual(pane.pid, before.panes.find((p: any) => p.id === id).pid);
      this.assertIn(`BEFORE_${id}`, await this.read(id));
      await this.command("pane.input", { target: id, data: `stty -echo; printf 'RECOVERED_%s_%s\\n' ${id} "$$"\r` });
      await this.until(async () => (await this.read(id)).includes(`RECOVERED_${id}_${pane.pid}`));
    }
  }
  async test_rejected_metadata_retries_with_core_and_preserves_the_shell() {
    const pane = await this.pane(),
      before = await this.session(),
      path = join(this.temp.name, "reject-metadata"),
      inspect = path + ".ts";
    writeFileSync(
      inspect,
      `
import { fstatSync, readSync, writeSync } from "node:fs";
const bytes = Buffer.alloc(fstatSync(3).size);
for (let offset = 0; offset < bytes.length;)
  offset += readSync(3, bytes, offset, bytes.length - offset, offset);
const state = JSON.parse(bytes.toString());
if (state.payload !== null) {
  writeSync(4, "InvalidCheckpoint\\n");
  process.exit(1);
}
`,
    );
    writeFileSync(
      path,
      `#!/bin/sh
if [ "$1" = __handoff ]; then
  ${support.quote(process.execPath)} ${support.quote(inspect)} || exit 1
fi
exec ${support.quote(EXE)} "$@"
`,
      { mode: 0o700 },
    );
    await this.command("pane.input", { target: pane, data: "retry_token=retained\r" });
    const result = await this.raw_rpc({ op: "server.reload", executable: path });
    this.assertTrue(result.ok, result.err + "\n" + readFileSync(join(this.temp.name, "server.log"), "utf8"));
    this.assertEqual((await this.session()).panes.find((p: any) => p.id === pane).pid, before.panes[0].pid);
    await this.command("pane.input", { target: pane, data: "printf 'RETRY_%s\\n' \"$retry_token\"\r" });
    await this.until(async () => (await this.read(pane)).includes("RETRY_retained"));
  }
  async preflight(change: (state: any) => void) {
    const pane = await this.pane();
    await this.command("pane.input", { target: pane, data: "printf 'RECOVERY_%s\\n' CORE\r" });
    await this.until(async () => (await this.read(pane)).includes("RECOVERY_CORE"));
    const saved = await this.rpc({ op: "recovery.save" });
    const file =
      saved.path ??
      join(
        this.env.XDG_STATE_HOME!,
        "corgi",
        "recovery",
        `runtime-${Bun.hash.wyhash(this.path, 0n).toString(16)}.json`,
      );
    const state = JSON.parse(readFileSync(file, "utf8"));
    change(state);
    writeFileSync(file, JSON.stringify(state));
    const checked = Bun.spawn([EXE, "__update-check", this.path, file], {
      env: this.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    this.assertEqual(JSON.parse(await new Response(checked.stdout).text()), { ok: true });
    this.assertEqual(await checked.exited, 0);
  }
  async test_unknown_recovery_format_passes_preflight_and_recovers_core() {
    await this.preflight(state => {
      state.transfer.format = randomBytes(6).toString("hex");
      state.version = 999;
      state.panes = "future panes";
    });
  }
  async test_preflight_discards_invalid_metadata_under_a_known_revision() {
    await this.preflight(state => {
      const payload = JSON.parse(state.transfer.payload);
      payload.runtime.closed = [{}];
      state.transfer.payload = JSON.stringify(payload);
    });
  }
}
support.registerCase("BranchHandoff", BranchHandoff, {
  inherited: false,
  skipTests: process.env.CORGI_BRANCH_EXE
    ? {}
    : { test_compiled_branch_round_trip_preserves_the_shell: "requires a different-format CORGI_BRANCH_EXE" },
});
