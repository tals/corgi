import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Runtime, screen_text } from "./runtime";
import { EXE, ROOT, registerCase, quote } from "./support";
import { write_ordinary_agent } from "./provider_sim";
import * as trickUi from "../src/trick_ui";
import * as palette from "../src/palette";

class Tricks extends Runtime {
  root!: string;
  company!: string;
  seq = 0;
  async configure() {
    this.root = join(this.env.XDG_CONFIG_HOME!, "corgi/tricks");
    this.company = join(this.temp.name, "company");
    write_ordinary_agent(join(this.temp.name, "bin", "claude"));
    write_ordinary_agent(join(this.temp.name, "bin", "codex"));
    mkdirSync(this.company, { recursive: true });
    cpSync(join(ROOT, "examples/tricks"), this.root, { recursive: true });
    const manifest = join(this.root, "account-colors/trick.toml");
    writeFileSync(
      manifest,
      readFileSync(manifest, "utf8").replace("/replace/with/company/claude-config", this.company),
    );
  }
  async hook(pane: number, event: string, provider = "claude", extra = {}) {
    this.seq = Math.max(this.seq + 1, Math.floor(Date.now() * 1000));
    const transcript = join(this.temp.name, `trick-${pane}.jsonl`);
    if (!existsSync(transcript)) writeFileSync(transcript, "");
    const reply = await this.rpc({
      op: "hook",
      pane,
      provider,
      seq: this.seq,
      event: {
        hook_event_name: event,
        session_id: `trick-${pane}`,
        transcript_path: transcript,
        ...extra,
      },
    });
    if (event === "Stop" && provider === "claude")
      appendFileSync(
        transcript,
        JSON.stringify({
          type: "system",
          subtype: "turn_duration",
          sessionId: `trick-${pane}`,
          timestamp: new Date(Math.ceil(this.seq / 1000) + 1).toISOString(),
        }) + "\n",
      );
    return reply;
  }
  async agent(name: string, company = false, provider = "claude") {
    const { pane } = await this.open_pane({
      title: name,
      cwd: this.temp.name,
      command:
        (company ? `CLAUDE_CONFIG_DIR=${quote(this.company)} ` : "") + quote(join(this.temp.name, "bin", provider)),
    });
    await this.until(async () =>
      (await this.session()).panes.some(
        (p: any) => p.id === pane && p.agent.provider === provider && (!company || p.account === this.company),
      ),
    );
    await this.hook(pane, "SessionStart", provider);
    await this.command("pane.rename", { target: pane, name });
    return pane;
  }
  async shown(text: string) {
    try {
      return await this.until(async () => {
        const state = await this.client!.poll();
        return screen_text(state.data).join("\n").includes(text) ? state.data : null;
      });
    } catch {
      throw Error(
        `Missing ${text}:\n${screen_text((await this.client!.poll()).data).join("\n")}\n${JSON.stringify(await this.rpc({ op: "tricks.list" }))}\n${readFileSync(join(this.temp.name, "server.log"), "utf8")}`,
      );
    }
  }
  records() {
    const path = join(this.root, "probe/events.jsonl");
    return existsSync(path)
      ? readFileSync(path, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(line => JSON.parse(line))
      : [];
  }
  async probe(source: string, subscribe = 'events = ["*"]\nwhere = { provider = "claude" }') {
    const path = join(this.root, "probe");
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, "trick.toml"),
      `version = 1\nid = "probe"\ncommand = [${JSON.stringify(process.execPath)}, "main.mjs"]\n[subscribe]\n${subscribe}\n`,
    );
    writeFileSync(join(path, "main.mjs"), source);
    await this.run_cli("tricks", "reload");
  }

  async test_examples_draw_account_colors_flair_attention_and_durable_completions() {
    const personal = await this.agent("Personal"),
      company = await this.agent("Company", true);
    await this.rpc({ op: "focus", pane: personal });
    const list = JSON.parse(await this.run_cli("tricks", "list", "--json"));
    this.assertEqual(list.tricks.length, 4);
    this.assertTrue(
      list.tricks.every((t: any) => t.running),
      JSON.stringify(list),
    );
    await this.shown("Company ✦");
    const panes = (await this.session()).panes;
    this.assertEqual(panes.find((p: any) => p.id === company).account, this.company);
    const data = await this.shown("0 tasks finished");
    this.assertIn(palette.fgRgb(palette.mix(trickUi.rgb("#83b6ef"), palette.colors.bg, 45)), data);
    await this.hook(company, "UserPromptSubmit");
    await this.hook(company, "PermissionRequest", "claude", { tool_name: "Bash" });
    await this.shown("1 waiting for you");
    await this.hook(company, "PostToolUse", "claude", { tool_name: "Bash" });
    await this.hook(company, "Stop");
    await this.shown("1 tasks finished");
    await this.until(
      async () =>
        !screen_text((await this.client!.poll()).data)
          .join("\n")
          .includes("waiting for you"),
    );
    await this.run_cli("tricks", "reload");
    await this.shown("1 tasks finished");
    this.assertEqual(
      (await this.raw_rpc({ op: "server.reload", executable: "/bin/false" })).err,
      "ReloadCandidateFailed",
    );
    await this.shown("1 tasks finished");
    // The new daemon restarts trick processes after committing the handoff.
    this.assertTrue((await this.raw_rpc({ op: "server.reload", executable: EXE })).ok);
    await this.shown("1 tasks finished");
    await this.shown("Company ✦");
    await this.restart_runtime();
    [this.client] = await this.viewer();
    await this.shown("1 tasks finished");
  }

  async test_filtered_firehose_rpc_errors_store_and_crash_cleanup() {
    await this.probe(`import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const send = v => console.log(JSON.stringify(v));
createInterface({ input: process.stdin }).on("line", line => {
  const e = JSON.parse(line);
  appendFileSync("events.jsonl", line + "\\n");
  if (e.event === "ready") {
    send({ id: "bad", op: "ui.set", key: "bad", view: { kind: "overlay", lines: [[{ text: "\\u001b[2J" }]] } });
    send({ id: "write", op: "kv.set", key: "boots", value: (e.kv.boots ?? 0) + 1 });
    send({ id: "read", op: "kv.get", key: "boots" });
    send({ op: "ui.set", key: "probe", view: { kind: "overlay", anchor: "top-left", lines: [[{ text: "Probe alive" }]] } });
  }
  if (e.event === "hook" && e.data.filter) send({ id: "filter", op: "subscribe", events: ["snapshot", "agent.changed", "hook"], where: { provider: "claude", state: "blocked" } });
  if (e.event === "hook" && e.data.exit_trick) process.exit(0);
});`);
    const claude = await this.agent("Filtered"),
      codex = await this.agent("Other", false, "codex");
    await this.shown("Probe alive");
    await this.until(() => this.records().some(e => e.event === "agent.changed" && e.agent.id === `pane:${claude}`));
    await this.hook(codex, "UserPromptSubmit", "codex");
    await this.hook(claude, "UserPromptSubmit");
    await this.until(() =>
      this.records().some(e => e.event === "hook" && e.data.hook_event_name === "UserPromptSubmit"),
    );
    const records = this.records();
    this.assertTrue(records.some(e => e.id === "bad" && e.error === "ControlCharacter"));
    this.assertTrue(records.some(e => e.id === "read" && e.result === 1));
    this.assertTrue(records.filter(e => e.agent).every(e => e.agent.provider === "claude"));
    this.assertTrue(
      records.filter(e => e.event === "snapshot").every(e => e.agents.every((a: any) => a.provider === "claude")),
    );
    await this.hook(claude, "PermissionRequest", "claude", { tool_name: "Bash", filter: true });
    await this.until(() => this.records().some(e => e.id === "filter" && e.ok));
    await this.hook(claude, "PostToolUse", "claude", { tool_name: "Bash" });
    await this.until(() =>
      this.records().some(
        e => e.event === "agent.changed" && e.previous?.state === "blocked" && e.agent.state === "working",
      ),
    );
    await this.hook(claude, "PermissionRequest", "claude", { tool_name: "Bash", exit_trick: true });
    await this.until(async () =>
      (await this.rpc({ op: "tricks.list" })).tricks.some((t: any) => t.id === "probe" && !t.running),
    );
    this.assertTrue(
      !screen_text((await this.client!.poll()).data)
        .join("\n")
        .includes("Probe alive"),
    );
    await this.run_cli("tricks", "reload");
    await this.until(() => this.records().some(e => e.id === "read" && e.result === 2));
    await this.shown("Probe alive");
  }

  async test_disabling_clears_drawings_and_corrupt_stores_are_not_overwritten() {
    await this.agent("Personal");
    await this.shown("0 tasks finished");
    const manifest = join(this.root, "completion-jar/trick.toml");
    const enabled = readFileSync(manifest, "utf8");
    writeFileSync(manifest, "enabled = false\n" + enabled);
    await this.run_cli("tricks", "reload");
    await this.until(
      async () =>
        !screen_text((await this.client!.poll()).data)
          .join("\n")
          .includes("tasks finished"),
    );
    const store = this.path + ".settings.json.tricks/completion-jar.json";
    mkdirSync(join(store, ".."), { recursive: true });
    writeFileSync(store, "{corrupt");
    writeFileSync(manifest, enabled);
    await this.run_cli("tricks", "reload");
    const status = (await this.rpc({ op: "tricks.list" })).tricks.find((t: any) => t.id === "completion-jar");
    this.assertTrue(!status.running && status.error);
    this.assertEqual(readFileSync(store, "utf8"), "{corrupt");
    await this.shown("Personal ✦");
  }

  async test_a_noisy_trick_is_stopped_without_affecting_other_tricks() {
    await this.probe('process.stdout.write("x".repeat(65537)); setInterval(() => {}, 1000);', "events = []");
    await this.until(async () =>
      (await this.rpc({ op: "tricks.list" })).tricks.some((t: any) => t.id === "probe" && t.error === "OutputLimit"),
    );
    await this.agent("Still works");
    await this.shown("Still works ✦");
    await this.shown("0 tasks finished");
  }
}
registerCase("tricks", Tricks, { timeout: 60_000 });
