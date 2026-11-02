/** The first hero frame, drawn by the same page bundle that takes it over. */
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import * as tooling from "../scripts/tooling";
import * as i18n from "./i18n";
import * as locale from "../src/locale";
import * as htmlTranslations from "../scripts/html_translations";
import * as bundle from "./bundle";
import * as heroConfig from "./hero_config";

const root = import.meta.dir;
export const directory = join(root, ".generated");

/** Dev watchers should only see complete, changed files. */
async function write(path: string, contents: string): Promise<void> {
  const previous = await Bun.file(path)
    .text()
    .catch(() => null);
  if (contents === previous) return;
  const temporary = `${path}.${process.pid}.tmp`;
  await Bun.write(temporary, contents);
  renameSync(temporary, path);
}

export async function render(html: string, bundle: string): Promise<string> {
  const dom = await tooling.dependency("happy-dom");
  const { Window } = await import(join(dom, "lib", "index.js"));
  const frames = [];
  for (const [name, width] of [
    ["desktop", heroConfig.mobile.breakpoint + 1],
    ["mobile", heroConfig.mobile.breakpoint - 1],
  ] as const) {
    const window = new Window({
      url: `http://localhost/${locale.parse(/<html[^>]*lang="([^"]+)"/.exec(html)?.[1] ?? "en") ?? "en"}/`,
      width,
      height: 900,
      settings: {
        disableCSSFileLoading: true,
        disableJavaScriptFileLoading: true,
        enableJavaScriptEvaluation: true,
        // Only the freshly built local bundle is evaluated.
        suppressInsecureJavaScriptEnvironmentWarning: true,
      },
    });
    try {
      window.structuredClone = structuredClone;
      window.document.write(html.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, ""));
      // No layout engine or animation clock is needed to draw the cell grid.
      Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { get: () => width });
      Object.defineProperty(window.performance, "now", { value: () => 0 });
      window.setInterval = window.setTimeout = window.requestAnimationFrame = () => 0;
      window.eval(bundle);
      const screen = window.document.getElementById("v-sim");
      const cols = Number(screen.style.getPropertyValue("--cols"));
      const rows = [...screen.querySelectorAll(":scope > .r")];
      if (!cols || !rows.length || !rows.some(row => row.textContent.trim()))
        throw Error(`The ${name} hero did not paint its first frame`);
      for (const row of rows) {
        for (const cell of [...row.querySelectorAll(":scope > span")].slice(cols)) cell.remove();
      }
      frames.push({ name, cols, rows: rows.length, html: screen.innerHTML });
    } finally {
      await window.happyDOM.close();
    }
  }
  const [desktop, mobile] = frames;
  const initial = frames
    .map(frame => `<div class="hero-initial hero-initial-${frame.name}" data-cols="${frame.cols}">${frame.html}</div>`)
    .join("");
  const css = `<style id="hero-initial-layout">
    #v-sim { --cols: ${desktop.cols}; --rows: ${desktop.rows}; }
    .hero-initial-mobile { display: none; }
    @container (width < ${heroConfig.mobile.breakpoint}px) {
      #v-sim { --cols: ${mobile.cols}; --rows: ${mobile.rows}; }
      .hero-initial-desktop { display: none; }
      .hero-initial-mobile { display: block; }
    }
  </style>`;
  return new HTMLRewriter()
    .on("head", { element: element => element.append(css, { html: true }) })
    .on("#v-sim", {
      element(element) {
        element.setAttribute(
          "style",
          (element.getAttribute("style") ?? "").replace(/--(?:cols|rows):[^;]*(?:;|$)/g, ""),
        );
        element.setInnerContent(initial, { html: true });
      },
    })
    .transform(new Response(html))
    .text();
}

export async function page(source: string, language: locale.Locale, path = "/"): Promise<string> {
  i18n.setLanguage(language);
  const translated = await htmlTranslations.transform(source, i18n.html);
  const code = language === "zh" ? "zh-CN" : language;
  const links = locale.locales
    .map(
      value =>
        `<link rel="alternate" hreflang="${value === "zh" ? "zh-CN" : value}" href="https://corgi.computer/${value}${path}">`,
    )
    .join("");
  const picker = `<details class="language-picker" translate="no"><summary aria-label="${i18n.t`Language`}"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></svg> ${locale.names[language]}</summary><nav>${locale.locales.map(value => `<a data-language="${value}" lang="${value === "zh" ? "zh-CN" : value}" href="/${value}${path}"${value === language ? ' aria-current="true"' : ""}>${locale.names[value]}</a>`).join("")}</nav></details>`;
  return new HTMLRewriter()
    .on("html", { element: element => element.setAttribute("lang", code) })
    .on("head", {
      element: element =>
        element.append(
          `<link rel="canonical" href="https://corgi.computer/${language}${path}">${links}<link rel="alternate" hreflang="x-default" href="https://corgi.computer${path}">`,
          { html: true },
        ),
    })
    .on("body", { element: element => element.prepend(picker, { html: true }) })
    .transform(new Response(translated))
    .text();
}

export async function prepare(language: locale.Locale = "en"): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(root, "main.js")],
    target: "browser",
    format: "iife",
    minify: true,
    plugins: [bundle.frames(language)],
  });
  if (!result.success) throw new AggregateError(result.logs, "Hero prerender bundle failed");
  const html = await render(
    await page(await Bun.file(join(root, "index.html")).text(), language),
    await result.outputs[0].text(),
  );
  mkdirSync(join(directory, language), { recursive: true });
  const path = join(directory, language, "index.html");
  // Local asset paths are relative to site/, two directories above this file.
  const prepared = html.replace(/\b(src|href)="\.\//g, '$1="../../').replace('src="../../main.js"', 'src="./main.js"');
  await write(join(directory, language, "main.js"), await result.outputs[0].text());
  await write(path, prepared);
  const moon = await page(await Bun.file(join(root, "moonlander.html")).text(), language, "/moonlander");
  await write(join(directory, language, "moonlander.html"), moon.replace(/\b(src|href)="\.\//g, '$1="../../'));
  return path;
}

/** Reload both generated catalogs and their imports on each dev rebuild. */
export async function refresh(): Promise<void> {
  const child = Bun.spawn([process.execPath, import.meta.path], { stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw Error("Site prerender failed");
}

if (import.meta.main) for (const language of locale.locales) await prepare(language);
