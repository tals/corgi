---
name: corgi-tricks
description: Create and debug Corgi Tricks in JavaScript or TypeScript when the user wants agent account colors, sidebar or popover additions, pane decorations, or small interactive overlays.
---

# Corgi Tricks

A trick exports `register(on, corgi)`. No SDK, imports or npm install are needed.
Corgi runs it in a separate process using its bundled runtime.

## Install and iterate

Run `corgi tricks list --json` first. Its `directory` is the installed-tricks
folder for the selected daemon (`CORGI_SOCKET`); use that path rather than
assuming the viewer's HOME. The default is `${XDG_CONFIG_HOME:-$HOME/.config}/corgi/tricks`,
overridden by `CORGI_TRICKS_DIR` on the daemon. Never install code in a repository
and expect Corgi to discover it.

Make one folder with `trick.toml` and `main.mjs` (or `main.ts`):

```toml
version = 1
id = "account-colors"
entry = "main.mjs"
```

```js
export function register(on, corgi) {
  const accountColor = corgi.palette.map("accounts");
  on("ui:agent.sidebar", async ({ agent, ui }) => {
    if (agent.account) ui.marker(await accountColor(agent.account.id));
  });
}
```

TOML identifies and launches the program; behavior and subscriptions belong in
code. Source, JSON and TOML saves reload only the affected trick by default.
Relative imports within the folder are watched too. Dependency and build folders,
hidden directories and nested directory symlinks are excluded; watches are bounded.
Use `corgi tricks reload` after changing external imports.
`corgi tricks list --json` reports failures. Settings → Tricks controls enablement
and palettes; Development → Restart rescans and restarts. The folder's Copy
button copies its full path. Runtime settings override a manifest's `enabled` value.

## Edit the existing UI

Register only the sites you need; returning without drawing clears an old patch.

- `ui:agent.sidebar`: `ui.color` colors the name, `ui.marker` colors the rail,
  `ui.append` adds beside the name.
- `ui:agent.popover`: color the title, mark the border, append a footer.
- `ui:agent.pane`: append a top-right overlay or mark its top-left edge. Headless
  agents have no pane. Terminal contents are opaque.

```js
export function register(on, corgi) {
  on("ui:agent.sidebar", ({ agent, ui }) => {
    const brand = corgi.brand.of(agent.provider);
    ui.color(brand.color);
    ui.append(`!(${brand.icon})`);
  });
  on("ui:agent.popover", ({ agent, ui }) => {
    ui.append(ui.button("Open", () => corgi.focus(agent)));
  });
}
```

Each callback receives `{ event, agent, previous, ui }`. UI operations only work
inside that callback. Hooks run on metadata changes; frames reuse cached drawings.
Do not poll or create animation timers. Multiple hooks compose their additions;
later colors win. `corgi.refresh()` coalesces a refresh of this trick's agent hooks
when shared state changes. Button callbacks refresh them automatically afterward.

`ui.append` accepts a string or `ui.row(...)`, `ui.column(...)`, `ui.text(text, color?)`,
`ui.icon(reference)` and `ui.button(label, callback)`. `corgi.ui` exposes the same
builders outside UI callbacks. Functions stay inside the trick process.
`await corgi.focus(agent)` works only during a button callback and targets the
viewer that pressed it. Keep additions small: sidebar one row, popover four rows,
overlays twelve rows. Clipped buttons are hidden and cannot receive input.

Strings support **bold**, *italic*, backtick literal text, backslash escapes and
`!(brand-reference)` icons. Use `corgi.escape(agent.name)` for literal metadata.
No HTML, URLs or arbitrary images. Inline strings have a 512-byte/16-span limit.

Use `corgi.palette` tokens (`accent`, `warm`, `text`, `muted`, `bg`, etc.),
`corgi.palette.mix(a, b, amount)` with 0–100 percent of b, or `#RRGGBB`.
`corgi.brand.of(agent.provider)` returns `{name, color, icon}` using bundled brands.

For automatic category colors, use `const color = corgi.palette.map("accounts")`
then `await color(agent.account.id)`. The default
`corgi.palette.identity` has six categorical hues from each viewer’s terminal
palette, with readable contrast and Corgi fallbacks. This is the default.
Distinct keys get successive slots, cycling after all colors are used; the same
key keeps its slot across agents, reloads and restarts. Keys are strings, finite
numbers, booleans, null or arrays of these. The mapper caches lookups and durably
saves new assignments before returning. No manual KV bookkeeping is needed.

Pass a custom palette as the second argument, for example
`corgi.palette.map("projects", ["steelblue", "#f28e2c"])`. Fixed D3 presets
are opt-in: `"tableau10"`, `"set2"`, or `"paired"` as the second argument;
`"terminal"` uses terminal hues. Arrays are also available through
`corgi.palette.schemes`.
Terminal references follow each viewer’s palette; explicit CSS colors stay
fixed. Slots are saved; changing the palette recolors automatic slots while
keeping each key in place. User-selected palettes survive code reloads.
Names are private to this Trick/runtime. `globals.NAME` shares across all Tricks
and all Corgi environments. A shared palette keeps its original color array;
other callers can omit the array to inherit it. Mappings are capped at 16 per
Trick, 256 keys each, 32 colors and 1 KiB per key, with 64 KiB per palette file.
Earlier local `palette.*` KV assignments are imported automatically.

## Save account preferences

The account-colors Trick is installed by default in the normal Tricks folder.
It is editable user code; existing edits and deliberate removals are preserved.
Custom `CORGI_TRICKS_DIR` folders are managed explicitly.

`agent.account` is `{ id, name, directory, loginId, email, type, plan, usage }`
or `null` when unresolved. `id` is a general profile lookup key. `loginId` is
Corgi's internal login identity (or a native credential ID); different profiles
can share it. For login lookups use `[agent.provider, agent.account.loginId]`
and skip unknown logins. `type` is `"oauth"`, `"api_key"`, `"external"`, or
`null`; `plan` is a separate subscription label. `directory`, `loginId`,
`email`, `type`, `plan`, and `usage` can be `null`.

`usage` reuses cached account readings, with no extra polling. It has `limits`,
`spend`, `fetched_at` (Unix seconds or null), `error`, and `needs_consent`.
`limits` is `"none"`, `"metered"`, `"rate_limited"`, or `{ windows: [...] }`;
non-null windows contain `used` (percent), `minutes`, and `reset_at`.
Check freshness before treating usage as current. Inspect
the pane's `agent.account` in `corgi rpc '{"op":"session.snapshot"}'`.
`agent.env` exposes only that agent's `CORGI_` variables; account discovery
does not require reading environment variables or files in a Trick.

Corgi shows each palette beneath its Trick in Settings → Tricks, with color
preview chips. Its editor offers Automatic, preset schemes, and individual
color overrides; type a CSS name, hex, RGB or HSL value for a custom color. No buttons or
settings code are needed in the Trick. Changes repaint running Tricks and
shared palettes update in other environments without restarting them.

Agents can configure the same mappings through the CLI, including keys that
have not appeared yet:

```sh
corgi tricks palette list --json
corgi tricks palette show account-colors/accounts --json
corgi tricks palette colors globals.accounts auto
corgi tricks palette colors globals.accounts set2
corgi tricks palette set globals.accounts 'ACCOUNT_ID' steelblue
corgi tricks palette set globals.accounts 'ACCOUNT_ID' '#cc8844'
corgi tricks palette reset globals.accounts 'ACCOUNT_ID'
corgi tricks palette reset globals.accounts
```

Use `TRICK/NAME` for private palettes and `globals.NAME` for shared ones.
Keys are strings unless `--key-json` is supplied. Colors accept theme tokens,
`terminal.HUE`, `brand.NAME`, `syntax.NAME`, opaque CSS colors or JSON color expressions. `--json`
returns structured replies. Reset removes overrides and keeps automatic slots.
Do not edit palette files directly; the API locks and saves them atomically.

`await corgi.get(key, fallback)`, `set(key, json)` and `delete(key)` use a private,
atomic store per runtime and trick ID, capped at 64 KiB. Await writes before
updating in-memory state. It survives reloads, disable/enable, daemon handoff
and cold restarts. Corrupt stores fail visibly rather than being overwritten.

## Events and independent overlays

`on(callback)` defaults to `metadata:*`. `on("agent.changed", callback)` or
`on(["snapshot", "hook"], callback)` narrows it. `*` is invalid.

Metadata events: `snapshot` has `agents` and `workspaces`; `agent.changed` has
`agent` and `previous` (null initially); `agent.removed` has the departing `agent`;
`hook` has normalized `kind`, `tool`, `provider` and nullable `agent`.
An agent has `id`, `provider`, `account`, `workspace`, `session`, `name`, `state`,
`attention`, `activity`, `completed`. Use `BigInt(agent.completed)` for the decimal
counter. Headless agents resolve their selected account too; use
`corgi headless start PROVIDER PROMPT --account DIR` to select a profile.

```js
export function register(on, corgi) {
  on("snapshot", ({ agents }) => {
    const waiting = agents.filter(a => a.attention === "needs_input");
    if (!waiting.length) return corgi.clear("waiting");
    corgi.draw("waiting", {
      kind: "overlay",
      anchor: "top-right",
      content: corgi.ui.column(
        "**Waiting for you**",
        ...waiting.slice(0, 8).map(a =>
          corgi.ui.button(corgi.escape(a.name || a.provider), () => corgi.focus(a))),
      ),
    });
  });
}
```

`corgi.draw(key, {kind:"overlay", text, color?, anchor?})` accepts multiline text,
or use `content` instead of `text`. Anchors are top/bottom-left/right.
Replace a key to update; `corgi.clear(key)` removes it. Keys belong to the trick;
`ui-` is reserved. Standalone overlays must be redrawn explicitly after clicks.

Transcripts require `on("transcript", ...)` explicitly. They carry new provider
records after initial history as `{agent, record, truncated}`; oversized records
have `record: null`. This is not a lossless archive. Metadata excludes prompts,
tool inputs and outputs. Pane screen buffers and terminal bytes are never sent.

## Verify and debug

Check the live status after saving. Exercise the affected sidebar, popover or
pane, edit a matching condition so it stops matching, and verify its drawing
clears. For persistence, reload and check the saved choice survives. Click buttons
or use prefix U, Tab / Shift-Tab, Enter and Esc with the Corgi keymap.

Callbacks are serial, must finish within five seconds, and exceptions stop the
trick and clear its views. Registration ends when `register` resolves: register
all handlers before then. CPU, memory, processes, queues and drawing sizes are
bounded; no automatic crash retry occurs without an edit or explicit reload.
`console.log` goes to the daemon's diagnostics, never the JSONL protocol.
Tricks are trusted local programs, not an OS sandbox.
