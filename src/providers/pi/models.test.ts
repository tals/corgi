import { test, expect } from "bun:test";
import { parse, read } from "./models";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Quit } from "../../subprocess";
const model = (provider: string, id: string, cost: unknown = { input: 1, output: 5 }) => ({
  provider,
  id,
  name: id,
  input: ["text"],
  cost,
});
test("discovery checks each login with refresh and rejects stale OAuth before exposing models", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-pi-models-")),
    previous = process.env.CORGI_PI_BIN;
  const bin = join(root, "pi");
  process.env.CORGI_PI_BIN = bin;
  writeFileSync(
    join(root, "auth.json"),
    JSON.stringify({ "openai-codex": { type: "oauth" }, anthropic: { type: "oauth", access: "expired" } }),
  );
  writeFileSync(
    bin,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const args = process.argv.slice(2), root = process.env.PI_CODING_AGENT_DIR;
appendFileSync(join(root,"calls.jsonl"),JSON.stringify(args)+"\\n");
if(args[0]==="auth") {
  const provider=args[args.indexOf("--provider")+1];
  console.log(JSON.stringify({provider,status:provider==="openai-codex"?"ready":"invalid"}));
  process.exit(provider==="openai-codex"?0:2);
}
createInterface({input:process.stdin}).on("line",line=>{
  const request=JSON.parse(line);
  console.log(JSON.stringify({type:"response",id:request.id,success:true,data:{models:["openai-codex","anthropic","unrelated"].map(provider=>({provider,id:"model",name:"Model",input:["text"],cost:{input:1,output:5}}))}}));
});
`,
    { mode: 0o755 },
  );
  try {
    const models = await read(root, new Quit());
    expect(models.map(m => m.id)).toEqual(["openai-codex/model"]);
    const calls = readFileSync(join(root, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(l => JSON.parse(l));
    const checks = calls.filter(args => args[0] === "auth");
    expect(checks).toHaveLength(3);
    expect(checks.every(args => !args.includes("--no-refresh") && !args.includes("--credentials"))).toBe(true);
    expect(calls[0]).toContain("--no-session");
    expect(calls[0]).toContain("--offline");
  } finally {
    if (previous === undefined) delete process.env.CORGI_PI_BIN;
    else process.env.CORGI_PI_BIN = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi discovery keeps only usable chat definitions and never returns credentials", () => {
  const result = parse(
    {
      models: [
        model("anthropic", "haiku"),
        model("custom", "tiny"),
        model("anthropic", "haiku"),
        { ...model("bad", "image"), input: ["image"] },
        model("bad", "line\nbreak"),
      ],
    },
    { anthropic: { type: "oauth", access: "secret" }, custom: { type: "oauth" } },
  );
  expect(result).toHaveLength(2);
  expect(result[0]).toMatchObject({ id: "anthropic/haiku", subscription: true, input_cost: 1, output_cost: 5 });
  expect(result[1].subscription).toBe(false);
  expect(JSON.stringify(result)).not.toContain("secret");
});
test("Pi model identities come from each provider's own credentials", () => {
  const access = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/profile": { email: "openai@example.com" }, "https://api.openai.com/auth": { chatgpt_plan_type: "promax" } })).toString("base64url")}.secret`,
    result = parse(
      { models: [model("anthropic", "haiku"), model("openai-codex", "luna"), model("custom", "tiny")] },
      {
        anthropic: { type: "oauth", email: "claude@example.com\x1b", access: "other-secret" },
        "openai-codex": { type: "oauth", access },
      },
    );
  expect(result.map(m => m.user)).toEqual(["claude@example.com", "openai@example.com", undefined]);
  expect(result.map(m => m.plan)).toEqual([undefined, "Pro 500", undefined]);
  expect(JSON.stringify(result)).not.toContain("secret");
});
test("catalog entries from stale or unverified logins are excluded", () => {
  const result = parse(
    { models: [model("anthropic", "haiku"), model("openai-codex", "luna"), model("unknown", "random")] },
    { anthropic: { type: "oauth", access: "expired", refresh: "invalid" }, "openai-codex": { type: "oauth" } },
    new Set(["openai-codex"]),
  );
  expect(result.map(m => m.id)).toEqual(["openai-codex/luna"]);
});

test("API credentials are not subscriptions and zero or missing prices aren't guessed free", () => {
  const result = parse(
    {
      models: [
        model("anthropic", "haiku"),
        model("custom", "unknown", {}),
        model("custom", "zero", { input: 0, output: 0 }),
        model("openrouter", "tiny:free", { input: 0, output: 0 }),
        model("custom", "negative", { input: -1, output: 1 }),
      ],
    },
    { anthropic: { type: "api_key" } },
  );
  expect(result[0].subscription).toBe(false);
  expect(result.map(m => m.input_cost)).toEqual([1, null, null, 0, null]);
  expect(() => parse({}, {})).toThrow("InvalidModels");
});

test("native thinking metadata supplies the supported ladder and default effort", () => {
  const values = parse(
    {
      models: [
        {
          ...model("custom", "thinking"),
          reasoning: true,
          thinking: { efforts: ["low", "high"], defaultLevel: "high" },
        },
      ],
    },
    {},
  );
  expect(values[0].efforts).toEqual(["low", "high"]);
  expect(values[0].default_effort).toBe("high");
});
