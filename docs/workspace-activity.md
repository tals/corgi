# Workspace activity

The workspace's second line uses the same colors and attention icons as the agent list:

- Yellow `N●`: working agents; green `○` with no number when none are working. The indicator uses a three-column slot so idle, single-digit, and two-digit counts align.
- Red, bold `N●`: agents blocked or needing input.
- Teal, bold `N unread`: unread agents.
- `N⚒`: reported tool calls while away.

Tool counts are right-aligned and stay visible even at zero. Token usage is still tracked in workspace stats but is not shown in the sidebar. The unread count remains visible, including zero, when away statistics appear. Working counts are omitted when space is tight. The full unread label and needs-input count take priority. All counters stay within the two-line workspace entry. Working, attention, and unread are live agent counts; tool and token counters clear when a focused viewer opens the workspace and stay clear while any focused viewer watches it. An unfocused window or detached viewer does not suppress activity when the terminal reports focus changes. If another viewer still reports the workspace as focused, its counters remain cleared. Counters are shared across viewers and saved with runtime checkpoints.

Ordinary Codex and Claude sessions use incremental, session-validated transcript reads on a background worker. Codex's existing read-only daemon observer supplies its transcript path; Claude hooks supply theirs. Native sessions use their existing provider event stream. Tool calls count once per reported call ID, not once per start/result event. Token reports are deduplicated using cumulative totals or message IDs. Input includes reported cache reads/writes; output includes reasoning where the provider includes it in output totals. These are activity counters, not a billing estimate or context-window measurement.

Counting begins when Corgi binds an observable session. Existing transcript history establishes a baseline and is not counted as new activity. Usage is attributed when the provider reports it, so streaming token totals may arrive in batches. Missing transcripts, records larger than 1 MiB, and provider formats that omit usage cannot supply complete totals. Subagent transcripts are not recursively followed. Reloading preserves displayed totals but seeds a new transcript baseline, so events written during the handoff may be omitted.

No setup beyond `./go.sh` is required for an already observed session. To see away totals accumulate, select another workspace in every viewer watching it, then let its agent do new work. Returning clears those totals.

## Agent activity summaries

Agent entries reserve their first line for the name and their second line for
current activity. Long names clip with an ellipsis instead of occupying the
activity line. Codex summaries are 2–3 words based on the current turn's latest
assistant update and original request, read through the existing daemon observer.
They describe reported activity; this first version does not ingest individual
tool calls or summarize native sessions. Claude retains its existing hook labels.

A single background inference worker coalesces updates, runs at most once per
20 seconds per active turn and once per 5 seconds globally, and skips unchanged
evidence. Results are checked against the session, turn and evidence before
being displayed. Completion or a request for input replaces the summary
immediately. While awaiting a first result, the label reads `Working on request`.
Failures keep the fallback or last valid label and retry after a 60-second delay.

The default backend runs an ephemeral `codex exec` with existing Codex login,
read-only sandbox, low reasoning effort, user config and project documents
excluded, and shell tools/apps/memories disabled. It requires CLI support for
`--ephemeral`, `--ignore-user-config`, and `--ignore-rules`. It has a 45-second
deadline and is terminated when Corgi stops. These inference requests consume
Codex usage. The CLI default model is used unless `CORGI_SUMMARY_MODEL` is set.

The inference boundary is independent of the observed provider. To replace the
backend (for example with a persistent App Server service or Claude worker), set
`CORGI_SUMMARY_COMMAND=/absolute/path/to/worker` in the server environment. It is
an executable path, not a shell command. Each invocation receives one JSON object
on stdin with `provider`, `evidence`, and `previous` strings, and must emit only a
2–3 word UTF-8 label on stdout and exit successfully. Treat evidence as data, never
as instructions. No provider credentials or connection code belongs in the UI.
A built-in Claude inference backend and Claude evidence adapter are future work.
Set `CORGI_SUMMARY_COMMAND=off` to disable inference. Environment settings take
effect when the server starts; a reload preserves the existing server environment.
