const SETTINGS = [
	["enabled", "General", "Enable NodeSnapshots", true, "Enable the selected renderer optimizations."],
	["no_shadows", "Appearance", "Disable node shadows", false, "Remove node shadows at all times in both renderers, instead of only during Nodes 2.0 navigation. On the classic canvas this duplicates KJNodes' Disable node shadows; leave it enabled in one of the two."],
	["square_corners", "Appearance", "Disable rounded corners", false, "Draw nodes with square corners in both renderers. On the classic canvas this duplicates KJNodes' Disable rounded corners; changing it rebuilds stored images."],
	["legacy_enabled", "Legacy", "Enable Legacy snapshots", true, "Build node images while idle and reuse them during panning, zooming, dragging, and resizing. Turning this off disables Legacy capture and reuse completely."],
	["simplify_navigation", "Legacy", "Simplify live nodes during navigation", false, "Draw live nodes through LiteGraph's low-quality path while panning, zooming, dragging, and resizing: node titles, widget text, badges, and shadows are skipped, and zoom-sensitive DOM widgets are hidden. Snapshots keep full detail, so this only speeds up the nodes that stay live, such as ones with custom DOM widgets or media previews. Requires Enable Legacy snapshots."],
	["cache_while_idle", "Snapshots", "Show node snapshots while idle", true, "Also reuse images outside navigation. Hovered, selected, edited, preview, and executing nodes stay live. Custom drawing callbacks may need an exclusion."],
	["mark_cached", "Debug", "Mark cached nodes (camera)", false, "Bake a camera icon in the theme's primary accent color into each snapshot. Only image reuse shows the icon, with no additional per-frame drawing. Changing this setting rebuilds the cache; allow it to warm before measuring."],
	["memory_mb", "Snapshots", "Bitmap memory budget (MiB)", 256, "Budget for RGBA pixels, including a capture in progress. Browser overhead is additional. Least recently used images are evicted.", 8, 1024, 8],
	["capture_budget_ms", "Scheduling", "Capture batch budget (ms)", 3, "Yield between Legacy node captures or Nodes 2.0 DOM elements after this budget. Individual draws, style reads, and image decoding cannot be interrupted.", 1, 16, 0.5],
	["idle_delay_ms", "Scheduling", "Idle delay before capture (ms)", 50, "Wait after pointer, wheel, keyboard, and focus activity before building images.", 50, 5000, 50],
	["slow_capture_ms", "Scheduling", "Slow node cutoff (ms)", 32, "Reject a slow Legacy draw or Nodes 2.0 cloning step. The first slow operation can still pause the page; increasing the cutoff allows a retry.", 1, 100, 1],
	["max_dimension", "Snapshots", "Maximum bitmap dimension (px)", 2048, "Oversized nodes stay live instead of allocating large images or sacrificing detail.", 256, 8192, 256],
	["pixel_ratio", "Snapshots", "Capture pixel ratio", 2, "Pixels per graph unit, independent of viewport zoom. Images are scaled during reuse. Ratios below 1 trade text detail for less memory and pixel work; higher values use more memory; changing this setting rebuilds images.", 0.5, 4, 0.25],
	["max_age_ms", "Snapshots", "Idle refresh interval (ms)", 0, "Refresh older snapshots opportunistically while idle. They remain usable during interactions until content changes. 0 disables periodic refresh; detected content changes still invalidate images.", 0, 60000, 500],
	["exclude_pinned", "Snapshots", "Exclude pinned nodes", false, "Keep individually pinned nodes live in both renderers."],
	["capture_offscreen", "Snapshots", "Precache offscreen nodes", false, "Prepare offscreen nodes after visible candidates, within the same memory and scheduling budgets. Nodes 2.0 must have a mounted DOM node."],
	["release_while_executing", "Snapshots", "Release images while executing", false, "Free stored images when a prompt starts, so their bitmap memory is available during the run. Navigation falls back to live drawing until the cache warms again after the run."],
	["links_enabled", "Links", "Link snapshots", true, "Cache the visible link layer plus a configurable pan margin. Geometry changes and editing use live links. No full-graph bitmap is allocated."],
	["links_cache_while_idle", "Links", "Show link snapshots while idle", false, "Keep displaying cached links when navigation stops. Off restores sharp native links while idle and retains the snapshot for the next pan or zoom."],
	["links_overscan_px", "Links", "Link overscan (px)", 512, "Extra coverage on each side of the viewport, in screen pixels. Larger margins keep snapshots usable through longer pans, but can increase capture time and reduce sharpness to fit the link bitmap budget and 4096-pixel dimension limit.", 0, 2048, 64],
	["links_memory_mb", "Links", "Link bitmap budget (MiB)", 32, "Separate budget for one viewport link image, including its replacement. Larger viewports use a reduced pixel ratio.", 4, 256, 4],
	["excluded_types", "Snapshots", "Excluded node types", "", "Comma-separated exact node type names to keep live. Useful for custom animated or unusual drawing nodes."],
	["vue_enabled", "Nodes 2.0", "Reduce offscreen DOM rendering", true, "Use browser content-visibility on node bodies. This is native rendering containment, not a screenshot. Vue updates continue; link snapshots are controlled separately."],
	["vue_cache_enabled", "Nodes 2.0", "Experimental node snapshots", true, "Rasterize supported DOM nodes while idle and reuse them during navigation, or while idle if enabled. Editing stays live. Media, unsupported CSS, and failed captures stay live. Uses the shared bitmap budget and camera debug marker."],
	["vue_shadows", "Nodes 2.0", "Reduce shadows during navigation", false, "Temporarily remove node drop shadows during graph panning and zooming."],
	["diagnostics", "Debug", "Log capture failures", false, "Log capture failure summaries only; no workflow values are logged. NodeSnapshots.getStats() is always available."]
];

export async function install_settings(app, on_change)
{
	const settings = {};
	const ui = app.ui.settings;
	if (ui.setup) await ui.setup;
	for (const [key, group, name, fallback, tooltip, min, max, step] of SETTINGS)
	{
		const normalize = (value) =>
		{
			if (typeof fallback === "number")
			{
				const numeric = Number(value);
				return Number.isFinite(numeric) ? Math.min(max, Math.max(min, numeric)) : fallback;
			}
			return typeof value === typeof fallback ? value : fallback;
		};
		// Preserve settings saved during development under the original namespace.
		const id = `NodeSnapshot.${key}`;
		settings[key] = normalize(ui.getSettingValue(id, fallback));
		ui.addSetting({
			id,
			category: ["NodeSnapshots", group, name],
			name,
			tooltip,
			type: typeof fallback === "string" ? "text" : typeof fallback,
			defaultValue: fallback,
			...(min === undefined ? {} : { attrs: { min, max, step } }),
			onChange(value)
			{
				settings[key] = normalize(value);
				on_change(key);
			}
		});
	}
	return settings;
}
