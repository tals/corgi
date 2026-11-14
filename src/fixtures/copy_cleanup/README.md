# Copy cleanup corpus

Selections as a harness shows them in a pane, with the clipboard text
`copy_cleanup.clean` must produce for them. `commands/` must flatten to one
line; `documents/` must never flatten. `copy_cleanup.test.ts` loads every
file, and `wrap_margin` is calibrated against them.

Each file is a header, a blank line, the screen rows, a `---` line and the
expected clipboard text:

```
width: 50
start_x: 2
first_indent: 2

  kubectl --kubeconfig ~/.kube/home-config -n
  monitoring get pods
---
kubectl --kubeconfig ~/.kube/home-config -n monitoring get pods
```

- `width`: the pane width in cells.
- `start_x`: the column where the drag started, in reading order. The first
  row is written in full, as shown on screen; the test drops its first
  `start_x` characters to get the selected text, as the terminal would.
- `first_indent`: the width of the first row's leading whitespace on screen.
- A row longer than `width` stands for a line the terminal soft-wrapped and
  joined.

Files named `recorded_*` are Claude Code output copied raw from a Corgi pane
(an Alt-drag), at the pane width Claude Code printed them for; the rest are
written by hand to the same layout. Claude Code wraps at the full pane width
and splits a word wider than a row at the edge, so `wrap_margin` stays 0.
The command rows follow Claude Code's layout: a two-space indent, words
wrapped greedily at the pane width, and a token longer than a row split at
the edge.
