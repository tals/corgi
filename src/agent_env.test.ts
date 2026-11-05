import { expect, test } from "bun:test";
import * as agentEnv from "./agent_env";

test("public agent metadata contains only the CORGI namespace, with bounded values", () => {
  const env = agentEnv.read(
    Object.entries({
      CORGI_PROFILE: "work",
      CORGI_custom: "custom",
      CORGI_SOCKET: "/tmp/corgi.sock",
      ANTHROPIC_API_KEY: "secret",
      OPENAI_API_KEY: "secret",
      SSH_AUTH_SOCK: "/tmp/auth.sock",
      CORGI_OVERSIZED: "x".repeat(5000),
      CORGI_INVALID: { nested: "not an environment value" },
    }),
  );
  expect(env).toEqual({ CORGI_PROFILE: "work", CORGI_custom: "custom", CORGI_SOCKET: "/tmp/corgi.sock" });
  expect(Object.keys(agentEnv.read(Array.from({ length: 200 }, (_, i) => [`CORGI_${i}`, "v"] as const)))).toHaveLength(
    128,
  );
});

test("Trick processes get runtime basics and CORGI variables without credential inheritance", () => {
  expect(
    agentEnv.trick({
      HOME: "/home/test",
      PATH: "/bin",
      LANG: "C.UTF-8",
      CORGI_PROFILE: "work",
      AWS_SECRET_ACCESS_KEY: "secret",
      GH_TOKEN: "secret",
      BUN_OPTIONS: "--preload=/secret.ts",
    }),
  ).toEqual({ HOME: "/home/test", PATH: "/bin", LANG: "C.UTF-8", CORGI_PROFILE: "work" });
});
