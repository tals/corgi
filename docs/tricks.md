# Corgi Tricks

A trick is a folder with `trick.toml` and a program. Corgi starts the program
once per daemon and exchanges JSONL over its stdin and stdout. Use any language;
the examples use JavaScript and Node's standard library. No SDK or dependencies.

Try the four examples together in an isolated world:

```sh
./go.ts --sandbox tricks
```

To install one in your normal environment:

```sh
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/corgi/tricks"
cp -R examples/tricks/account-colors "${XDG_CONFIG_HOME:-$HOME/.config}/corgi/tricks/"
corgi tricks reload
corgi tricks list
```

Edit the copied manifest's account paths, then reload. `CORGI_TRICKS_DIR` on
the daemon overrides the discovery directory. Only explicitly installed
folders in that directory run; Corgi does not discover code in repositories.
Set `enabled = false` in a manifest to disable it. Reload applies changes,
including deleted folders, and clears their drawings. Tricks run with your
user's permissions and receive `CORGI_SOCKET` for ordinary Corgi RPC calls.

## Color an account

The [account-colors example](../examples/tricks/account-colors/main.mjs) is an
eleven-line program. It reads rules from its manifest and installs them on
startup. For [issue #44](https://github.com/tals/corgi/issues/44), configure:

```toml
version = 1
id = "account-colors"
command = ["node", "main.mjs"]

[[config.rules]]
where = { provider = "claude", account = "" }
marker = "accent"

[[config.rules]]
where = { provider = "claude", account = "/home/me/company-claude" }
marker = "#83b6ef"
```

The default account is `""`; other accounts use their canonical config folder.
`corgi rpc '{"op":"session.snapshot"}'` shows each pane's `account` value.
Use that exact value, including resolved symlinks; selectors do not expand
`~`, environment variables or account display names. Include `provider` when
matching an account. To color a whole agent type, omit `account`.

Each rule becomes one command:

```json
{"op":"ui.set","key":"company","view":{"kind":"decorate","where":{"provider":"claude","account":"/home/me/company-claude"},"marker":"#83b6ef"}}
```

Corgi evaluates the rule against current and future agents. No agent map,
polling, subscription, or per-agent cleanup is necessary. The marker appears
in both flat and grouped lists; focus makes it brighter and heavier.

The manifest is the persistent source of truth for preferences. Renaming a
display label does not affect an account rule. Moving its config folder does.
This first example implements the account marker; it does not add the issue's
optional `CORGI_AGENT_COLOR` environment override.

## Events

The manifest declares an optional subscription:

```toml
[subscribe]
events = ["agent.changed", "agent.removed"]
where = { provider = "claude" }
```

Omit it for no events, or use `events = ["*"]` for the firehose. All tricks
first receive `ready`, regardless of their subscription:

```json
{"event":"ready","version":1,"config":{},"kv":{"count":7}}
```

`config` is the manifest's `[config]` table. `kv` contains the trick's saved
values. The command runs with its folder as the working directory, and
`command` is an argv array, executed directly without a shell.

| Event | Contents |
| --- | --- |
| `snapshot` | `agents` and `workspaces`; initially and whenever observed state changes |
| `agent.changed` | `agent` and `previous`; initial agents have `previous: null` |
| `agent.removed` | The last `agent` record after it leaves the runtime |
| `hook` | Provider `data`, `provider`, and associated `agent` or `null` |

An agent record contains `id` (`pane:3` or `headless:2`), `provider`, `account`,
`workspace`, `session`, `name`, `state`, `attention`, `activity`, and `completed`.
`completed` is a decimal string counter, preserving 64-bit precision. Headless
agents currently use the default account. Only attached pane and headless
agents appear; detached historical conversations are outside this first API.
Workspace records contain `id`, `name`, and `cwd`.

The same exact-match selectors serve subscriptions and decorations: `id`,
`provider`, `account`, `workspace`, `session`, `state`. Fields combine with AND.
Snapshot agent lists are filtered; workspace metadata is retained. A change
is delivered if either its current or previous agent matches, so consumers
can remove agents that leave a state filter. Unassociated hooks can match
provider-only filters. Other agent filters require an associated agent.

Replace a subscription at runtime with:

```json
{"id":"watch","op":"subscribe","events":["snapshot"],"where":{"provider":"codex"}}
```

This immediately supplies the selected initial snapshot and/or initial
`agent.changed` events before the reply. Events include `at` (Unix milliseconds)
and `seq` (a daemon-local decimal string sequence). Sequence gaps are normal
with filters and multiple subscribers. This is an observation stream, with
no replay or exactly-once delivery across restarts. Intermediate observed
states may coalesce; `hook` forwards each received provider hook. Terminal
output and transcript contents are not separate event streams in v1.

## Drawing and RPC

Write one JSON command per stdout line. Use stderr for diagnostics. Add a
string or integer `id` to get a reply. Success is
`{"id":"save","ok":true,"result":null}`; errors are
`{"id":"save","error":"InvalidColor"}`. Failed commands leave previous
drawings and saved values intact. Commands without an ID have no success
reply; errors still arrive with `id: null`.

| Operation | Fields | Effect |
| --- | --- | --- |
| `ui.set` | `key`, `view` | Insert or replace a drawing owned by this trick |
| `ui.remove` | `key` | Remove that drawing, if present |
| `subscribe` | `events`, optional `where` | Replace the event subscription |
| `kv.get` | `key` | Return the JSON value, or `null` when absent |
| `kv.set` | `key`, `value` | Atomically save a JSON value |
| `kv.delete` | `key` | Atomically remove a saved value |

`decorate` targets sidebar agents. It accepts `where`, optional `color` for
the name, optional `marker` for the margin, and optional `suffix` spans:

```json
{"op":"ui.set","key":"claude","view":{"kind":"decorate","where":{"provider":"claude"},"color":"warm","suffix":[{"text":" ✦","color":"warm"}]}}
```

`overlay` accepts `lines` of spans and an `anchor`: `top-right` (default),
`top-left`, `bottom-right`, or `bottom-left`:

```json
{"op":"ui.set","key":"status","view":{"kind":"overlay","anchor":"top-right","lines":[[{"text":"2 waiting for you","color":"warm"}],[{"text":"• API migration"}]]}}
```

A span has `text` and an optional `color`. Colors are Corgi palette tokens
(`bg`, `surface`, `selected`, `line`, `faint`, `muted`, `text`, `strong`,
`accent`, `warm`, `hot`) or `#RRGGBB`. Tokens follow theme changes. Text cannot
contain terminal controls or newlines; use another overlay line.

Overlays appear in every viewer's pane area, below built-in dialogs and menus.
They are read-only, do not take focus, and leave keyboard and mouse input with
Corgi. Cards stack at their anchor and clip to available space. Suffixes reserve
up to half the name's available width and respect terminal character widths.
This first version has no widget toolkit, buttons, animation clock, or arbitrary
ANSI drawing.

Folders load in lexical order; drawings retain insertion order. Later matching
rules override earlier color fields; suffixes append. Replacing a key preserves
its position. Keys are local to a trick, so two tricks can both use `status`.

## Persistence and lifecycle

KV is scoped to the manifest `id` and Corgi runtime, beside that runtime's
settings: `<settings.json>.tricks/<id>.json`. Writes use private, atomic,
fsynced files; success replies follow the durable write. Use `id` on saves
whose success matters. KV survives trick reload, daemon handoff, cold restart,
and uninstall/reinstall. Different named environments have separate stores.
Changing a trick's ID starts a different store. Delete its JSON file while
the trick is stopped to reset it. Invalid stores fail that trick's startup
and are left untouched.

Drawings and in-memory program variables are ephemeral. On reload, handoff
or restart, Corgi starts the program again and sends its configuration and KV.
The program recreates its drawings. On exit, crash, disable, or removal, Corgi
removes all of that trick's drawings and terminates its process group. A failed
trick stays stopped until reload. `corgi tricks list` reports the failure;
diagnostics go to `server.log`. A failed daemon handoff restarts the old
daemon's tricks from their saved KV.

Limits keep this small: 16 installed folders, 32 drawings and 64 KiB of UI
state per trick, 64 KiB per incoming line and per KV file, 12 lines per overlay,
16 spans per line, and 512 UTF-8 bytes per span. A trick exceeding 1,000
commands per second or the output line limit stops; a subscriber falling
more than 1 MiB behind also stops. Other tricks and viewers continue.

## More examples

- [Provider flair](../examples/tricks/provider-flair/main.mjs) colors agent
  names and appends a small provider glyph. It needs no events or saved state.
- [Attention radar](../examples/tricks/attention-radar/main.mjs) turns a
  filtered snapshot into an overlay listing agents waiting for input. The
  overlay disappears when they resume.
- [Completion jar](../examples/tricks/completion-jar/main.mjs) watches completion
  counter changes, saves a total in KV, and draws stars after each save is
  acknowledged. Initial events don't double-count old completions after reload.
  It counts observed completions, including interrupted or failed turns; it
  is a small activity counter, not an accounting ledger.

The core lives in [tricks.ts](../src/tricks.ts) (types and validation),
[trick_host.ts](../src/trick_host.ts) (processes, events, KV), and
[trick_ui.ts](../src/trick_ui.ts) (drawing). Tricks protocol and KV format start
at version 1. The new `tricks.list` and `tricks.reload` operations are
capability-advertised runtime operations; runtime and viewer protocol 3 remain unchanged because the new
viewer field is optional. Checkpoints and handoff formats are unchanged;
tricks rebuild their ephemeral state instead of transferring it.
