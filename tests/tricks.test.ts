import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  async agent(name: string, company: boolean | string = false, provider = "claude") {
    const account = typeof company === "string" ? company : company ? this.company : "";
    if (account) mkdirSync(account, { recursive: true });
    const { pane } = await this.open_pane({
      title: name,
      cwd: this.temp.name,
      command: (account ? `CLAUDE_CONFIG_DIR=${quote(account)} ` : "") + quote(join(this.temp.name, "bin", provider)),
    });
    await this.until(async () =>
      (await this.session()).panes.some(
        (p: any) => p.id === pane && p.agent.provider === provider && p.account === account,
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
  async probe(source: string, subscribe = 'events = ["metadata:*"]\nwhere = { provider = "claude" }') {
    const path = join(this.root, "probe");
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, "trick.toml"),
      `version = 1\nid = "probe"\ncommand = [${JSON.stringify(process.execPath)}, "main.mjs"]\n[subscribe]\n${subscribe}\n`,
    );
    writeFileSync(join(path, "main.mjs"), source);
    await this.run_cli("tricks", "reload");
  }
  async sketch(source: string) {
    const path = join(this.root, "probe");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "trick.toml"), 'version = 1\nid = "probe"\nentry = "main.ts"\n');
    writeFileSync(join(path, "label.ts"), 'export const label: string = "Sketch alive";\n');
    writeFileSync(join(path, "main.ts"), source);
    await this.run_cli("tricks", "reload");
  }

  async test_autoreload_preserves_store_and_restarts_only_changed_tricks() {
    await this.agent("Autoreload");
    const code = `import { label } from "./label.ts";
export async function register(on, corgi) {
  const boots = await corgi.get("boots", 0) + 1;
  await corgi.set("boots", boots);
  corgi.draw("counter", { kind: "overlay", anchor: "top-left", text: label + ":" + boots });
}`;
    await this.sketch(code);
    await this.shown("Sketch alive:1");
    const stable = join(this.root, "stable");
    mkdirSync(stable);
    writeFileSync(join(stable, "trick.toml"), 'version = 1\nid = "stable"\nentry = "main.mjs"\n');
    writeFileSync(
      join(stable, "main.mjs"),
      `export async function register(on, corgi) {
      const boots = await corgi.get("boots", 0) + 1;
      await corgi.set("boots", boots);
      corgi.draw("stable", { kind: "overlay", anchor: "bottom-left", text: "Stable:" + boots });
    }`,
    );
    await this.shown("Stable:1");
    const helper = join(this.root, "probe", "label.ts");
    writeFileSync(helper + ".save", 'export const label = "Edited";');
    renameSync(helper + ".save", helper);
    await this.shown("Edited:2");
    await this.shown("Stable:1");
    const entry = join(this.root, "probe", "main.ts");
    writeFileSync(entry, "export function register( broken");
    await this.until(async () =>
      (await this.rpc({ op: "tricks.list" })).tricks.some((t: any) => t.id === "probe" && t.error),
    );
    await this.until(
      async () =>
        !screen_text((await this.client!.poll()).data)
          .join("\n")
          .includes("Edited:2"),
    );
    writeFileSync(entry, code);
    await this.shown("Edited:3");
    await this.shown("Stable:1");
    rmSync(stable, { recursive: true });
    await this.until(async () => !(await this.rpc({ op: "tricks.list" })).tricks.some((t: any) => t.id === "stable"));
    await this.until(
      async () =>
        !screen_text((await this.client!.poll()).data)
          .join("\n")
          .includes("Stable:1"),
    );
  }

  async test_settings_toggle_tricks_and_autoreload_persist_across_restart() {
    await this.agent("Settings");
    await this.shown("0 tasks finished");
    await this.client!.request({ op: "size", cols: 120, rows: 40 });
    await this.client!.action("setup");
    await this.click_text(screen_text(await this.shown("Manage agents")), "Tricks");
    await this.shown("Reload on save");
    await this.click_text(screen_text(await this.shown("completion-jar")), "completion-jar");
    await this.until(async () =>
      (await this.rpc({ op: "tricks.list" })).tricks.some(
        (t: any) => t.id === "completion-jar" && !t.enabled && !t.running,
      ),
    );
    await this.click_text(screen_text(await this.shown("Reload on save")), "Reload on save");
    await this.until(async () => (await this.rpc({ op: "tricks.list" })).autoreload === false);
    await this.client!.input("\x1b\x1b");
    await this.restart_runtime();
    [this.client] = await this.viewer();
    let info = await this.rpc({ op: "tricks.list" });
    this.assertEqual(info.autoreload, false);
    this.assertTrue(info.tricks.some((t: any) => t.id === "completion-jar" && !t.enabled));
    writeFileSync(
      join(this.root, "completion-jar", "main.mjs"),
      'export function register(on, corgi) { corgi.draw("x", { kind: "overlay", text: "Enabled again" }); }',
    );
    await this.rpc({ op: "tricks.configure", id: "completion-jar", enabled: true });
    await this.shown("Enabled again");
    await this.rpc({ op: "tricks.configure", autoreload: true });
    writeFileSync(
      join(this.root, "completion-jar", "main.mjs"),
      'export function register(on, corgi) { corgi.draw("x", { kind: "overlay", text: "Watching again" }); }',
    );
    await this.shown("Watching again");
    this.assertTrue((await this.raw_rpc({ op: "server.reload", executable: EXE })).ok);
    writeFileSync(
      join(this.root, "completion-jar", "main.mjs"),
      'export function register(on, corgi) { corgi.draw("x", { kind: "overlay", text: "Watching after handoff" }); }',
    );
    await this.shown("Watching after handoff");
  }

  async test_typescript_entries_transcripts_opt_in_and_handler_failure_cleanup() {
    await this.sketch(`import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { label } from "./label.ts";
export async function register(on, corgi) {
  const boots: number = (await corgi.get("boots", 0)) + 1;
  await corgi.set("boots", boots);
  corgi.draw("status", { kind: "overlay", text: label });
  on(existsSync("watch") ? ["metadata:*", "transcript"] : "metadata:*", event => {
    appendFileSync("events.jsonl", JSON.stringify({ ...event, boots }) + "\\n");
    if (event.event === "hook" && event.tool === "Watch") {
      writeFileSync("watch", "");
      appendFileSync("events.jsonl", '{"watching":true}\\n');
    }
    if (event.event === "hook" && event.tool === "Crash") {
      setInterval(() => {}, 1000);
      throw Error("TestFailure");
    }
  });
}`);
    const pane = await this.agent("Transcript");
    await this.shown("Sketch alive");
    const path = join(this.temp.name, `trick-${pane}.jsonl`);
    const append = (title: string) =>
      appendFileSync(
        path,
        JSON.stringify({ type: "custom-title", sessionId: `trick-${pane}`, customTitle: title }) + "\n",
      );
    append("Before subscription");
    await this.until(
      async () => (await this.session()).panes.find((p: any) => p.id === pane).agent.name === "Before subscription",
    );
    this.assertTrue(!this.records().some(e => e.event === "transcript"));
    await this.hook(pane, "PreToolUse", "claude", { tool_name: "Watch" });
    await this.until(() => this.records().some(e => e.watching));
    await this.run_cli("tricks", "reload");
    await this.until(() => this.records().some(e => e.event === "snapshot" && e.boots === 2));
    append("After subscription");
    await this.until(() =>
      this.records().some(e => e.event === "transcript" && e.record?.customTitle === "After subscription"),
    );
    this.assertTrue(
      this.records()
        .filter(e => e.event === "transcript")
        .every(e => e.agent.id === `pane:${pane}` && !e.truncated),
    );
    append("x".repeat(40000));
    await this.until(() => this.records().some(e => e.event === "transcript" && e.truncated && e.record === null));
    // A shell's terminal output never joins the event stream.
    await this.open_pane({ command: "printf 'private-pane-content'; sleep 30", cwd: this.temp.name });
    await this.hook(pane, "PreToolUse", "claude", { tool_name: "Crash" });
    await this.until(async () =>
      (await this.rpc({ op: "tricks.list" })).tricks.some((t: any) => t.id === "probe" && !t.running),
    );
    this.assertTrue(!JSON.stringify(this.records()).includes("private-pane-content"));
    this.assertTrue(
      !screen_text((await this.client!.poll()).data)
        .join("\n")
        .includes("Sketch alive"),
    );
    await this.shown("0 tasks finished");
  }

  async test_cpu_and_memory_budgets_stop_runaway_sketches() {
    [this.client] = await this.viewer();
    for (const [source, error] of [
      ["while (true) {} export function register() {}", "CpuLimit"],
      [
        "const held = Buffer.alloc(192 * 1024 * 1024, 1); export function register() { globalThis.held = held; }",
        "MemoryLimit",
      ],
    ]) {
      await this.sketch(source);
      await this.until(
        async () =>
          (await this.rpc({ op: "tricks.list" })).tricks.some((t: any) => t.id === "probe" && t.error === error),
        15,
      );
      await this.shown("0 tasks finished");
    }
  }

  async test_brand_icons_reach_a_graphics_viewer() {
    await this.agent("Brand");
    await this.shown("Brand *");
    await this.client!.request({ op: "size", cols: 100, rows: 30, cell: { width: 9, height: 18 } });
    await this.client!.request({ op: "badge", visible: true });
    await this.until(async () => (await this.client!.poll()).data.includes("a=p,i=730320,"));
  }

  async test_named_ui_hooks_draw_in_their_sites_and_clear_old_patches() {
    await this.sketch(`export function register(on, corgi) {
  on("ui:agent.sidebar", ({ agent, ui }) => {
    if (agent.name !== "Hooked") return;
    ui.append("**Row**");
  });
  on("ui:agent.popover", ({ agent, ui }) => {
    if (agent.name !== "Hooked") return;
    ui.marker(corgi.palette.warm);
    ui.append("**Popover note**");
  });
  on("ui:agent.pane", ({ agent, ui }) => {
    if (agent.name !== "Hooked") return;
    ui.color(corgi.palette.warm);
    ui.append("**Pane note**");
  });
}`);
    const pane = await this.agent("Hooked");
    await this.rpc({ op: "focus", pane });
    const data = await this.shown("Pane note");
    const lines = screen_text(data);
    const row = lines.findIndex((line, index) => index > 0 && line.includes("Hooked"));
    this.assertTrue(row >= 0);
    this.assertTrue(lines[row].includes("Row"));
    this.assertTrue(!lines.join("\n").includes("Popover note"));
    await this.client!.input(`\x1b[<35;6;${row + 1}M`);
    await this.shown("Popover note");
    await this.client!.input("\x1b[<35;99;29M");
    await this.command("pane.rename", { target: pane, name: "Plain" });
    await this.shown("Plain");
    await this.until(async () => {
      const text = screen_text((await this.client!.poll()).data).join("\n");
      return !text.includes("Pane note") && !text.includes("Popover note") && !text.includes("Row");
    });
    this.assertTrue((await this.rpc({ op: "tricks.list" })).tricks.every((t: any) => t.running));
  }

  async test_interactive_fragments_keep_native_ui_and_use_mouse_and_keyboard() {
    await this.sketch(`export function register(on, corgi) {
  let count = 0;
  const press = async name => { await corgi.set("pressed", name + ":" + ++count); };
  on("ui:agent.sidebar", ({ ui }) => ui.append(ui.button("!", () => press("sidebar"))));
  on("ui:agent.popover", ({ ui }) => ui.append(ui.column("**Custom footer**", ui.button("Card", () => press("popover")))));
  on("ui:agent.pane", ({ ui }) => ui.append(ui.row("Pane action", ui.button("Pane", () => press("pane")))));
}`);
    await this.agent("Controls");
    const store = this.path + ".settings.json.tricks/probe.json";
    const saved = () => (existsSync(store) ? JSON.parse(readFileSync(store, "utf8")).values.pressed : null);
    let lines = screen_text(await this.shown("[ ! ]"));
    await this.click_text(lines, "[ ! ]");
    await this.until(() => saved() === "sidebar:1");
    lines = screen_text(await this.shown("[ Pane ]"));
    await this.click_text(lines, "[ Pane ]");
    await this.until(() => saved() === "pane:2");
    lines = screen_text((await this.client!.poll()).data);
    const row = lines.findIndex((line, index) => index > 0 && line.includes("Controls"));
    await this.client!.input(`\x1b[<35;6;${row + 1}M`);
    lines = screen_text(await this.shown("[ Card ]"));
    const y = lines.findIndex(line => line.includes("[ Card ]")),
      x = lines[y].indexOf("[ Card ]");
    await this.client!.input(`\x1b[<35;${x + 2};${y + 1}M`);
    await this.shown("Custom footer");
    await this.click(x + 2, y + 1);
    await this.until(() => saved() === "popover:3");
    await this.client!.input("\x1b[<35;99;29M");
    await this.client!.input("\x02U\r");
    await this.until(() => saved() === "pane:4");
    await this.client!.input("\t\r");
    await this.until(() => saved() === "sidebar:5");
    await this.client!.input("\x1b[Z\x1b");
    const before = await this.client!.poll(),
      stale = before.trick_buttons[0].action;
    await this.run_cli("tricks", "reload");
    await this.shown("[ Pane ]");
    this.assertEqual((await this.rpc({ op: "tricks.press", action: stale, viewer: before.viewer })).accepted, false);
    await this.client!.action("setup");
    await this.client!.action("trick-press", "no-such-button");
    this.assertEqual(saved(), "sidebar:5");
    this.assertTrue((await this.rpc({ op: "tricks.list" })).tricks.every((t: any) => t.running));
  }

  async test_account_picker_reset_and_waiting_agent_buttons_survive_reload_and_target_their_viewer() {
    const personal = await this.agent("Personal"),
      company = await this.agent("Company", true);
    await this.client!.focus(personal);
    const [other] = await this.viewer();
    await other.focus(personal);
    await this.hook(company, "UserPromptSubmit");
    await this.hook(company, "PermissionRequest", "claude", { tool_name: "Bash" });
    const waiting = screen_text(await this.shown("[ Company ]"));
    await this.click_text(waiting, "[ Company ]");
    await this.until(async () => (await this.client!.poll()).pane === company);
    this.assertEqual((await other.poll()).pane, personal);
    await this.hook(company, "PostToolUse", "claude", { tool_name: "Bash" });
    await this.hook(company, "Stop");
    let lines = screen_text(await this.shown("1 tasks finished"));
    await this.click_text(lines, "[ Reset ]");
    await this.shown("0 tasks finished");
    lines = screen_text((await this.client!.poll()).data);
    const row = lines.findIndex((line, index) => index > 0 && line.includes("Company"));
    await this.client!.input(`\x1b[<35;6;${row + 1}M`);
    lines = screen_text(await this.shown("[ Pink ]"));
    await this.click_text(lines, "[ Pink ]");
    const store = this.path + ".settings.json.tricks/account-palette.json";
    const account = JSON.stringify(["claude", this.company]);
    await this.until(
      () => existsSync(store) && JSON.parse(readFileSync(store, "utf8")).values.colors[account]?.syntax === "number",
    );
    await this.client!.input("\x1b[<35;99;29M");
    await this.run_cli("tricks", "reload");
    await this.shown("0 tasks finished");
    this.assertEqual(JSON.parse(readFileSync(store, "utf8")).values.colors[account], { syntax: "number" });
    this.assertIn(trickUi.fg({ syntax: "number" }), (await this.client!.poll()).data);
    this.assertTrue((await this.rpc({ op: "tricks.list" })).tricks.every((t: any) => t.running));
  }

  async test_palette_mapping_distinguishes_custom_accounts_and_remembers_them() {
    const personal = await this.agent("Personal");
    await this.agent("Company", true);
    const client = await this.agent("Client", join(this.temp.name, "client"));
    await this.agent("Company again", true);
    await this.client!.focus(personal);
    const store = this.path + ".settings.json.tricks/account-colors.json";
    const expected = ["", this.company, join(this.temp.name, "client")].map(account =>
      JSON.stringify(["claude", account]),
    );
    const assignments = () => JSON.parse(readFileSync(store, "utf8")).values["palette.accounts"].keys;
    const shown = async () => {
      const data = (await this.client!.poll()).data;
      return [
        trickUi.fg({ syntax: "string" }),
        ...[palette.syntax.keyword, palette.syntax.type].map(color =>
          palette.fgRgb(palette.mix(color, palette.colors.bg, 45)),
        ),
      ].every(color => data.includes(color));
    };
    await this.until(shown);
    this.assertEqual(assignments(), expected);
    await this.command("pane.rename", { target: client, name: "Renamed" });
    await this.shown("Renamed *");
    this.assertEqual(assignments(), expected);
    await this.restart_runtime();
    [this.client] = await this.viewer();
    await this.client.focus(personal);
    await this.until(shown);
    this.assertEqual(assignments(), expected);
  }

  async test_examples_draw_account_colors_flair_attention_and_durable_completions() {
    const personal = await this.agent("Personal"),
      company = await this.agent("Company", true);
    await this.rpc({ op: "focus", pane: personal });
    const list = JSON.parse(await this.run_cli("tricks", "list", "--json"));
    this.assertEqual(list.tricks.length, 5);
    this.assertTrue(
      list.tricks.every((t: any) => t.running),
      JSON.stringify(list),
    );
    await this.shown("Company *");
    const panes = (await this.session()).panes;
    this.assertEqual(panes.find((p: any) => p.id === company).account, this.company);
    const data = await this.shown("0 tasks finished");
    this.assertIn(palette.fgRgb(palette.mix(palette.syntax.keyword, palette.colors.bg, 45)), data);
    this.assertIn(trickUi.fg({ brand: "claude" }), data);
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
    await this.shown("Company *");
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
  if (e.event === "hook" && e.tool === "Filter") send({ id: "filter", op: "subscribe", events: ["snapshot", "agent.changed", "hook"], where: { provider: "claude", state: "blocked" } });
  if (e.event === "hook" && e.tool === "Exit") process.exit(0);
});`);
    const claude = await this.agent("Filtered"),
      codex = await this.agent("Other", false, "codex");
    await this.shown("Probe alive");
    await this.until(() => this.records().some(e => e.event === "agent.changed" && e.agent.id === `pane:${claude}`));
    await this.hook(codex, "UserPromptSubmit", "codex");
    await this.hook(claude, "UserPromptSubmit");
    await this.until(() => this.records().some(e => e.event === "hook" && e.kind === "prompt"));
    const records = this.records();
    this.assertTrue(records.some(e => e.id === "bad" && e.error === "ControlCharacter"));
    this.assertTrue(records.some(e => e.id === "read" && e.result === 1));
    this.assertTrue(records.filter(e => e.agent).every(e => e.agent.provider === "claude"));
    this.assertTrue(
      records.filter(e => e.event === "snapshot").every(e => e.agents.every((a: any) => a.provider === "claude")),
    );
    await this.hook(claude, "PermissionRequest", "claude", {
      tool_name: "Filter",
      tool_input: { command: "private-tool-input" },
      tool_response: "private-tool-output",
    });
    await this.until(() => this.records().some(e => e.id === "filter" && e.ok));
    this.assertTrue(!JSON.stringify(this.records()).includes("private-tool-"));
    await this.hook(claude, "PostToolUse", "claude", { tool_name: "Bash" });
    await this.until(() =>
      this.records().some(
        e => e.event === "agent.changed" && e.previous?.state === "blocked" && e.agent.state === "working",
      ),
    );
    await this.hook(claude, "PermissionRequest", "claude", { tool_name: "Exit" });
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
    await this.shown("Personal *");
  }

  async test_a_noisy_trick_is_stopped_without_affecting_other_tricks() {
    await this.probe('process.stdout.write("x".repeat(65537)); setInterval(() => {}, 1000);', "events = []");
    await this.until(async () =>
      (await this.rpc({ op: "tricks.list" })).tricks.some((t: any) => t.id === "probe" && t.error === "OutputLimit"),
    );
    await this.agent("Still works");
    await this.shown("Still works *");
    await this.shown("0 tasks finished");
  }
}
registerCase("tricks", Tricks, { timeout: 60_000 });
