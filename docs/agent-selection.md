# Select agents

Try the isolated world with `./go.ts --sandbox multiselect`. It contains twelve fake agents in `app` and another in `docs`. Use `--restart` to reseed it after closing agents.

Click **[Select]** below the agents header, or use **prefix, a** to focus the agent list. The sandbox prints its prefix when it starts; a nested Corgi uses the other prefix so the outer viewer can keep its own.

| Input | Behavior |
| --- | --- |
| Space | Toggle one agent, keeping the cursor there. |
| ↑ / ↓ or j / k | Move the cursor without changing existing marks. |
| v, then movement | Start a contiguous range. v or Enter keeps it; Esc restores the marks from before the range. |
| Shift+↑ / Shift+↓ | Extend or shrink from the anchor. Earlier independent marks stay selected. |
| Ctrl-click | Toggle one agent and focus it, keeping other marks, when the terminal forwards the modifier. |
| Shift-click | Extend from the anchor, when forwarded. A click during a `v` range chooses its end. |
| a | Select all agents in unfolded groups in the current scope, including offscreen rows. |
| m or right-click on a marked agent | Open selection actions. |
| Esc | Cancel a visual range, otherwise clear marks, then leave the list on the next press. |
| Plain row click / Enter | Open that agent and clear marks. Enter first commits an active visual range. |

`Space` and `v` are separate commands, not a chord. To collect disjoint groups, mark individual agents with Space, use v and movement for a block, commit it, move to another start, and repeat.

The first Ctrl-click outside the focused list starts from the currently focused agent: clicking another adds it, and clicking the same agent deselects it.

The selection menu shows Star if any selected agent is unstarred, otherwise Unstar; `s` runs the displayed action. It can also mark eligible agents unread or close selected agent panes. Closing has a confirmation with Cancel initially highlighted. Headless agents support starring; unread and close apply to panes, with eligible counts in the menu. Actions recheck agent identity and report skipped or failed targets.

All four keymap presets share these list-only defaults. The `agent-select-*` actions can be rebound in the keyboard settings; their bindings can coexist with pane shortcuts. They are not exported as global Ghostty shortcuts. Space and letters continue to reach terminal programs when a pane has focus.

Ctrl-click depends on the terminal forwarding SGR mouse modifiers. Shift is often reserved for terminal text selection, and standard SGR mouse reports have no dedicated Command modifier. Space and v work without mouse modifiers; Shift-arrow ranges accept both legacy modified-arrow sequences and Kitty keyboard events.

Selection uses row color, with the existing bar or rail showing focus separately. Selection is private to the viewer. Folding retains marks and shows a hidden count. Search remains a navigation overlay; canceling it restores the marked list. Ordinary workspace switches and opening an agent clear the selection; Ctrl-click keeps it, including across workspaces in All scope. Departed agents and replacement conversations lose their marks.

Cache Alert: while marks or a visual range exist, each viewer holds the list's order and grouping in memory, plus agent identities for range members and bulk actions. Statuses refresh from snapshots, removed agents drop out, and new rows wait until selection clears or the scope or sort changes. Changing scope or sort keeps marks and commits the current range, then captures the new order. The held order prevents activity sorting from moving a range while it is being selected; it is released when selection ends and is never saved to disk.
