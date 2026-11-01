/**
 * Serves the landing page.
 *
 *   bun site/serve.ts --dev   bundle on request and reload on save
 *   bun site/serve.ts         serve the build in site/dist
 *
 * PORT picks the port (4400). /moonlander serves the moonlander easter egg,
 * a page of its own.
 */
import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import * as prerender from "./prerender";
import * as locale from "../src/locale";

const port = Number(process.env.PORT ?? 4400);
const dev = process.argv.includes("--dev");
const built = (page: string) => () => new Response(Bun.file(join(import.meta.dir, "dist", page)));

if (dev) {
  const routes: Record<string, Bun.HTMLBundle> = {};
  for (const language of locale.locales) {
    await prerender.prepare(language);
    const { default: page } = await import(`./.generated/${language}/index.html`);
    const { default: moonlander } = await import(`./.generated/${language}/moonlander.html`);
    routes[`/${language}/`] = page;
    routes[`/${language}/moonlander`] = moonlander;
    if (language === "en") {
      routes["/"] = page;
      routes["/moonlander"] = moonlander;
    }
  }
  Bun.serve({
    port,
    routes,
    development: { hmr: true, console: true },
    fetch(request) {
      const url = new URL(request.url);
      if (locale.locales.some(language => url.pathname === `/${language}`))
        return Response.redirect(url.pathname + "/" + url.search, 308);
      return new Response("Not found", { status: 404 });
    },
  });
  let timer: ReturnType<typeof setTimeout>,
    running = false,
    pending = false;
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      pending = true;
      if (running) return;
      running = true;
      try {
        while (pending) {
          pending = false;
          for (const language of locale.locales) await prerender.prepare(language);
        }
      } catch (error) {
        console.error("Hero prerender failed:", error);
      } finally {
        running = false;
      }
    }, 200);
  };
  for (const directory of ["site", "src", "assets"])
    watch(join(import.meta.dir, "..", directory), { recursive: true }, (_event, file) => {
      if (file && !/^(?:\.generated|dist)\//.test(file) && /\.(?:ts|js|html|css|json|md)$/.test(file)) changed();
    });
  watch(join(import.meta.dir, "..", "package.json"), changed);
} else {
  if (!existsSync(join(import.meta.dir, "dist", "moonlander.html"))) {
    console.error("No build in site/dist; run bun run landingpage:build");
    process.exit(1);
  }
  Bun.serve({
    port,
    // Read on each request, so a rebuild shows without a restart.
    routes: {
      "/": built("index.html"),
      "/moonlander": built("moonlander.html"),
      ...Object.fromEntries(
        locale.locales.flatMap(language => [
          [`/${language}/`, built(`${language}/index.html`)],
          [`/${language}/moonlander`, built(`${language}/moonlander.html`)],
          [`/${language}`, (request: Request) => Response.redirect(`/${language}/` + new URL(request.url).search, 308)],
        ]),
      ),
    },
    fetch: () => new Response("Not found", { status: 404 }),
  });
}
console.log(`landing page ${dev ? "(dev) " : ""}at http://localhost:${port}/`);
