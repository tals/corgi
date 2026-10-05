# termhtml

A self-contained HTML toolkit for prototyping interfaces that fit a terminal cell
grid. **Open [index.html](index.html) directly in a browser.** No dependencies,
server, install, or build step. All CSS, JavaScript, and interactive examples live
in that one file; this README is the only companion file.

## How it works

```text
HTML widgets + current control values
                 |
           integer cell layout
                 |
          shared character buffer
             /          \
    browser cells      ANSI output
```

`TermHTML.mount(root)` reads elements marked with `data-tui` and paints a frame.
Each cell contains a character, foreground/background colors, bold state, and
underline style. The browser displays one positioned span per cell. ANSI export
reads the same frame and emits cursor-positioning and color/style escape codes.

The original HTML controls remain in an invisible layer above the cells. They
provide focus, keyboard events, text editing, and accessibility semantics. The
renderer draws their appearance, including selection and the text caret. Box and
block glyphs use full-cell CSS shapes to avoid gaps between font glyphs.

## Use it in a prototype

Copy `index.html` into your artifact and adapt the example. Its parts are:

- **`style#termhtml-styles`**: reusable cell and control styling.
- **`main#lab`**: example widget markup.
- **`script#termhtml-toolkit`**: reusable renderer and interaction handling.
- **The last script**: demo application behavior. Replace it with your handlers.

The additional style block and surrounding page markup are demo presentation.
For a smaller artifact, keep the two toolkit blocks, your screen markup, and your
application script, in that order. The toolkit script must run before mounting.

For example, replace the demo screen and its application script with:

```html
<main id="screen" data-cols="40" data-rows="8" aria-label="Prototype">
  <button id="hello" data-tui="button"
          data-x="2" data-y="2" data-w="16">Say hello</button>
  <span id="message" data-tui="text"
        data-x="2" data-y="4" data-w="36">Ready.</span>
</main>
<!-- Keep script#termhtml-toolkit here, before this application script. -->
<script>
  const ui = TermHTML.mount(document.querySelector('#screen'));
  document.querySelector('#hello').onclick = () => {
    document.querySelector('#message').textContent = 'Hello, terminal.';
    ui.render();
  };
</script>
```

## Layout and styling

`data-cols` and `data-rows` set the screen size. Widget `data-x`, `data-y`,
`data-w`, and `data-h` use integer cells, starting at zero. A child is positioned
relative to its closest `data-tui` ancestor, including that ancestor's border.
Leave a cell inside a box for its border. Geometry outside the parent throws.
Text clips to the widget; only explicit newlines start another row.

Set `data-fg` / `data-bg` to a six-digit hex color or a palette name: `fg`, `bg`,
`muted`, `line`, `accent`, `surface`, `selected`, `danger`, `warm`. The `corgi`
theme also names every token in `src/palette.zig` (`faint`, `text`, `strong`,
`hot`, ...); see `docs/ui_styleguide.md`. Other styles
are `data-bold`, `data-underline`, and `data-underline-color`. Styles inherit from
the nearest widget. Use these attributes for widget appearance so ANSI can match
it; arbitrary CSS decoration is not included in exported frames.

Default cell metrics are 9 × 20 pixels with 14px Menlo. Set `--th-cw`, `--th-ch`,
`--th-font-size`, and `--th-font` on your screen to match a terminal. Keep cell
dimensions integral. The screen stays fixed-size; narrow windows scroll.

## Controls

| `data-tui` | HTML element | What it does |
| --- | --- | --- |
| `box` | `section` | Bordered container; `data-title` labels the border |
| `text` | `span`, `label`, `output` | Literal, clipped text |
| `rule` | `div` | Horizontal cell line |
| `button` | `button` | Click, Enter, Space; supports `disabled` |
| `check` | `button aria-checked="false"` | Toggles a checkbox and emits `change` |
| `input` | `input type="text"` or `search` | Text editing, selection, paste, and caret |
| `range` | `input type="range"` | Keyboard adjustment and pointer dragging |
| `progress` | `progress` | Whole-cell bar from `value` / `max` |
| `list` | `div` with `span` children | Selection, keyboard navigation, scrolling |
| `tabs` | `nav` with `button` children | Tab selection and arrow-key navigation |
| `log` | `pre tabindex="0"` | Scrollable text; defaults to the last rows |

Buttons, checks, inputs, ranges, progress bars, and tabs occupy one row. Inputs
and bars need at least four columns. Lists and tabs use their direct, non-hidden
children as options. Their `change` event supplies `detail: { index, value }`,
where `value` comes from `data-value` or the option's text. Lists emit `activate`
on Enter. Your application handles tab panel visibility and action outcomes.

Change ordinary HTML text, values, attributes, or `hidden`, then call `render()`.
User input, focus, click, selection, and keyboard events automatically schedule
repainting. No framework or reactive state library is required.

## API

```js
const ui = TermHTML.mount(root, { theme: 'ink', kitty: false, ascii: false });
ui.render();                         // redraw current HTML/control state
ui.select(listElement, 2);            // select a visible option; emit change
ui.theme = 'corgi'; ui.render();      // ink, paper, or corgi (Corgi's palette)
ui.setKitty(true);                    // enable the optional underline extensions
ui.open('#dialog'); ui.close();       // modal focus trap and focus restoration
ui.toText();                         // fixed-width rows separated by newlines
ui.toANSI();                         // current frame as ANSI escape sequences
ui.snapshot();                       // { cols, rows, kitty, cells }
ui.destroy();                        // remove renderer/listeners; retain markup
```

Dialogs are top-level `data-tui="box" data-modal hidden role="dialog"` widgets
with an accessible label and focusable children. Opening makes background controls
inert; Escape closes and restores focus. Only one dialog is open per screen.

`TermHTML.Frame` is the drawing primitive behind the renderer. Its `put`, `fill`,
`text`, and `box` methods draw cells; `textContent()` and `ansi()` export them.
The running demo exposes its mounted instance as `window.lab` for experimentation.

## Terminal fidelity and Kitty

The shared buffer keeps character placement, dimensions, and requested RGB colors
consistent. **Cell-exact layout does not guarantee identical screenshot pixels:**
browser and terminal font rasterization, bold, underline shape, and antialiasing
can differ. Match the font, cell metrics, device scale, and terminal settings.

Text supports printable ASCII, these box/block glyphs:
`─│┌┐└┘├┤┬┴┼╭╮╰╯━┃╸▌█▀▄▁▂▃▅▆▇`, and Corgi's symbols `●○◌✓↳↻↑▾›…·≥≈—`.
Rounded corners draw square in the browser. Unsupported characters become `?`,
including emoji, wide characters, combining marks, and control characters.
Terminal output expects UTF-8, truecolor, VT cursor positioning, and single-cell
widths for those glyphs.
The `ascii` option changes generated borders/bars; it does not convert your text.

Kitty mode is **off by default**. It enables only styled and colored underlines:
`single`, `double`, `curl`, `dotted`, and `dashed`, using
[Kitty's underline protocol](https://sw.kovidgoyal.net/kitty/underlines/).
With the toggle off, these fall back to plain foreground-colored underlines.

**Export ANSI** downloads the current frame, including focus and any open dialog.
Display it in a terminal at least as large as the screen; the demo is 108 × 40.
The export uses absolute cursor positions and overwrites that area. It is a
snapshot; running the interactions in a terminal requires a terminal event loop
that drives the same state and cell rendering.

## Try the examples

The demo includes a searchable workspace list, editable form, checkboxes, slider,
tabs, themes, simulated task queue, progress, pause/resume/cancel, scrollable log,
confirmation/help dialogs, command palette, and ANSI download.

Use `/` to filter, `Ctrl+K` for commands, `?` for help, Tab / Shift+Tab to move
focus, arrows to navigate lists/tabs/sliders, and Escape to close dialogs.
