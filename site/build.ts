/** Static, self-contained pages; no server language middleware. */
import { join } from "node:path";
import * as prerender from "./prerender";
import * as locale from "../src/locale";
import * as bundle from "./bundle";

const check = Bun.spawnSync(
  [process.execPath, join(import.meta.dir, "../scripts/translations.ts"), "check", "--site"],
  { stdout: "inherit", stderr: "inherit" },
);
if (!check.success) process.exit(1);
for (const language of locale.locales) {
  const entrypoint = await prerender.prepare(language);
  const result = await Bun.build({
    entrypoints: [entrypoint, join(prerender.directory, language, "moonlander.html")],
    outdir: join(import.meta.dir, "dist", language),
    naming: "[name].[ext]",
    target: "browser",
    minify: true,
    compile: true,
    plugins: [bundle.frames(language)],
  });
  for (const log of result.logs) console.error(log);
  if (!result.success) process.exit(1);
  for (const out of result.outputs) console.log(out.path);
}
for (const page of ["index.html", "moonlander.html"])
  await Bun.write(join(import.meta.dir, "dist", page), Bun.file(join(import.meta.dir, "dist/en", page)));
