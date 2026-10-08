import { test, expect } from "bun:test";
import { Option, applyModel } from "./preview";
test("launch preview settings overlay", () => {
  const o = new Option();
  applyModel(o, { model: "opus" }, "Project");
  expect(o.model.text()).toBe("opus");
  expect(o.modelLabel()).toBe("Opus");
  expect(o.source.text()).toBe("Project");
});
