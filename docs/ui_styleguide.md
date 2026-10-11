# UI styleguide

Source: `src/palette.zig`. termhtml has a copy: the `corgi` theme in
`termhtml/index.html`. A test keeps the two equal.

## Rules

1. Use tokens. Do not write RGB in UI code.
2. Use three colors: gray, green (`accent`), warm (`warm`, `hot`).
3. Each color has one meaning. All other things are gray.
4. Show importance with gray steps and bold, not with color.
5. Show status with shape and color.
6. Keep the layout when you restyle. Propose layout changes separately.
7. The corgi is gray: `text` awake, `faint` asleep. It never takes a status color.

## Tokens

| Token | Use |
|---|---|
| `bg` | Sidebar, cards, panels |
| `surface` | Raised areas on `bg`: launcher panel, menus, dialogs. The panel behind a limits spark |
| `selected` | Selected row; a hovered agent row takes `mix(bg, selected, 50)`. Inputs and buttons on `surface`. Empty meter cells |
| `line` | Borders, rules. Keycap background. The stipple over a limits spark's time left |
| `faint` | Labels, column headings, secondary numbers, footers |
| `muted` | Secondary text: model, subtitle |
| `text` | Body text |
| `strong` | Titles, buttons, key names. The number a table ranks by. Use with bold |
| `accent` | Live: working, current step, graphs, usage below 80% (short limit-spark bars fade toward `faint`). Current focus: bar, input border; the focus outline, and a focused list's scroll thumb, take `mix(accent, line, 50)` |
| `warm` | Needs the user: input wait, unpushed commits, limit at 80% or more, context near full |
| `hot` | Limit at 100%. Failure |

Contrast: text tokens on `bg` or `surface` are 4.5:1 or more. On `selected`,
use `muted` or brighter. Tests check this.

## Themes

The Corgi theme keeps these tokens. On a terminal background where `text`
reads at 8:1 or more, `bg` is left to the terminal, `surface`, `selected` and
`line` step up from it, and the other tokens lift only where the rules ask;
on any other background Corgi paints its own `bg`.

Animal Style derives every token from the terminal's reported colors
(`src/terminal_palette.ts`): grays are contrast steps from its background
toward its foreground, and `accent`, `warm` and `hot` come from its ANSI green,
yellow and red. They keep each token's meaning and pass the same contrast
tests for any theme. `warm` stays amber to yellow and `hot` stays red, so a
theme without such colors gets Corgi's sand or coral. `palette.bg("bg")` and a
`Style` with `bg: "bg"` send the default background (SGR 49), unless the
background was too mid-toned and had to be deepened. Without the terminal's
colors, Animal Style is Corgi's colors on the default background.

`palette.use` repaints `colors` in place. A module that builds strings from
tokens once builds them in `palette.derived(...)`, which runs again after
every theme change. `tools/theme_browser.ts` records Corgi's screens under
each of Ghostty's bundled themes for review.

## Status

| State | Glyph | Token |
|---|---|---|
| Working | ▶ | `accent`, bold |
| Needs input | ● | `warm`, bold |
| Finished, unread | ● | `accent`, bold; the name is `strong`, bold |
| Paused, unread | ‖ | `accent`, bold; the name is `strong`, bold |
| Paused | ‖ | `muted` |
| Idle | ○ | `muted` |
| Starting | ◌ | `muted` |
| Ended | ○ | `faint` |

## Code

```zig
const palette = @import("palette.zig");
palette.fg(.muted)                                    // foreground only
palette.bg(.surface)                                  // background only
(palette.Style{ .fg = .strong, .bold = true }).sgr()  // reset, then style
comptime "\x1b[1m" ++ palette.fg(.strong)             // ++ needs comptime
palette.underline(.line)                              // underline color
palette.keycap                                        // a key drawn as a cap
palette.mix(from, to, 40)                             // fade; terminals have no alpha
palette.fgRgb(rgb), palette.bgRgb(rgb)               // computed color, comptime
palette.writeFg(w, rgb)                               // computed color, runtime
```

`fg`, `bg`, `underline`, `fgRgb`, `bgRgb` and `sgr` give comptime strings.

## Change a color

1. Edit `Token.rgb` in `src/palette.zig`.
2. Run `./scripts/zig build test -Dtest-filter=termhtml`.
3. Copy the line that the test prints into `themes` in `termhtml/index.html`.

## Prototype

Use termhtml with `theme: 'corgi'`. Token names work in `data-fg` and
`data-bg`.

## Not yet

Light terminals. Add a second table when we need it.
