import { test, expect } from "bun:test";
import { adapter } from "./index";
test("Goose adapter identity", () => {
  expect(adapter.id).toBe("goose");
  expect(adapter.label).toBe("Goose");
  expect(adapter.command).toBe("goose");
  expect(adapter.glyph).toBe("G");
  expect(adapter.launcher_key).toBe("g");
  expect(adapter.bypass).toBe(false);
});
