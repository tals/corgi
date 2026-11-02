import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import * as tooling from "../scripts/tooling";
import * as heroConfig from "./hero_config";
import * as prerender from "./prerender";
import * as bundle from "./bundle";

let html: string, script: string;
beforeAll(async () => {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "main.js")],
    target: "browser",
    format: "iife",
    minify: true,
  });
  if (!result.success) throw new AggregateError(result.logs);
  script = await result.outputs[0].text();
  html = await prerender.render(await Bun.file(join(import.meta.dir, "index.html")).text(), script);
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

      window.eval(script);
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

for (const language of ["en", "zh", "ja", "ko", "ru"] as const) {
  test(`${language} keeps the sidebar's header and resource labels, without the scope control`, async () => {
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, "main.js")],
      target: "browser",
      format: "iife",
      plugins: [bundle.frames(language)],
    });
    if (!result.success) throw new AggregateError(result.logs);
    const dom = await tooling.dependency("happy-dom");
    const { Window } = await import(join(dom, "lib", "index.js"));
    const window = new Window({
      url: `http://localhost/${language}/`,
      width: 1200,
      settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true },
    });
    try {
      window.structuredClone = structuredClone;
      const source = await prerender.page(await Bun.file(join(import.meta.dir, "index.html")).text(), language);
      window.document.write(source.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, ""));
      Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { get: () => 1200 });
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
      window.eval(await result.outputs[0].text());
      revealHero();
      const recordings = await Bun.file(
        join(import.meta.dir, language === "en" ? "frames.json" : `frames/${language}.json`),
      ).json();
      const normalize = (value: string) =>
        value
          .replace(/[▌│]/g, "")
          .replace(/\d+(?:\.\d+)?[%GM]/g, "#")
          .replace(/\s+/g, " ")
          .trim();
      for (const at of [1500, 11500, 21500]) {
        clock = at;
        ticks.forEach(tick => tick());
        const rows = [...window.document.querySelectorAll("#v-sim > .r")];
        const cells = (row: number) => [...rows[row].querySelectorAll(":scope > span")].slice(0, 34);
        const sidebar = (row: number) =>
          cells(row)
            .map(cell => cell.textContent)
            .join("");
        for (const row of [4, 7]) {
          const recorded = recordings.frames.w34_C00[row].map(([text]: [string, number]) => text).join("");
          expect(normalize(sidebar(row))).toBe(normalize(recorded));
        }
        // The header keeps its place and Corgi's bold.
        const header = recordings.frames.w34_C00[0]
          .map(([text]: [string, number]) => text)
          .join("")
          .search(/\S/);
        expect(sidebar(0).search(/\S/)).toBe(header);
        expect(cells(0)[header].classList.contains("b")).toBe(true);
        // With no scopes to switch, the agents header keeps only its name and New.
        expect(sidebar(11)).not.toMatch(/:|corgi/);
      }
    } finally {
      await window.happyDOM.close();
    }
  }, 30000);
}
