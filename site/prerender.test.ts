import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import * as tooling from "../scripts/tooling";
import * as heroConfig from "./hero_config";
import * as prerender from "./prerender";

let html: string, bundle: string;
beforeAll(async () => {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "main.js")],
    target: "browser",
    format: "iife",
    minify: true,
  });
  if (!result.success) throw new AggregateError(result.logs);
  bundle = await result.outputs[0].text();
  html = await prerender.render(await Bun.file(join(import.meta.dir, "index.html")).text(), bundle);
}, 30000);

for (const [name, width] of [
  ["desktop", heroConfig.mobile.breakpoint + 1],
  ["mobile", heroConfig.mobile.breakpoint - 1],
] as const) {
  test(`${name} types corgi from its prerendered prompt, then opens the interactive session`, async () => {
    const dom = await tooling.dependency("happy-dom");
    const { Window } = await import(join(dom, "lib", "index.js"));
    const window = new Window({
      width,
      settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true },
    });
    try {
      window.structuredClone = structuredClone;
      window.document.write(html.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, ""));
      Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { get: () => width });
      let clock = 0;
      const ticks: (() => void)[] = [];
      let revealHero = () => {};
      Object.defineProperty(window.performance, "now", { value: () => clock });
      window.setInterval = (callback: () => void) => {
        ticks.push(callback);
        return 0;
      };
      window.setTimeout = window.requestAnimationFrame = () => 0;
      window.IntersectionObserver = class {
        constructor(readonly callback: (entries: { isIntersecting: boolean }[]) => void) {}
        observe(target: Element) {
          if (target.id === "v-sim") revealHero = () => this.callback([{ isIntersecting: true }]);
        }
        unobserve() {}
        disconnect() {}
      } as unknown as typeof window.IntersectionObserver;
      const screen = window.document.getElementById("v-sim"),
        initial = screen.querySelector(`.hero-initial-${name}`);
      const cols = Number(initial.dataset.cols),
        rows = [...initial.querySelectorAll(":scope > .r")];
      const text = (row: Element) =>
        [...row.querySelectorAll(":scope > span")]
          .slice(0, cols)
          .map(cell => cell.textContent)
          .join("");
      const before = rows.map(text),
        links = initial.querySelectorAll("a.game-link").length;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(row => row.querySelectorAll(":scope > span").length === cols)).toBe(true);
      expect(before.some(row => row.trim().length > 0)).toBe(true);
      expect(before.join("\n")).toContain("$ ");
      expect(links).toBe(0);
      expect(initial.querySelector<HTMLImageElement>(".badge")?.hidden).toBe(true);

      window.eval(bundle);
      expect(screen.querySelector(".hero-initial")).toBeNull();
      const live = [...screen.querySelectorAll(":scope > .r")];
      expect(live.length).toBe(rows.length);
      expect(live.every(row => !row.hidden)).toBe(true);
      expect(live.map(text)).toEqual(before);
      expect(screen.querySelectorAll("a.game-link").length).toBe(links);
      expect(screen.querySelectorAll(":scope > .badge").length).toBe(1);
      expect(screen.tabIndex).toBe(-1);

      revealHero();
      clock = 520;
      ticks.forEach(tick => tick());
      expect(live.map(text).join("\n")).toContain("$ cor");
      expect(screen.querySelector(".k-text")).not.toBeNull();
      expect(screen.querySelector(".badge").hidden).toBe(true);

      clock = 1250;
      ticks.forEach(tick => tick());
      expect(live.map(text).join("\n")).toContain("$ corgi");
      expect(screen.tabIndex).toBe(-1);

      clock = 1350;
      ticks.forEach(tick => tick());
      expect(screen.querySelector(".k-text")).not.toBeNull();

      clock = 1500;
      ticks.forEach(tick => tick());
      expect(live.map(text).join("\n")).toContain("workspaces");
      expect(screen.querySelectorAll(":scope > .r").length).toBe(rows.length);
      expect(screen.querySelector(".badge").hidden).toBe(false);
      expect(screen.querySelectorAll("a.game-link").length).toBeGreaterThan(0);
      expect(screen.querySelector("a.game-link").getAttribute("target")).toBe("_blank");
      expect(screen.tabIndex).toBe(0);
    } finally {
      await window.happyDOM.close();
    }
  });
}
