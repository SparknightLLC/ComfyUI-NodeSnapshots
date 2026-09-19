# Changelog

All notable changes to this project will be documented in this file.

<details open><summary>0.1.1 - 18 September 2026</summary>

### Improved

- Added configurable link overscan, defaulting to 512 pixels, to retain snapshots through longer pans within the existing bitmap memory and dimension limits.
- Added separate idle-display settings for node and link snapshots. Links render natively while idle by default, retaining their image for the next pan or zoom.
- Moved cached links onto a separate composited layer in standard canvas layouts, preserving group/node ordering and avoiding repeated link-image and background copies.
- Reduced link validation during panning with immediate revision checks and periodic geometry checks for unreported extension edits.
- Reused each visible node's content check for a short interval while the viewport is moving, instead of reserializing every node on every frame.
- Stopped rewriting unchanged Nodes 2.0 snapshot attributes and coalesced observer updates into one pass per frame.
- Kept node and link images across prompt execution. Progress, output, and content changes now invalidate individual nodes instead of clearing the whole cache, and panning keeps reusing images while a prompt runs.
- Deferred new snapshot captures until execution ends, so capture work does not compete with a running prompt.
- Added a **Release images while executing** option that frees stored images when a prompt starts, for systems where the bitmap memory matters more than navigation speed during a run.
- Preserved valid link snapshots when panning ends, avoiding unnecessary recapture.

### Fixed

- Panning outside a link snapshot now falls back to native rendering without repeatedly scanning graph geometry or queuing captures during the gesture.
- Hidden links now bypass snapshot validation and capture, releasing their bitmap while retaining native hit-path cleanup.

</details>

<details><summary>0.1.0 - 18 September 2026</summary>

### Added

- Individual Legacy node snapshots for panning, zooming, dragging, resizing, and idle display, with live editing and execution fallback.
- Experimental Nodes 2.0 DOM snapshots and optional offscreen rendering reduction.
- Bounded viewport link snapshots with a separate memory budget.
- Configurable capture quality, memory and scheduling budgets, idle refresh, and offscreen precaching.
- Snapshot retention across zoom, movement, and subgraph navigation.
- Per-node exclusions using pinning, plus node-type exclusions.
- A theme-accent camera marker baked into snapshots and browser-console diagnostics.

</details>
