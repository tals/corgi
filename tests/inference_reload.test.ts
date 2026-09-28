import { join } from "node:path";
import { writeFileSync, chmodSync } from "node:fs";
import { registerCase, sleep } from "./support";
import { EXE } from "./runtime";
import { A } from "./codex_titles";
import { Summaries, lines } from "./activity_summary";

class InferenceReload extends Summaries {
  sessions() {
    return lines(this.log + ".sessions").map((v) => JSON.parse(v));
  }
  async reload() {
    const result = await this.rpc({
      op: "server.reload",
      protocol: 1,
      executable: EXE,
    });
    await this.attachment.select(A);
    return result;
  }
  async verify_continuity(provider: string) {
    await this.rpc({
      op: "inference.configure",
      protocol: 1,
      choice: provider,
    });
    await this.start_turn("before-reload", false);
    await this.until(
      async () => (await this.state()).activity === "Tracing pane focus",
    );
    const first = this.sessions()[0],
      before = await this.session();
    await this.reload();
    this.assertNotEqual((await this.session()).server_pid, before.server_pid);
    await sleep(1);
    this.assertEqual(
      this.sessions().length,
      1,
      "unchanged evidence was billed again",
    );
    this.assertEqual((await this.session()).inference.provider, provider);
    this.assertTrue((await this.session()).inference.locked);
    this.assertEqual(
      (await this.session()).system_usage.tokens,
      before.system_usage.tokens,
    );
    await this.start_turn("after-reload", false);
    await this.until(() => this.sessions().length >= 2);
    await this.until(
      async () => (await this.state()).activity === "Tracing pane focus",
    );
    const second = this.sessions()[1];
    this.assertEqual(
      [second.pid, second.thread, second.turn],
      [first.pid, first.thread, 2],
    );
    // The same live conversation continues, so recovery history is not resent.
    this.assertEqual(JSON.parse(this.calls()[1]).history, undefined);
    const beforePid = (await this.session()).server_pid;
    const candidate = join(this.temp.name, "reject-after-inference-import");
    writeFileSync(
      candidate,
      `#!${process.execPath}\nimport { readFileSync, ftruncateSync, writeSync } from 'node:fs';\nimport {dlopen,FFIType} from 'bun:ffi';\nconst libc=process.platform==='darwin'?'/usr/lib/libSystem.B.dylib':'libc.so.6';const seek=dlopen(libc,{lseek:{args:[FFIType.i32,FFIType.i64,FFIType.i32],returns:FFIType.i64}}).symbols.lseek;const fd=Number(process.argv[3]);const m=JSON.parse(readFileSync(fd,'utf8'));m.clients[0].interests=Array(129).fill({pane:1,cols:80,rows:24});seek(fd,0,0);ftruncateSync(fd,0);writeSync(fd,JSON.stringify(m),0,'utf8');seek(fd,0,0);process.execve(${JSON.stringify(EXE)},[${JSON.stringify(EXE)},...process.argv.slice(2)],process.env);\n`,
    );
    chmodSync(candidate, 0o700);
    for (const executable of ["/usr/bin/false", candidate]) {
      const failure = await this.raw_rpc({
        op: "server.reload",
        protocol: 1,
        executable,
      });
      this.assertEqual(failure.err, "ReloadCandidateFailed");
      this.assertEqual((await this.session()).server_pid, beforePid);
    }
    await this.start_turn("after-failed-candidate", false);
    await this.until(() => this.sessions().length >= 3);
    await this.until(
      async () => (await this.state()).activity === "Tracing pane focus",
    );
    this.assertEqual(
      [this.sessions()[2].pid, this.sessions()[2].turn],
      [first.pid, 3],
    );
    await this.reload();
    await this.start_turn("after-second-reload", false);
    await this.until(() => this.sessions().length >= 4);
    await this.until(
      async () => (await this.state()).activity === "Tracing pane focus",
    );
    this.assertEqual(
      [this.sessions()[3].pid, this.sessions()[3].turn],
      [first.pid, 4],
    );
  }
  async test_codex_conversation_survives_success_and_rollback() {
    await this.verify_continuity("codex");
  }
  async test_claude_conversation_survives_success_and_rollback() {
    await this.verify_continuity("claude");
  }
  async test_reload_finishes_inflight_request_and_transfers_pending_result() {
    writeFileSync(
      this.control,
      JSON.stringify({ delay: 1.5, label: "Fixing cursor visibility" }),
    );
    await this.start_turn("inflight", false);
    await this.until(() => this.sessions().length === 1);
    const first = this.sessions()[0];
    this.assertEqual((await this.state()).activity, "");
    await this.reload();
    await this.until(
      async () => (await this.state()).activity === "Fixing cursor visibility",
    );
    this.assertEqual(
      this.sessions().length,
      1,
      "in-flight request was replayed",
    );
    writeFileSync(
      this.control,
      JSON.stringify({ delay: 0, label: "Checking cursor behavior" }),
    );
    await this.start_turn("follow-up", false);
    await this.until(
      async () => (await this.state()).activity === "Checking cursor behavior",
    );
    this.assertEqual(
      [this.sessions()[1].pid, this.sessions()[1].turn],
      [first.pid, 2],
    );
  }
}
registerCase("InferenceReload", InferenceReload, { inherited: false });
