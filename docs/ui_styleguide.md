# UI styleguide

Design rules for Corgi's terminal interface. Use these when adding or reviewing
UI; they are not a claim that every existing screen already follows every rule.
The palette and status tables below describe the current implementation.

## Design principles

- Make the task, current focus, and next action apparent at a glance.
- Minimize required input. Infer context and offer sensible defaults.
- Support both keyboard and mouse use. Neither should feel like a fallback.
- Use spacing, alignment, gray steps, and bold to establish hierarchy.
  Reserve color for meaning; pair status color with a glyph or label.
- Keep the terminal usable as a terminal: selecting text, scrolling, and
  interacting with the program in a pane must remain predictable.
- Restyling should preserve layout and behavior. Propose changes to either
  explicitly so they can be reviewed on their own merits.

## Layout, hierarchy, and separation

- Give each region a clear job: navigation, content, details, or actions.
  Separate unrelated groups with space or a quiet rule, not another bright box.
- Make the title the strongest text, the task content readable, and metadata
  quieter. Avoid giving every label the same weight.
- Align repeated information in stable columns. Keep status, name, and trailing
  counts in consistent positions as values change.
- Keep row heights and hit targets stable during background updates. A status
  transition or animation must not move an adjacent action under the pointer.
- Distinguish keyboard focus, selected item, hover, and unread state. Hover is
  quieter than selection; moving the mouse must not masquerade as keyboard focus.
- Under narrow widths, shorten secondary details before primary names or
  actions. Preserve a way to inspect clipped information. Do not wrap a list
  unpredictably or hide its cancel action.

## Keyboard and mouse interaction

- Keep basic actions in one form, with optional settings outside the required
  path. Submitting completes the action without another configuration prompt.
- Keep renaming scoped to the name; do not follow it with a folder prompt.
- Save workspace names, default folders, and selection automatically.
- Make primary actions reachable from the keyboard and visible mouse targets.
  Route both through the same action so their effects and validation agree.
- Show a few relevant shortcuts beside actions or in a footer. Use the current
  shortcut preset; do not hard-code one preset's keys into explanatory copy.
- Keep focus visible, navigation order predictable, and Escape a dependable way
  back. Closing a popup should return focus to its originating control.
- Make a row's clickable area match its visible area. A small glyph should not
  be the only way to select a large row. Separate nested action hit targets.
- Provide hover feedback, but do not put essential information or the only
  action path in a hover-only tooltip or context menu.
- Preserve ordinary click/drag text selection in terminal content. Opening a
  link uses its explicit modifier-click gesture; it must not steal selection.
- Scope scrolling to the region under the pointer and keyboard navigation to
  the focused region. Keep the selected item visible when navigating a list.
- Label destructive actions with what they do and name their target. A
  confirmation should state what will stop or be lost and offer a clear cancel.

## Density and copy

- Put the decision first. Prefer a short heading, one explanatory sentence,
  and labeled actions to a paragraph describing the entire feature.
- Use a table for comparable values and a list for independent choices.
  Keep implementation detail out of user-facing dialogs.
- Show the few facts needed to act; reveal supporting detail on demand. Do not
  compress a paragraph into an equally dense pile of badges and abbreviations.
- Use concrete verbs: "Resume", "Rename", "Remove worktree". State errors as
  what failed and what the user can do next; retain technical detail in logs.
- Empty, loading, disabled, and failed states need distinct wording. An empty
  list should explain what belongs there and how to add it.

## Motion and personality

- Keep decorative motion subdued and within reserved space. It should not
  compete with a needs-input indicator, a focused field, or terminal output.
- Preserve informative feedback for thinking, digging, and compaction. A quiet
  interface still needs to show that work is continuing; a spinner is not a
  progress estimate.
- The decorative corgi uses gray, never a status color. Its normal tones are
  `faint`, `muted` on a selected sleeping row, and `text` during fetch.
- Sidebar intensity defaults to 50. Lower settings blend decoration toward
  the background; higher settings toward `text`. Zero hides decorative sidebar
  corgis. Digging and compaction feedback remain separate.

## Annotated examples

These are layout sketches, not literal screenshots or new shortcut assignments.

```text
Agents                         +     title and add action share a header
────────────────────────────────     quiet boundary, not a competing title
▶ Fix launcher                       stable status column; name is primary
  Codex · ~/dev/corgi                 metadata is quieter and aligned
● Check release                      warm status: needs input
  Claude · ~/dev/corgi
```

Keep the same row geometry when working changes to idle. Use `strong` and bold
for an unread name; use the row background for selection and the focus outline
for the active list. Do not make hover look like a second selected row.

```text
Remove worktree?                      strongest line
feature/search                       the target, readable without hunting

Uncommitted changes will be lost.     one concrete consequence

[ Cancel ]  [ Remove worktree ]       distinct keyboard and mouse targets
```

Show the consequence that actually applies to the operation. Keep extra
explanation behind details; keep the target and consequence beside the action.

## Palette, implementation, and checks

[src/palette.ts](../src/palette.ts) owns UI colors. Use tokens, never RGB
literals in UI code. Computed tints blend existing tokens.

| Token | Meaning and use |
| --- | --- |
| `bg` | Sidebar, cards, panels |
| `surface` | Raised areas: launcher, menus, dialogs, limit-spark panel |
| `selected` | Selected rows; inputs/buttons on `surface`; empty meter cells |
| `line` | Borders, separators, keycap background |
| `faint` | Labels, secondary numbers, footers |
| `muted` | Secondary text: model, subtitle |
| `text` | Body text |
| `strong` | Titles, buttons, key names, ranking value; use with bold |
| `accent` | Live work, focus, graphs, usage below 80%, added lines |
| `warm` | Needs attention: input wait, unpushed commits, limits at 80%+, context warning |
| `hot` | Failure, limits at 100%, urgent context warning, removed lines |
| `gold` | Starred agents: the starred heading, the edge and dividers of starred rows, the ★ before a starred name. A mark, never a status |

Text tokens on `bg` and `surface` must reach 4.5:1 contrast. On `selected`,
use `muted` or brighter, not `faint`. Hovered agent rows blend `bg` toward
`selected` by 50%; focus outlines blend `accent` toward `line` by 50%.

### Status

These are the agent-row indicators in [src/sidebar.ts](../src/sidebar.ts).
Unread names also use `strong`, bold. Ended rows use `muted` when selected.

| State | Glyph | Token |
| --- | --- | --- |
| Working | ▶ | `accent`, bold |
| Working, retrying a failed turn soon | ‖ | `warm`, bold |
| Needs input | ● | `warm`, bold |
| Finished, unread | ● | `accent`, bold |
| Paused, unread | ‖ | `accent`, bold |
| Paused | ‖ | `muted` |
| Idle | ○ | `muted` |
| Starting | ◌ | `muted` |
| Ended | ○ | `faint` |

### Themes and code colors

**Corgi** keeps its palette. It uses the terminal background when `text` reads
at 8:1 or better, adjusting surface steps as needed; otherwise it paints its own
background. **Animal Style** derives grays and accent colors from the terminal's
reported palette, maintaining contrast and recognizable green/amber/red roles.
It deepens unsuitable backgrounds and uses fallback colors when needed. Without
reported colors it uses Corgi's palette on the default terminal background.

Use `palette.bg("bg")` or `Style` for backgrounds: they select the terminal's
default background when appropriate. `palette.use` updates colors in place;
cached escape strings and computed tints must refresh with `palette.derived`.

Code highlighting uses `palette.syntax`, a separate family, so UI status colors
retain their meaning. Keyword/string/number/type/property colors are adjusted
to read at 4.6:1 on `bg`; functions use `strong`, comments `faint`, punctuation
`muted`. Animal Style draws syntax hues from terminal magenta, blue, and cyan.

```ts
import * as palette from "./palette"; // from a module in src/

let titleStyle = "";
palette.derived(() => {
  titleStyle = new palette.Style({ fg: "strong", bg: "surface", bold: true }).sgr();
});
function rowStyles() {
  return {
    title: titleStyle,
    label: palette.fg("muted"),
    hover: palette.mix(palette.colors.bg, palette.colors.selected, 50),
  };
}
```

### Change and review

1. Edit the palette in `src/palette.ts`. Refresh termhtml's `corgi` entry with
   the output of `bun -e 'import { termhtmlTheme } from "./src/palette"; console.log(termhtmlTheme())'`.
2. Run `bun test src/palette.test.ts src/terminal_palette.test.ts` for palette
   synchronization, contrast, and theme behavior.
3. Inspect the affected screen at narrow and normal widths, with long names,
   empty/error states, keyboard focus, mouse hover, and selection. Check both
   Corgi and Animal Style. [tools/theme_browser.ts](../tools/theme_browser.ts)
   records real screens under different terminal themes.
4. For a layout prototype, use [termhtml](../termhtml/README.md) with
   `theme: 'corgi'` and token names in `data-fg` / `data-bg`. Confirm the result
   in the terminal: browser rendering alone does not verify input or cell widths.
