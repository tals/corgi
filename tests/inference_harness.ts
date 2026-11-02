#!/usr/bin/env bun
/** Deterministic inference fixture. It never contacts a model. */
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const emit = (value: any) => console.log(JSON.stringify(value));
const codex = process.argv.includes("app-server");
const log = process.env.CORGI_INFERENCE_TEST_LOG;
const claudeSchema = process.argv.includes("--json-schema")
  ? JSON.parse(process.argv[process.argv.indexOf("--json-schema") + 1])
  : null;
if (log) appendFileSync(log + ".processes", process.pid + "\n");
let counter = 0,
  thread = "",
  turns = 0,
  schema: any = null;
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const value = JSON.parse(line),
    method = value.method,
    ident = value.id;
  if (method === "initialize") emit({ id: ident, result: {} });
  else if (method === "model/list") {
    if (process.env.CORGI_TEST_MODEL_LOG) appendFileSync(process.env.CORGI_TEST_MODEL_LOG, "models\n");
    emit({
      id: ident,
      result: {
        data: [
          {
            model: "fixture-fast",
            displayName: "Fixture Fast",
            supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
          },
          { model: "fixture-careful", displayName: "Fixture Careful" },
        ],
        nextCursor: null,
      },
    });
  } else if (method === "thread/list") emit({ id: ident, result: { data: [], nextCursor: null } });
  else if (method === "config/read")
    emit({
      id: ident,
      result: {
        config: { model: "fixture-codex", mcp_servers: { fixture: {} } },
      },
    });
  else if (method === "account/read") {
    const path = process.env.CORGI_INFERENCE_TEST_CONTROL,
      control = path ? JSON.parse(readFileSync(path, "utf8")) : {};
    emit({
      id: ident,
      result: {
        account:
          "account" in control
            ? control.account
            : {
                type: "chatgpt",
                email: "codex@example.com",
                planType: "pro",
              },
      },
    });
  } else if (method === "account/rateLimits/read") {
    const path = process.env.CORGI_INFERENCE_TEST_CONTROL,
      control = path ? JSON.parse(readFileSync(path, "utf8")) : {};
    emit({
      id: ident,
      result: {
        rateLimits:
          "rateLimits" in control
            ? control.rateLimits
            : {
                primary: { usedPercent: 23, windowDurationMins: 300 },
                secondary: { usedPercent: 61, windowDurationMins: 10080 },
              },
      },
    });
  } else if (method === "thread/start") {
    if (value.params.config["mcp_servers.fixture.enabled"] !== false)
      throw new Error("fixture MCP server must be disabled");
    counter++;
    turns = 0;
    thread = "thread-" + counter;
    emit({ id: ident, result: { thread: { id: thread } } });
  } else if (method === "thread/unsubscribe") emit({ id: ident, result: {} });
  else if (value.type === "control_request") {
    const index = process.argv.indexOf("--json-schema");
    if (index >= 0) schema = JSON.parse(process.argv[index + 1]);
    emit({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: value.request_id,
        response: {},
      },
    });
  } else if (method === "turn/start" || value.type === "user") {
    const content = codex ? value.params.input[0].text : value.message.content;
    if (content === "crash") process.exit(2);
    if (content === "hang") await Bun.sleep(60000);
    turns++;
    const turn = "turn-" + turns;
    const controlPath = process.env.CORGI_INFERENCE_TEST_CONTROL;
    const control = controlPath ? JSON.parse(readFileSync(controlPath, "utf8")) : {};
    if (log) {
      appendFileSync(log, content + "\n");
      appendFileSync(log + ".sessions", JSON.stringify({ pid: process.pid, thread, turn: turns }) + "\n");
    }
    await Bun.sleep((control.delay || 0) * 1000);
    let result = "label" in control ? control.label : JSON.stringify({ pid: process.pid, thread, turn: turns });
    if (codex) schema = value.params.outputSchema;
    const label = "label" in control ? control.label : "Tracing pane focus";
    const properties = (codex ? schema : claudeSchema)?.properties ?? {};
    const structured =
      "name" in properties
        ? { name: control.name ?? null }
        : "action" in properties
          ? { action: control.action ?? (label === null ? "none" : "new"), label }
          : { label };
    if (schema && ("label" in control || "name" in control)) result = JSON.stringify(structured);
    if ("raw" in control) result = control.raw;
    if (content === "oversize") result = "x".repeat(9000);
    const failed = content === "fail" || !!control.fail;
    if (codex) {
      emit({
        method: "turn/started",
        params: { threadId: thread, turn: { id: turn } },
      });
      const usage = {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: thread,
          tokenUsage: {
            total: {
              inputTokens: 1000 * turns,
              cachedInputTokens: 600 * turns,
              outputTokens: 10 * turns,
            },
            last: {
              inputTokens: 1000,
              cachedInputTokens: 600,
              outputTokens: 10,
            },
          },
        },
      };
      emit(usage);
      emit(usage);
      emit({
        method: "item/completed",
        params: {
          threadId: "wrong-thread",
          turnId: turn,
          item: { type: "agentMessage", text: "Wrong stale result" },
        },
      });
      emit({
        method: "item/completed",
        params: {
          threadId: thread,
          turnId: turn,
          item: { type: "agentMessage", phase: "final_answer", text: result },
        },
      });
      emit({
        method: "turn/completed",
        params: {
          threadId: thread,
          turn: { id: turn, status: failed ? "failed" : "completed" },
        },
      });
      emit({ id: ident, result: { turn: { id: turn } } });
    } else
      emit({
        type: "result",
        session_id: "fixture-session",
        subtype: failed ? "error" : "success",
        is_error: failed,
        result,
        structured_output: structured,
        usage: {
          input_tokens: 300,
          cache_read_input_tokens: 600,
          cache_creation_input_tokens: 100,
          output_tokens: 10,
        },
      });
  }
}
