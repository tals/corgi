/**
 * Builds the landing page and deploys it to corgi.computer with wrangler, as
 * an assets-only Worker with query-compatible routes (site/wrangler.jsonc).
 * Release paths bypass Workers through scriptless bucket routes.
 */
import { join } from "node:path";
import * as locale from "../src/locale";
import * as bucketRoutes from "./bucket_routes";

const run = (argv: string[]) =>
  Bun.spawnSync(argv, { cwd: join(import.meta.dir, ".."), stdin: "inherit", stdout: "inherit", stderr: "inherit" })
    .success;
if (!run([process.execPath, join(import.meta.dir, "build.ts")])) process.exit(1);
const deploy = [process.execPath, "run", "wrangler", "deploy", "--config", join(import.meta.dir, "wrangler.jsonc")];
if (!process.argv.includes("--dry-run")) await bucketRoutes.prepare();
if (!run([...deploy, ...process.argv.slice(2)])) process.exit(1);
if (process.argv.includes("--dry-run")) process.exit(0);

// What visitors get: this build on the Worker's paths, the bucket's beside them.
const checks = [
  { path: "/", file: "index.html" },
  { path: "/moonlander", file: "moonlander.html" },
  { path: "/?ref=deploy-check", file: "index.html" },
  { path: "/moonlander?ref=deploy-check", file: "moonlander.html" },
  ...locale.locales.flatMap(language => [
    { path: `/${language}/`, file: `${language}/index.html` },
    { path: `/${language}/moonlander`, file: `${language}/moonlander.html` },
    { path: `/${language}/?ref=deploy-check`, file: `${language}/index.html` },
    { path: `/${language}/moonlander?ref=deploy-check`, file: `${language}/moonlander.html` },
  ]),
  { path: "/install.sh", file: null },
  { path: "/channels/stable.json", file: null },
  { path: "/install.sh?ref=deploy-check", file: null },
  { path: "/channels/stable.json?ref=deploy-check", file: null },
];
let failed = false;
for (const check of checks) {
  // New routes can take a few seconds to reach the serving edge.
  for (let attempt = 0; ; attempt++) {
    const served = await fetch(`https://corgi.computer${check.path}`, { redirect: "manual" });
    const bytes = Buffer.from(await served.arrayBuffer());
    const same = check.file === null || bytes.equals(await Bun.file(join(import.meta.dir, "dist", check.file)).bytes());
    if ((served.status !== 200 || !same) && attempt < 11) {
      await Bun.sleep(2500);
      continue;
    }
    console.log(`https://corgi.computer${check.path}: HTTP ${served.status}${same ? "" : ", not this build"}`);
    if (served.status !== 200 || !same) failed = true;
    break;
  }
}
if (failed) process.exitCode = 1;
