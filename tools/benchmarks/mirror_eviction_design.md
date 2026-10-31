# Releasing inactive native mirrors

Implemented and validated in V18. See `mirror_eviction_findings.md` for the
combined macro result and the unrun same-binary memory/revisit experiment.

The age30 memory ladder measured 47.28 MiB PSS for sixteen pane records with one
initialized mirror and 60.96 MiB after visiting all sixteen. The production CPU
fixture visits every tab during geometry setup. Releasing inactive mirrors is
therefore a relevant bounded experiment; the 13.68 MiB contrast is not a promise
that the allocator will return every page.

Retain each mirror's last complete canonical View in Bun, including modes,
cursor, dimensions, images, bottom/offset and receipt. Previously `installed`
kept only frame and stamp. A `release()` method destroys only the native Terminal and
derived row/link caches. It refuses active selection/holding-selection, a closed
mirror, or a mirror without an installed View. Keep `known`, requested `offset`,
pending input and image metadata unchanged.

`ensure()` recreates the native terminal at the retained View's geometry and
full-installs that View through the existing scalar receiver before returning a
handle. Update native render state and advance the mirror's render revision.
Do not call public `receive()` during hydration: it would rewrite a newly
requested viewport and acknowledge metadata. Any input encoding/mode query
before the next RPC must see the retained modes. A same-stamp server response
may legitimately omit the surface, so clearing `known` or waiting for fresh data
is unnecessary. An incoming changed surface can first hydrate the old baseline
and then use the existing incremental receive path; correctness comes before
eliminating this one-time extra replay.

The viewer's small policy belongs immediately after collecting sync interests
and the single-pane sidebar ghost, before awaiting RPC. Retain all those pane
IDs, plus the workspace-ghost layout's pane IDs. The latter are rendered from
cached mirrors but are absent from RPC interests today; omitting them would
cause reconstruction every frame. Do not change subscriptions or freshness.
Release every other eligible mirror. No TTL, MRU list, budget scheduler or new
daemon protocol is needed for the first implementation.

All split placements remain pinned. Zoomed-away panes may release. Overlays do
not remove the underlying layout interests, so their dimmed/fallback renderers
remain safe. A viewport request remains separate from the last installed View;
hydration must preserve the newer requested offset. Restored ghost screens keep
the complete received live input modes. Images remain owned by Controller's
image manager; canonical row installation contains no Kitty image payloads, so
releasing a native mirror does not clear pixels, placements or in-flight image
RPCs. Selection gestures pin their native state until explicitly cleared.

No production caller directly feeds, restores or applies a theme to a mirror's
`inner` terminal. Mutations go through mirror receive/select/clearSelection;
other handle uses are synchronous render and input encoding. The sign-in child
terminals are separate objects and outside this policy.

The native differ borrows pane handles only for the synchronous compose call
(`frame_diff_bridge.zig:64–79`) and clears its temporary pane list afterward.
It retains owned cells/graphemes/links and scalar identities/row epochs
(`frame_diff.zig:71–118,380–410`), so it does not dereference an old freed pane.
JS Frames retain Mirror objects rather than native pointers. A restored terminal
gets a new native identity and render revision, preventing frame equality from
skipping the next presentation. A held viewer frame is recomposed; old display
cells remain owned by the differ.

Tests should cover exact styled/wide/link/cursor parity, native identity and
render revision changes, all input modes before RPC, same-stamp/no-surface
returns, changed/shortened/resize/replacement updates after release, pending
viewport requests, selection refusal, idempotent release/destroy, all visible
split panes, both sidebar ghost kinds, and no repeated native creation while a
preview remains displayed. Memory/CPU/visual validation follow in an exclusive
slot; source implementation alone does not establish memory savings or latency.
