import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import * as checkpoint_text from "./revisions/20261114_015701_d58e69e6af6c_checkpoint_strings_and_providers";
import * as values from "./revision_values";
test("fixed text is cut at its saved length, never at a NUL", () => {
  expect(values.fixedText("Idleing tests\0\0", 4)).toBe("Idle");
  expect(values.fixedText([115, 49, 255, 0], 2)).toBe("s1");
  expect(values.fixedText("t1\0")).toBe("");
  expect(values.fixedText("a\0b\0", 3)).toBe("a\0b");
  expect(values.fixedText(undefined, 0)).toBe("");
  expect((values.fixedText([104, 105, 255, 0], 3) as { bytes: Buffer }).bytes).toEqual(Buffer.from([104, 105, 255]));
  for (const [bytes, len] of [
    ["ab", 3],
    [[97, 98], 3],
    ["ab", -1],
    [[97, 256], 1],
    [null, 0],
  ] as any[])
    expect(() => values.fixedText(bytes, len)).toThrow("InvalidCheckpoint");
  for (const label of [{ bytes: "ab", len: 3 }, { len: 1 }, "ab"])
    expect(() => checkpoint_text.revision.up({ panes: [{ label }] })).toThrow("InvalidCheckpoint");
});
test("provider arrays hold at most one bool per historical provider", () => {
  const value: any = { version: 4, agent_yolo: [true], agent_hidden: [] };
  checkpoint_text.revision.up(value);
  expect(value).toEqual({
    version: 4,
    agent_yolo: { codex: true },
    agent_hidden: {},
  });
  for (const value of [
    { agent_yolo: [true, false, true] },
    { agent_yolo: [1, 0] },
    { agent_yolo: null },
    { agent_hidden: { codex: true } },
  ])
    expect(() => checkpoint_text.revision.up(value)).toThrow("InvalidCheckpoint");
});
test("the V4 fixture migrates to text without padding", () => {
  const value = JSON.parse(readFileSync(new URL("../fixtures/checkpoint-v4.json", import.meta.url), "utf8"));
  checkpoint_text.revision.up(value);
  expect(JSON.stringify(value)).not.toContain("\\u0000");
  const check = (v: any) => {
    if (v && typeof v === "object") {
      for (const [key, item] of Object.entries(v)) {
        expect(key.endsWith("_len")).toBe(false);
        check(item);
      }
    }
  };
  check(value);
  expect(value.conversations[0].agent.session).toBe("v3-shared");
  for (const pane of value.panes) expect(pane.agent).toBeUndefined();
  expect(value.panes[0].resume_hint.session).toBe("v3-shared");
});
