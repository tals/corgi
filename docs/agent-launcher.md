# New agent launcher

The agents heading has a split `New ▾` button. `New` opens a new interactive
agent tab in the focused pane's directory (or the workspace directory when
empty), repeating the last provider. Codex is the initial default. The choice
is shared by viewers and retained by live reload and disk recovery.

Hover over the button for an immediate preview, or click the arrow to keep the popover
open. Choose Codex or Claude Code to launch and remember that provider. A pinned
popover supports Up/Down, Tab/Shift-Tab, Home/End, Enter, and Escape.
Arrow keys stop at the first/last row; Tab cycles. Navigation keys also activate
a hover-opened popover. Escape keeps it dismissed until the pointer moves. Clicking outside dismisses it.
A hover preview accepts a, A, or Ctrl+A to launch; other ordinary typing goes to the terminal. Opening a preview never sends a prompt.

Press Ctrl+B, then a, A, or Ctrl+A to open the preview. Press any of those again to launch
the selected agent, or use arrows to select another provider first. The preview
starts with the last-used provider selected. The next-tab binding is unchanged. Jump to attention is now Ctrl+B, f.

The compact popover shows one row per provider with aligned agent and model
and account columns, a full-row selection highlight, and the destination folder in its footer. Codex
uses `config/read` with that directory and `model/list` for the provider default.
These calls use a separate, lazily started App Server on a background worker;
no thread or inference turn is created. Claude previews `ANTHROPIC_MODEL`, user,
project, local, and local managed settings. Aliases stay aliases; account policy,
trust, and dynamic defaults remain provider decisions. Missing or unreadable
configuration displays `Provider default` instead of guessing a specific model.

Previews are cached by directory for ten seconds. Interactive launches use
Corgi's existing discovered-binary launcher and ordinary provider settings,
without overriding models or adding a prompt. Each provider row has an independent
YOLO checkbox (click it, or press y for the selected row). It defaults off and
stays set across viewers, live reload, and disk recovery. Toggling keeps the
menu open and does not launch an agent. New and keyboard launches use that
provider's remembered setting. When enabled, Codex receives
`--dangerously-bypass-approvals-and-sandbox` and Claude Code receives
`--dangerously-skip-permissions`; when off, ordinary provider permissions apply. They do not use the
small-model status inference settings.

The protocol exposes `agent.preview` (workspace and cwd) and the session command
`agent.create` (workspace, optional cwd, optional provider). Omitting provider
repeats the shared choice. The session snapshot and checkpoint include
`last_agent`, with a Codex default for older data.

Account previews use Codex `account/read` without token refresh and Claude
`auth status --json`. They show an email, API-key mode, or login status; no
credential values are displayed. Reads are bounded and run on the preview worker.
