import { test, expect } from "bun:test";
import * as report from "./state_report";
import * as json from "./json";

const repaired = report.failure({
  state: {
    summary: "cold checkpoint v6: 1 workspace, 1 pane",
    items: ["pane 3: claude, shows conversation 2"],
    repairs: ["pane 3 pointed at conversation 2, which isn't saved; dropped"],
    anonymized: json.stringify({ panes: [{ id: 3 }] }),
  },
});
test("a repaired session's report leads with what was repaired", () => {
  const e = { kind: "repaired", release: "20261029T141500Z-197f53a" } as const,
    text = report.report(e, repaired);
  expect(text).toStartWith("20261029T141500Z-197f53a repaired the session it loaded.\n\n- Repaired:\n");
  expect(text).toContain("  - pane 3 pointed at conversation 2, which isn't saved; dropped");
  expect(text).not.toContain("Failed check");
  expect(json.parse(report.attachment(e, repaired)).report).toMatchObject({
    repaired_by: "20261029T141500Z-197f53a",
    repairs: ["pane 3 pointed at conversation 2, which isn't saved; dropped"],
  });
  expect(decodeURIComponent(report.issue(e, repaired)!)).toContain("Corgi repaired a saved session: pane 3 pointed");
});
test("a report with fields missing reads with defaults", () => {
  expect(report.failure(null)).toEqual({
    error: "unknown",
    why: null,
    frames: [],
    state: { summary: "not described", items: [], repairs: [], recent: [], anonymized: "null" },
  });
});
