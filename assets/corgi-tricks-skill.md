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
    ui.marker(await accountColor([agent.provider, agent.account]));
  });
}
```

TOML identifies and launches the program; behavior and subscriptions belong in
code. Source, JSON and TOML saves reload only the affected trick by default.
Relative imports within the folder are watched too. Dependency and build folders,
hidden directories and nested directory symlinks are excluded; watches are bounded.
Use `corgi tricks reload` after changing external imports or when autoreload is off.
`corgi tricks list --json` reports failures. Settings → Tricks controls enablement,
autoreload and manual reload. Runtime settings override a manifest's `enabled` value.

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
then `await color([agent.provider, agent.account])`. The default
`corgi.palette.identity` has five syntax hues, separate from status colors.
Distinct keys get successive slots, cycling after all colors are used; the same
key keeps its slot across agents, reloads and restarts. Keys are strings, finite
numbers, booleans, null or arrays of these. The mapper caches lookups and durably
saves new assignments before returning. No manual KV bookkeeping is needed.

Pass a custom palette as the second argument, for example
`corgi.palette.map("projects", [corgi.palette.syntax.string, corgi.palette.syntax.type])`.
These references follow each viewer's theme. Palette slots, rather than RGB
values, are saved; changing the palette on the next run recolors the slots.
Names are private to this trick/runtime. Leave `palette.*` KV keys to Corgi.
Mappings are capped at 16 per trick, 256 keys each, 32 colors and 1 KiB per key,
within the same 64 KiB KV budget.

## Save account preferences

`agent.account` is the canonical config folder; the default account is `""`.
Key by both provider and account, never by display name or pane ID. Inspect
`corgi rpc '{"op":"session.snapshot"}'` for the exact account value.

```js
export async function register(on, corgi) {
  const colors = await corgi.get("colors", {});
  const key = agent => JSON.stringify([agent.provider, agent.account]);
  on("ui:agent.sidebar", ({ agent, ui }) => {
    if (colors[key(agent)]) ui.marker(colors[key(agent)]);
  });
  on("ui:agent.popover", ({ agent, ui }) => {
    ui.append(ui.button("Warm", async () => {
      const next = { ...colors, [key(agent)]: corgi.palette.warm };
      await corgi.set("colors", next);
      Object.assign(colors, next);
    }));
  });
}
```

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
counter. Headless agents currently report the default account.

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
