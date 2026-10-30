import { test, expect } from "bun:test";
import { screen } from "./screen";
import { adapter } from "./index";
test("compaction requires a live status row and ignores quoted or historical text", () => {
  expect(screen("", "• Compacting context (12s • esc to interrupt)\n› ")).toBe("compacting");
  expect(screen("", "◦ Compacting conversation (esc to interrupt)\n› ")).toBe("compacting");
  expect(screen("", "• Compacting context (esc to interrupt)\nWorking (esc to interrupt)")).toBe("working");
  expect(screen("", "I saw Compacting context (esc to interrupt)")).toBe("working");
  expect(screen("", "Compacting context\n› ")).toBe("idle");
  expect(screen("", "• Compacting context (esc to interrupt)\n1\n2\n3\n4\n5\n6\n7\n8")).toBeNull();
});
test("background terminals show as a running tool", () => {
  const prompt = "\n› Ask Codex to do anything";
  for (const row of [
    "• Working (20s • esc to interrupt) · 1 background terminal running",
    "• Working (20s • esc to interrupt) · 3 background t…",
    "• Waiting for background terminal (20s • esc to interrupt)",
  ])
    expect(screen("", row + prompt)).toBe("tool");
  expect(screen("", "• Working (20s • esc to interrupt) · 0 background terminals running" + prompt)).toBe("working");
});
test("Codex asks for approval in its title", () => {
  expect(screen("Action Required | codex", "› ")).toBe("blocked");
  expect(screen("codex", "› ")).toBe("idle");
});
test("the composer and footer do not hide a live background wait", () => {
  const rows = [
    "• Waiting for background terminal (11m 48s • esc to interrupt) · 1 background terminal running",
    "  └ bunx lavish-axi poll /repo/preview.html",
    "  └ Tip: Use /side to start a side conversation",
    "",
    "",
    "› Ask Codex to do anything",
    "",
    "  GPT-6-Astra xhigh · /repo · worktree fixes · Main [default]",
    "  ⚠ 1 warning · f2 to view",
    "",
  ];
  expect(screen("", rows.join("\n"))).toBe("tool");
  rows[0] = "• Working (11m 48s • esc to interrupt)";
  expect(screen("", rows.join("\n"))).toBe("working");
  rows[0] = "• Compacting context (11m 48s • esc to interrupt)";
  expect(screen("", rows.join("\n"))).toBe("compacting");
  rows[0] = "  1 background terminal running · /ps to view · /stop to close";
  expect(screen("", rows.join("\n"))).toBe("idle");
});
test("Codex version validation rejects successful non-Codex programs", () => {
  expect(adapter.version?.("codex-cli 0.155.0-alpha.2.6\n")).toBe(true);
  for (const output of ["", "codex-cli ", "unrelated tool 1.0.0\n", "codex-cli missing native binary"])
    expect(adapter.version?.(output)).toBe(false);
});
