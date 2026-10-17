/**
 * Serves the landing page.
 *
 *   bun site/serve.ts --dev   bundle on request and reload on save
 *   bun site/serve.ts         serve the build in site/dist
 *
 * PORT picks the port (4400).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const port = Number(process.env.PORT ?? 4400);
const dev = process.argv.includes("--dev");
const built = join(import.meta.dir, "dist", "index.html");

if (dev) {
  const { default: page } = await import("./index.html");
  Bun.serve({ port, routes: { "/": page }, development: { hmr: true, console: true } });
} else {
  if (!existsSync(built)) {
    console.error("No build in site/dist; run bun run landingpage:build");
    process.exit(1);
  }
  Bun.serve({
    port,
    // Read on each request, so a rebuild shows without a restart.
    routes: { "/": () => new Response(Bun.file(built)) },
    fetch: () => new Response("Not found", { status: 404 }),
  });
}
console.log(`landing page ${dev ? "(dev) " : ""}at http://localhost:${port}/`);
