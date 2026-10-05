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
| `surface` | Raised areas on `bg`: launcher panel, menus, dialogs |
| `selected` | Selected row. Inputs and buttons on `surface`. Empty meter and spark cells |
| `line` | Borders, rules. Keycap background |
| `faint` | Labels, column headings, secondary numbers, footers |
| `muted` | Secondary text: model, subtitle |
| `text` | Body text |
| `strong` | Titles, buttons, key names. The number a table ranks by. Use with bold |
| `accent` | Live: working, current step, graphs, usage below 80%. Current focus: outline, bar, input border |
| `warm` | Needs the user: input wait, unpushed commits, limit at 80% or more, context near full |
| `hot` | Limit at 100%. Failure |

Contrast: text tokens on `bg` or `surface` are 4.5:1 or more. On `selected`,
use `muted` or brighter. Tests check this.

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
