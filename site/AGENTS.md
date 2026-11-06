# Site development

Run these commands from the repository root.

`bun run landingpage:dev` serves `site/` and reloads on
save; `landingpage:build` writes self-contained pages for each locale in
`site/dist/` (plus English root aliases), `landingpage:start` serves them, and
`landingpage:publish` builds it and deploys it to corgi.computer with
wrangler, as an assets-only Worker on `/*` (`site/wrangler.jsonc`), so query strings
work too. The publisher first installs scriptless bypass routes for release
paths (`site/bucket_routes.ts`); add new bucket prefixes there. Deploy through
the publisher, never directly through Wrangler. Keep it script-free: asset hits are free, but a
script runs on every request it sees and counts against the plan's
limit. `bun tools/site_frames.ts`
re-records English screens into `site/frames.json` with Corgi's renderer;
`--all-languages` also records `site/frames/{zh,ja,ko,ru}.json`. `--check`
fails on stale recordings. Site translation commands use `--site` and
separate caches; the app's normal i18n workflow does no site work. The page
imports Corgi's animation code, so keep `src/corgi_animation.ts` browser-safe. It also runs the review panel, the
resource card, the command menu and the worktree overview, with
`site/browser/` standing in for git, files, the resource sampler, ports,
launch commands, zlib, the native widths (package.json's `"browser"`
field), `process.platform` and `Buffer`; a new Node or native import under
`src/review/`, `src/resource_tooltip.ts`, `src/shortcut_help.ts`,
`src/worktree_tooltip.ts` or what it imports (the sidebar among them)
needs a stand-in there too.
The hero's first frame is prerendered from `site/main.js` on builds and
dev saves; `site/.generated/` is disposable. Keep its mobile breakpoint
and column count in `site/hero_config.ts`.
Wrangler's local `dev` server is incompatible with Bun (its runtime
dispatcher fails on reload); run that diagnostic with Node. The site
build and publish commands use Bun.
