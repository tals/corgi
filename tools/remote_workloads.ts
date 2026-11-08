import { join } from "node:path";
import { shellQuote } from "../src/os";

export function workloads(tools: string, machine: string): [string, string | null][] {
  return [
    ["terminal", null],
    ["working agent", "claude --sandbox-state working --sandbox-interval 8 --sandbox-name checking-network-recovery"],
    ["idle Claude", [process.execPath, join(tools, "remote_agent.ts"), "claude"].map(shellQuote).join(" ")],
    ["idle Codex", [process.execPath, join(tools, "remote_agent.ts"), "codex"].map(shellQuote).join(" ")],
    ["demo link", [process.execPath, join(tools, "remote_demo.ts"), machine].map(shellQuote).join(" ")],
  ];
}
