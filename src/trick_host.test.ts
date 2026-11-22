import { expect, test } from "bun:test";
import * as tricks from "./tricks";
import * as trickHost from "./trick_host";

const title = (text: string, action?: string): tricks.Title => ({
  kind: "title",
  spans: [{ text }],
  ...(action ? { action } : {}),
});
const overlay = (text: string): tricks.View => ({ kind: "overlay", anchor: "top-right", lines: [[{ text }]] });

test("a trick holds one title item, replaced under its own key", () => {
  const views = new Map<string, tricks.View>();
  expect(trickHost.setView(views, "dot", title("●"))).toBe(true);
  expect(trickHost.setView(views, "dot", title("●"))).toBe(false);
  expect(() => trickHost.setView(views, "other", title("○"))).toThrow("TitleExists");
  expect(views.get("dot")).toEqual(title("●"));
  expect(views.has("other")).toBe(false);
  expect(trickHost.setView(views, "dot", title("○"))).toBe(true);
  expect(views.get("dot")).toEqual(title("○"));
  expect(trickHost.setView(views, "card", overlay("hi"))).toBe(true);
  views.delete("dot");
  expect(trickHost.setView(views, "other", title("○"))).toBe(true);
});

test("a title item counts toward a trick's drawing limits", () => {
  const views = new Map<string, tricks.View>();
  for (let i = 0; i < tricks.max_views; i++) trickHost.setView(views, `v${i}`, overlay(String(i)));
  expect(() => trickHost.setView(views, "dot", title("●"))).toThrow("TooManyViews");
  const big = new Map<string, tricks.View>([["card", overlay("x".repeat(tricks.max_bytes - 100))]]);
  expect(() => trickHost.setView(big, "dot", title("●"))).toThrow("ViewsTooLarge");
  expect(big.has("dot")).toBe(false);
});

test("title items follow every other drawing, ordered by trick ID", () => {
  const running = (id: string, instance: string, entries: [string, tricks.View][]) => ({
    instance,
    manifest: { id },
    views: new Map(entries),
  });
  const zeta = running("zeta", "z1", [
    ["dot", title("z", "press")],
    ["card", overlay("zeta")],
  ]);
  const alpha = running("alpha", "a1", [["dot", title("a")]]);
  const beta = running("Beta", "b1", [
    ["card", overlay("beta")],
    ["dot", { ...title("b", "go"), slot: "pad" }],
  ]);
  const drawn = trickHost.ordered([zeta, alpha, beta]);
  expect(drawn.map(view => view.kind)).toEqual(["overlay", "overlay", "title", "title", "title"]);
  // Code-unit order: uppercase sorts first.
  expect(drawn.slice(2)).toEqual([
    { kind: "title", spans: [{ text: "b" }], action: "b1.go", slot: "b1.pad" },
    title("a"),
    { kind: "title", spans: [{ text: "z" }], action: "z1.press", slot: "z1.press" },
  ]);
  expect(trickHost.ordered([beta, alpha, zeta]).slice(2)).toEqual(drawn.slice(2));
  zeta.views.delete("dot");
  expect(trickHost.ordered([zeta, alpha, beta]).filter(view => view.kind === "title")).toHaveLength(2);
});
