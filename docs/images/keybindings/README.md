These screenshots show the real Corgi viewer running in an isolated UI-driver
PTY with the default Corgi preset. Ghostty captured the terminal cells and their
SGR styles; xterm.js displayed those captures with DejaVu Sans Mono for PNG
export. The editors are cropped to their actual 60 by 21-cell dialogs.

- `help-wide.png`: 112 by 46 cells, with Focus and Swap beside each other.
- `help-narrow.png`: 80 by 36 cells, with stacked directional pads.
- `help-small.png`: 48 by 28 cells, with Panes following Tabs and scrolling.
- `shortcut-editor.png`: alternate shortcuts, prefix toggle and recorder.
- `range-editor.png`: a direct range with combined modifiers and Use defaults.
- `recorded-shortcut-editor.png`: New tab after recording Ctrl+Alt+N, ready to save.
- `modifiers-open-editor.png`: Select tab mid-edit, with Ctrl and Alt checked in
  the open modifier menu.

The range screenshot shows an unsaved edit. The narrower help captures follow
Cancel, so they retain the preset bindings. No live accounts or personal
configuration were used.

Save the following block as `/tmp/keybindings.scenario`, then run
`bun tools/ui_driver.ts run current /tmp/keybindings.scenario`:

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

For the mid-edit captures, save this block as `/tmp/keybindings-editing.scenario`
and run `bun tools/ui_driver.ts run current /tmp/keybindings-editing.scenario`.
Each invocation starts a fresh viewer:

```text
size 112x46
key ctrl+b ? ctrl+e
key enter
clicktext "Use prefix"
clicktext Record
key alt+ctrl+n
style recorded-shortcut-editor
key esc
key /
type Select tab
key enter enter
clicktext "Use prefix"
clicktext None
key space down space
style modifiers-open-editor
```
