# Workspace activity

The workspace's second line uses the same colors and attention icons as the agent list:

- Yellow `N●`: working agents.
- Red, bold `N●`: agents blocked or needing input.
- Teal, bold `N unread`: unread agents.
- `N⚒`: reported tool calls while away.
- `↓N↑N`: reported input/output tokens while away (`k`, `M`, etc. abbreviate large totals).

Tool and token metadata is right-aligned. Tool counts stay visible even at zero; token counts appear only when reported, with no placeholder for unknown usage. The unread count remains visible, including zero, when away statistics appear. Working counts are omitted when space is tight. The full unread label and needs-input count take priority; if compact usage totals cannot fit beside them, the token pair is omitted. All counters stay within the two-line workspace entry. Working, attention, and unread are live agent counts; tool and token counters clear when a focused viewer opens the workspace and stay clear while any focused viewer watches it. An unfocused window or detached viewer does not suppress activity when the terminal reports focus changes. If another viewer still reports the workspace as focused, its counters remain cleared. Counters are shared across viewers and saved with runtime checkpoints.

Ordinary Codex and Claude sessions use incremental, session-validated transcript reads on a background worker. Codex's existing read-only daemon observer supplies its transcript path; Claude hooks supply theirs. Native sessions use their existing provider event stream. Tool calls count once per reported call ID, not once per start/result event. Token reports are deduplicated using cumulative totals or message IDs. Input includes reported cache reads/writes; output includes reasoning where the provider includes it in output totals. These are activity counters, not a billing estimate or context-window measurement.

Counting begins when Corgi binds an observable session. Existing transcript history establishes a baseline and is not counted as new activity. Usage is attributed when the provider reports it, so streaming token totals may arrive in batches. Missing transcripts, records larger than 1 MiB, and provider formats that omit usage cannot supply complete totals. Subagent transcripts are not recursively followed. Reloading preserves displayed totals but seeds a new transcript baseline, so events written during the handoff may be omitted.

No setup beyond `./go.sh` is required for an already observed session. To see away totals accumulate, select another workspace in every viewer watching it, then let its agent do new work. Returning clears those totals.
