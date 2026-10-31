These screenshots show the real Corgi viewer running in an isolated UI-driver
PTY with the default Corgi preset. Ghostty captured the terminal cells and their
SGR styles; xterm.js displayed those captures with DejaVu Sans Mono for PNG
export. The editors are cropped to their actual 60 by 21-cell dialogs.

- `help-wide.png`: 112 by 46 cells, with Focus and Swap beside each other.
- `help-narrow.png`: 80 by 36 cells, with stacked directional pads.
- `help-small.png`: 48 by 28 cells, with Panes following Tabs and scrolling.
- `shortcut-editor.png`: alternate shortcuts, prefix toggle and recorder.
- `range-editor.png`: a direct range with combined modifiers and Use defaults.

The range screenshot shows an unsaved edit. The narrower help captures follow
Cancel, so they retain the preset bindings. No live accounts or personal
configuration were used.

The capture sequence uses `bun tools/ui_driver.ts run current` with:

```text
size 112x46
key ctrl+b ? ctrl+e
style help-wide
key enter
style shortcut-editor
key esc
key /
type Select tab
key enter enter
clicktext "Use prefix"
clicktext None
key space down space down space esc
style range-editor
key esc esc
resize 80x36
style help-narrow
resize 48x28
style help-small
```
