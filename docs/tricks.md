# Corgi Tricks

A trick exports `register(on, corgi)` from a JavaScript or TypeScript file.
Register event callbacks with `on`, then draw directly through `corgi`.
Corgi runs the file with its bundled runtime: no imports, SDK, npm install,
or separate Node/Bun installation required.

For example, color Claude accounts differently in the sidebar:

```js
export function register(on, corgi) {
  on("agent.changed", ({ agent }) => {
    if (agent.provider !== "claude") return corgi.paint(agent, null);
    corgi.paint(agent, { marker: agent.account ? "#83b6ef" : corgi.palette.accent });
  });
}
```

That is the complete [account-colors trick](../examples/tricks/account-colors/main.mjs).
It implements [issue #44](https://github.com/tals/corgi/issues/44): a margin
marker in both flat and grouped sidebars, dim when unfocused and bright when
focused. Change the code to choose colors by account, provider, state, or any
combination. Corgi removes an agent's paint when it disappears. Pass `null` to
clear paint when your own condition stops matching.

The accompanying `trick.toml` only identifies and launches the code:

```toml
version = 1
id = "account-colors"
entry = "main.mjs"
```

Use `main.ts` for TypeScript; relative imports work too. Behavior and
subscriptions belong in code.

## Install and try

```sh
./go.ts --sandbox tricks
```

This opens fake agents and the four bundled examples in an isolated world.
To install one in your normal environment:

```sh
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/corgi/tricks"
cp -R examples/tricks/account-colors "${XDG_CONFIG_HOME:-$HOME/.config}/corgi/tricks/"
corgi tricks reload
corgi tricks list
```

Edit the copied code and reload. `CORGI_TRICKS_DIR` on the daemon overrides
this directory. Corgi discovers explicitly installed folders, never code in
repositories. Set `enabled = false` in a manifest to disable a trick.
Each trick runs once per daemon with its folder as the working directory.

The default account is `""`; other accounts use their canonical config folder.
`corgi rpc '{"op":"session.snapshot"}'` shows each pane's `account` value.
Compare that exact value, including resolved symlinks. Labels can change without
changing account identity. Moving its config folder changes its identity.
Include the provider when matching a specific account. To color an entire
agent type, check `agent.provider` in the callback and paint matching agents.

## The API

| Call | Effect |
| --- | --- |
| `on(events, callback)` | Register a callback for an event string or array |
| `on(callback)` | Register for `"metadata:*"` |
| `corgi.paint(agent, style)` | Set that agent's `marker`, name `color`, and/or `suffix`; pass `null` to clear |
| `corgi.draw(key, view)` | Insert or replace a named decoration or overlay |
| `corgi.clear(key)` | Remove a drawing |
| `corgi.palette` | Theme colors and `mix(a, b, amount)` |
| `corgi.brand.of(name)` | A provider or program's `{ name, color, icon }` |
| `await corgi.get(key, fallback)` | Read saved JSON; use the fallback for an absent or null value |
| `await corgi.set(key, value)` | Durably save a JSON value |
| `await corgi.delete(key)` | Durably delete a saved value |

Drawing and registration calls are synchronous. Storage calls return promises;
await writes whose success matters. `register` may be async and finishes before
the initial events arrive. Register all callbacks before it finishes. A trick
with no callbacks can draw once without subscribing to any events.

Callbacks receive just the event. Matching callbacks run in registration order,
one at a time, including awaited work. Multiple registrations add listeners;
one registration never replaces another. An exception or rejected callback
stops that trick and clears its drawings. `console.log` goes to diagnostics.

## Events

Use an event name, an array, or omit the names for the metadata default:

```js
export function register(on, corgi) {
  on("agent.changed", ({ agent }) => { /* paint the agent */ });
  on(["snapshot", "hook"], event => { /* inspect these events */ });
  on(event => { /* every metadata event */ });
}
```

Corgi subscribes the trick process only to the events its callbacks need, plus
agent-removal notifications for paint cleanup. Conditions on provider, account,
state, or other fields are ordinary code inside the callback.

| Event | Contents |
| --- | --- |
| `snapshot` | `agents` and `workspaces`, initially and when observed metadata changes |
| `agent.changed` | `agent` and `previous`; initial agents have `previous: null` |
| `agent.removed` | The last `agent` record after it leaves the runtime |
| `hook` | Normalized `kind`, `tool` name, `provider`, and associated `agent` or `null` |
| `transcript` | Opt-in: `agent`, provider JSON `record`, and `truncated` |

`"metadata:*"` expands to the first four events. `"*"` is an error, including
inside an array. Transcripts must be named explicitly:

```js
export function register(on, corgi) {
  on("transcript", ({ agent, record, truncated }) => {
    if (truncated || agent.provider !== "claude") return;
    // Inspect the provider's record and update an overlay, counter, etc.
  });
  // Metadata too: on(["metadata:*", "transcript"], event => { ... });
}
```

Transcript events reuse Corgi's existing reader. They contain complete new
records observed after the reader's initial history, without replaying the
whole conversation. A record over 32 KiB becomes `record: null, truncated: true`;
the existing reader discards records over 1 MiB. Only attached pane and
headless agents with readable transcripts are included. This is an observation
stream, not a lossless transcript archive. Nothing adds a second file watcher
or rereads a transcript for each trick.

Pane terminal content, screen buffers and images are never sent. Metadata hook
events omit prompts, tool inputs and tool outputs. Transcript records can
contain that information, but only for explicit transcript subscribers.

An agent has `id` (`pane:3` or `headless:2`), `provider`, `account`, `workspace`,
`session`, `name`, `state`, `attention`, `activity`, and `completed`.
`completed` is a decimal string counter; use `BigInt` to compare it. Headless
agents currently use the default account. Workspace records have `id`, `name`,
and `cwd`.

The initial subscription supplies a snapshot and/or initial `agent.changed`
events when registered. Events carry `at` (Unix milliseconds) and `seq`
(a daemon-local decimal string). Gaps are normal with filtering. Metadata
updates coalesce to at most ten batches per second; hooks and opted-in
transcript records arrive as observed. There is no replay or exactly-once
delivery across restarts.

## Drawing

Paint an agent's name and append a flourish:

```js
corgi.paint(agent, {
  color: corgi.palette.warm,
  suffix: [{ text: " ✦", color: corgi.palette.accent }],
});
```

Draw a card:

```js
corgi.draw("status", {
  kind: "overlay",
  anchor: "top-right",
  lines: [[{ text: "2 waiting for you", color: "warm" }]],
});
```

Or install a selector in one call from `register`, without subscribing:

```js
corgi.draw("claude", {
  kind: "decorate",
  where: { provider: "claude" },
  marker: "warm",
});
```

A span has `text` and optional `color`. Colors are palette tokens (`accent`,
`warm`, `hot`, `strong`, `text`, `muted`, etc.) or `#RRGGBB`. Tokens follow the
theme. Text cannot contain terminal controls or newlines; use another card
line. Overlays support all four corner anchors; `top-right` is the default.
They stack, clip to the pane area, and sit below built-in dialogs and menus.
They do not take focus or intercept input.

Replacing a drawing preserves its position. Folders load in lexical order;
later matching decorations override earlier color fields, while suffixes
append. Keys are local to a trick; `agent-` keys are reserved for `paint`.
Identical drawing updates cause no viewer wakeup. There is no animation clock
or widget framework in this first version.

## Palette and branding

`corgi.palette` exposes `bg`, `surface`, `selected`, `line`, `faint`, `muted`,
`text`, `strong`, `accent`, `warm`, and `hot`. Use `accent` for work and focus,
`warm` for attention, and `hot` for failures. `mix(a, b, amount)` blends toward
`b` by 0–100 percent, defaulting to 50. Mixes are limited to four nested levels.

```js
export function register(on, corgi) {
  const p = corgi.palette;
  const colors = { personal: p.accent, company: p.mix(p.warm, p.text, 20) };
  on("agent.changed", ({ agent }) => {
    corgi.paint(agent, { marker: agent.account ? colors.company : colors.personal });
  });
}
```

These are color references, resolved by each viewer in its current theme.
Hold them in a variable, save them in KV, or mix them once during registration;
changing the theme still recolors the drawing. `#RRGGBB` remains available for
fixed custom colors.

`corgi.brand.of(agent.provider)` returns a display `name`, readable `color`,
and an `icon` span that can go straight into a suffix or overlay line:

```js
export function register(on, corgi) {
  on("agent.changed", ({ agent }) => {
    const brand = corgi.brand.of(agent.provider);
    corgi.paint(agent, { color: brand.color, suffix: [{ text: " " }, brand.icon] });
  });
}
```

The helper uses Corgi's existing provider names, glyphs and logo assets.
Aliases work: `codex` uses the OpenAI mark, and `python3` uses Python's.
Program brands such as `git`, `docker` and `bun` work too. Brand colors adjust
for readable contrast in each viewer's theme. Unknown names return neutral
text and `?`; providers without a logo use their existing glyph.

On terminals supporting Kitty graphics, icon spans use the same cached logos
as tabs. Elsewhere they show text glyphs. Logos occupy two cells, clip as a
unit, and stay beneath menus and dialogs. They share the viewer's existing
image cache, so a trick sends only a small reference, never image bytes.

## State and resources

Code is the source of truth for fixed preferences. For preferences changed
at runtime, save a small JSON map keyed by provider and canonical account.
For counters, read once in registration and save after each change:

```js
export async function register(on, corgi) {
  let count = await corgi.get("count", 0);
  on("agent.changed", async ({ agent, previous }) => {
    if (!previous || agent.session !== previous.session ||
        BigInt(agent.completed) <= BigInt(previous.completed)) return;
    await corgi.set("count", ++count);
  });
}
```

KV is scoped to manifest `id` and runtime, beside the settings at
`<settings.json>.tricks/<id>.json`. Atomic private writes are fsynced before
resolving. KV survives trick reload, daemon handoff, cold restart, and
uninstall/reinstall. Different environments have separate stores. Changing
an ID starts another store. Invalid stores stop startup and remain untouched.

Drawings and ordinary variables are ephemeral; registration rebuilds them on startup.
Exiting, disabling, removing, or failing a trick clears its drawings and kills
its process group. Failures stay stopped until `corgi tricks reload`;
`corgi tricks list` shows the reason. Diagnostics go to `server.log`.

Idle tricks block on input; callbacks run only when subscribed events arrive.
The daemon samples trick processes and their children once a second, independent
of trick code. Defaults are 128 MiB combined resident memory, eight processes,
and 10% of one CPU core with a one-second CPU burst allowance. Exceeding a
budget stops the trick. These are sampled watchdog limits; brief peaks can
exceed them between samples. This is trusted local code running with your
permissions, not an OS sandbox. Async registration and each event's callbacks have five seconds
to finish.

Queues are bounded to 256 events / 1 MiB in the runner and 1 MiB in the daemon
pipe. Per trick: 256 callbacks, 256 drawings and 64 KiB total UI state, 64 KiB per command and
KV file, 12 lines per overlay, 16 spans per line, 512 UTF-8 bytes per span.
More than 1,000 commands/second or 64 KiB/second stderr stops the trick. At most
16 installed folders run. Process and host-side limits also apply to raw
JSONL programs.

## More examples

- [Provider flair](../examples/tricks/provider-flair/main.mjs): colors names
  and appends its brand icon using `corgi.brand.of(agent.provider)`.
- [Attention radar](../examples/tricks/attention-radar/main.mjs): a snapshot
  becomes a card listing agents waiting for you, cleared when they resume.
- [Completion jar](../examples/tricks/completion-jar/main.mjs): observes
  completion changes, saves a counter, and draws stars. Initial events do not
  double-count completions on reload. It counts observed finished turns,
  including interruptions and failures, rather than providing an audit log.

## Raw JSONL

Other languages can use `command = ["python3", "main.py"]` instead of `entry`.
It is an argv array launched directly, without a shell. Raw programs own their
stdin/stdout JSONL loop; stderr is for diagnostics. Only raw command manifests
accept optional `[subscribe]` and `[config]` tables. The initial message is
`{"event":"ready","version":1,"config":{},"kv":{}}`. Raw programs default
to no events until they subscribe.

| Operation | Fields |
| --- | --- |
| `subscribe` | `events` (string or array), optional `where` |
| `ui.set` | `key`, `view` |
| `ui.remove` | `key` |
| `kv.get`, `kv.delete` | `key` |
| `kv.set` | `key`, `value` |

Add a string or integer `id` for a reply:
`{"id":"save","ok":true,"result":null}` or
`{"id":"save","error":"StoreTooLarge"}`. Commands without IDs omit success
replies; errors still arrive with `id: null`. Failed commands leave prior
state intact. Subscriptions replay initial metadata before their reply.
Raw subscriptions and decorations accept exact-match `where` selectors for
`id`, `provider`, `account`, `workspace`, `session`, and `state`. Fields combine
with AND. Snapshot agents are filtered; a change matches either its current
or previous agent so a consumer sees it leave a filter. Unassociated hooks
match provider-only filters. Replacing a raw subscription replays its initial
metadata. In code tricks, express these conditions directly in callbacks.

The core is [trick_runner.ts](../src/trick_runner.ts) (registration and dispatch),
[tricks.ts](../src/tricks.ts) (contract), [trick_host.ts](../src/trick_host.ts)
(processes/events/KV), [trick_budget.ts](../src/trick_budget.ts) (watchdog), and
[trick_ui.ts](../src/trick_ui.ts) (drawing), with
[trick_style.ts](../src/trick_style.ts) providing palette and brand references.
Tricks protocol and KV start at version 1. Runtime and viewer protocol 3 remain unchanged: new management
operations are capability-advertised, and viewer drawings are optional.
Checkpoints and handoffs carry no trick state; programs rebuild it from KV.
