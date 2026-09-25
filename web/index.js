import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { install_settings } from "./settings.mjs";
import { LegacyCache } from "./legacy.mjs";
import { VueOptimizer } from "./vue.mjs";
import { BitmapCache } from "./cache.mjs";
import { DomSnapshotCache } from "./dom-cache.mjs";
import { LinkCache } from "./links.mjs";
import { load_camera } from "./marker.mjs";

let settings;
let legacy;
let vue;
let dom_cache;
let bitmap_cache;
let links;
let executing = false;
let sync_timer;
const listeners = new AbortController();

function sync()
{
	if (!settings) return;
	if (app.canvas && app.canvas !== legacy?.canvas)
	{
		legacy?.dispose();
		links?.dispose();
		legacy = new LegacyCache(app.canvas, settings, () => executing, bitmap_cache);
		links = new LinkCache(app.canvas, settings, () => executing);
	}
	vue?.sync();
	dom_cache?.sync();
	legacy?.queue_offscreen();
}

function clear(reason = "manual")
{
	legacy?.clear(reason);
	dom_cache?.clear();
	links?.clear();
	app.canvas?.setDirty(true, true);
}

function theme_signature()
{
	const palette = Object.entries(window.LiteGraph ?? {})
		.filter(([key, value]) => /COLOR|FONT/.test(key) && ["string", "number"].includes(typeof value));
	const styles = [document.documentElement, document.body].map((element) => [
		[...element.classList].filter((name) => /(^|[-_])(dark|light|theme)([-_]|$)/i.test(name)),
		[...element.style].filter((name) => name.startsWith("--"))
			.map((name) => [name, element.style.getPropertyValue(name)])
	]);
	return JSON.stringify([palette, styles]);
}

app.registerExtension({
	name: "Sparknight.NodeSnapshots",
	async setup()
	{
		await load_camera();
		settings = await install_settings(app, (key) =>
		{
			legacy?.configure(key);
			dom_cache?.configure(key);
			if (links && (key === "enabled" || key === "slow_capture_ms" || key.startsWith("links_")))
			{
				links.blocked_signature = null;
				if (key !== "links_cache_while_idle") links.clear();
			}
			if (key === "enabled" || key === "vue_enabled" || key === "vue_shadows"
				|| key === "no_shadows" || key === "square_corners") vue?.detach();
			sync();
			app.canvas?.setDirty(true, true);
		});
		bitmap_cache = new BitmapCache(settings.memory_mb * 1024 * 1024);
		vue = new VueOptimizer(settings);
		dom_cache = new DomSnapshotCache(settings, bitmap_cache, () => app.canvas, () => executing);
		sync();
		// Detect renderer switches/replaced canvases without a perpetual RAF loop.
		sync_timer = setInterval(sync, 500);
		for (const name of ["pointermove", "pointerdown", "pointerup", "pointercancel", "wheel", "keydown", "input", "change", "focusin"])
		{
			document.addEventListener(name, (event) =>
			{
				legacy?.scheduler.input();
				dom_cache.input(event);
				links?.input(event);
				if ((name === "pointermove" && app.canvas?.dragging_canvas)
					|| (name === "wheel" && (event.target === app.canvas?.canvas
						|| event.target.closest?.("[data-testid='transform-pane']")))) vue.navigation();
			}, { capture: true, passive: true, signal: listeners.signal });
		}
		for (const name of ["execution_start", "executing", "execution_success", "execution_error", "execution_interrupted"])
		{
			api.addEventListener(name, (event) =>
			{
				const was_executing = executing;
				if (name === "execution_start") executing = true;
				else if (name === "executing") executing = event.detail !== null;
				else executing = false;
				if (was_executing === executing) return;
				// Execution invalidates individual nodes, not the whole cache,
				// unless the user prefers to free the bitmap memory instead.
				if (executing && settings.release_while_executing) clear("execution");
				app.canvas?.setDirty(true, true);
			}, { signal: listeners.signal });
		}
		api.addEventListener("executed", (event) =>
		{
			// The frontend attaches a node's output images while it renders live,
			// so a node whose output arrives must stop reusing its old image.
			const id = event.detail?.display_node ?? event.detail?.node;
			if (id === undefined || id === null) return;
			legacy?.invalidate_node(id);
			dom_cache?.invalidate_node(id);
			app.canvas?.setDirty(true, true);
		}, { signal: listeners.signal });
		let last_theme = theme_signature();
		const theme_observer = new MutationObserver(() =>
		{
			const current_theme = theme_signature();
			if (current_theme === last_theme) return;
			last_theme = current_theme;
			load_camera().then(() => clear("theme"));
		});
		theme_observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
		theme_observer.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
		document.fonts?.addEventListener("loadingdone", () => clear("fonts"), { signal: listeners.signal });
		document.addEventListener("visibilitychange", () =>
		{
			legacy?.scheduler.clear();
			legacy?.scheduler.input();
			dom_cache.clear();
			app.canvas?.setDirty(true, true);
		}, { signal: listeners.signal });
		window.addEventListener("pagehide", (event) =>
		{
			clear("pagehide");
			if (event.persisted) return;
			clearInterval(sync_timer);
			listeners.abort();
			theme_observer.disconnect();
			legacy?.dispose();
			links?.dispose();
			vue.detach();
			dom_cache.detach();
		}, { signal: listeners.signal });
		window.NodeSnapshots = Object.freeze({
			getStats: () => ({
				renderer: window.LiteGraph?.vueNodesMode ? "Nodes 2.0" : "Legacy",
				enabled: settings.enabled,
				executing,
				links: { ...links?.stats, pixel_bytes: links?.entry ? links.entry.bitmap.width * links.entry.bitmap.height * 4 : 0 },
				bitmap_count: bitmap_cache.entries.size,
				pixel_bytes: bitmap_cache.bytes,
				legacy: { ...legacy?.stats, bitmap_count: [...bitmap_cache.entries.values()].filter((entry) => !entry.owner).length,
					pixel_bytes: [...bitmap_cache.entries.values()].filter((entry) => !entry.owner).reduce((sum, entry) => sum + entry.bytes, 0), pending: legacy?.scheduler.pending.size ?? 0 },
				scheduling: { ...legacy?.scheduler.stats },
				vue: { managed_bodies: vue.bodies.size, skipped_bodies: vue.skipped.size, ...dom_cache.stats,
					capture_ready: dom_cache.can_capture(), queued_steps: dom_cache.scheduler.pending.size, scheduling: { ...dom_cache.scheduler.stats },
					visible_nodes: dom_cache.visible.size, pending_capture: Boolean(dom_cache.job),
					snapshots: [...bitmap_cache.entries.values()].filter((entry) => entry.owner === dom_cache).length,
					active_snapshots: document.querySelectorAll("[data-node-snapshot-image]").length }
			}),
			clearCache: () => clear()
		});
	},
	afterConfigureGraph: () => clear("workflow"),
	beforeConfigureGraph: () => clear("workflow")
});
