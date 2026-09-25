import { draw_camera } from "./marker.mjs";
import { CaptureScheduler } from "./scheduler.mjs";

const MIB = 1024 * 1024;
const PADDING = 24;
const ZOOM_SETTLE_MS = 180;
const SIGNATURE_INTERVAL_MS = 100;
const NAVIGATION_LOD_RELEASE_MS = 240;
// Raising this threshold keeps LiteGraph's low-quality path active, which skips
// node titles, widget text, badges, and shadows and hides zoom-sensitive DOM
// widgets. Captures clear the low-quality flag themselves, so stored images
// keep full detail.
const NAVIGATION_FONT_SIZE_LOD = 9999;
const CANVAS_STATE = [
	"font", "textAlign", "textBaseline", "direction", "fontKerning",
	"fontStretch", "fontVariantCaps", "letterSpacing", "wordSpacing",
	"lineWidth", "lineCap", "lineJoin", "miterLimit", "fillStyle", "strokeStyle"
];

export function node_signature(node, canvas)
{
	const widget_values = [];
	for (const widget of node.flags?.collapsed ? [] : node.widgets ?? [])
	{
		// DOM/media and object-valued widgets have separate rendering lifecycles.
		if (widget.element || widget.type === "dom" || widget.type === "custom"
			|| (widget.value !== null && typeof widget.value === "object")
			|| typeof widget.value === "function") return null;
		if (typeof widget.value === "string" && widget.value.length > 4096) return null;
		widget_values.push([widget.name, widget.type, widget.value, widget.label, widget.disabled, widget.hidden]);
	}
	return JSON.stringify([
		node.title, node.size?.[0], node.size?.[1],
		node.flags, node.properties, node.mode, node.color, node.bgcolor, node.boxcolor,
		node.shape, node.title_mode, node._collapsed_width, node.subgraph?._version,
		(node.inputs ?? []).map((slot) => [slot.name, slot.label, slot.type, slot.link]),
		(node.outputs ?? []).map((slot) => [slot.name, slot.label, slot.type, slot.links]),
		widget_values, canvas.editor_alpha,
		canvas.render_shadows, canvas.round_radius, canvas.inner_text_font, canvas.title_text_font,
		canvas.node_title_color
	]);
}

export class LegacyCache
{
	constructor(canvas, settings, is_executing, cache)
	{
		this.canvas = canvas;
		this.settings = settings;
		this.is_executing = is_executing;
		this.cache = cache;
		this.blocked = new WeakSet();
		this.attempted = new WeakMap();
		this.original_draw = canvas.draw;
		this.original_node = canvas.drawNode;
		this.graph = null;
		this.vue_mode = null;
		this.last_scale = canvas.ds.scale;
		this.zooming_until = 0;
		this.stats = { hits: 0, live: 0, captures: 0, failures: 0, slow_nodes: 0, max_capture_ms: 0, draw_ms: 0, draws: 0,
			content_invalidations: 0, reused_signatures: 0, clears: 0, last_clear_reason: null };
		this.scheduler = new CaptureScheduler(settings, () => this.can_capture());
		this.excluded = new Set();
		this.recent = new WeakMap();
		this.saved_lod = null;
		this.lod_timer = null;
		this.saved_shadows = true;
		this.shadows_applied = false;
		this.saved_round_radius = 8;
		this.corners_applied = false;
		this.configure();
		const owner = this;
		this.draw_wrapper = function (...args)
		{
			owner.begin_frame();
			const start = performance.now();
			try { return owner.original_draw.apply(this, args); }
			finally
			{
				owner.stats.draws++;
				owner.stats.draw_ms += performance.now() - start;
				owner.scheduler.schedule();
			}
		};
		this.node_wrapper = function (node, ctx, ...args)
		{
			return owner.draw_node(node, ctx, args);
		};
		canvas.draw = this.draw_wrapper;
		canvas.drawNode = this.node_wrapper;
	}

	configure(key)
	{
		if (key === "memory_mb") this.attempted = new WeakMap();
		this.cache.limit_bytes = this.settings.memory_mb * MIB;
		this.cache.reserve(0);
		this.excluded = new Set(this.settings.excluded_types.split(",").map((name) => name.trim()).filter(Boolean));
		if ((!this.settings.enabled || !this.settings.legacy_enabled)
			&& (key === undefined || key === "enabled" || key === "legacy_enabled")
			|| key === "pixel_ratio" || key === "max_dimension" || key === "mark_cached"
			|| key === "no_shadows" || key === "square_corners") this.clear("settings");
		if (key === "slow_capture_ms")
		{
			this.blocked = new WeakSet();
			this.attempted = new WeakMap();
		}
		this.apply_appearance();
		if (key === "excluded_types")
		{
			for (const node of this.cache.entries.keys())
			{
				if (this.excluded.has(node.type)) this.cache.delete(node);
			}
		}
	}

	begin_frame()
	{
		const graph = this.canvas.subgraph ?? this.canvas.graph;
		const vue_mode = Boolean(window.LiteGraph?.vueNodesMode);
		if (this.vue_mode !== null && this.vue_mode !== vue_mode) this.clear("renderer");
		if (this.graph !== graph)
		{
			this.scheduler.clear();
			this.graph = graph;
			this.graph_version = undefined;
		}
		this.vue_mode = vue_mode;
		if (this.last_scale !== this.canvas.ds.scale)
		{
			this.last_scale = this.canvas.ds.scale;
			this.zooming_until = performance.now() + ZOOM_SETTLE_MS;
			this.scheduler.input();
		}
		if (this.graph_version !== graph?._version)
		{
			this.graph_version = graph?._version;
			for (const node of this.cache.entries.keys())
			{
				if (!node.graph || node.graph.getNodeById(node.id) !== node) this.cache.delete(node);
			}
		}
		this.update_navigation_lod();
		this.apply_appearance();
	}

	is_enabled()
	{
		return this.settings.enabled && this.settings.legacy_enabled && !window.LiteGraph?.vueNodesMode;
	}

	can_capture()
	{
		return this.is_enabled() && !this.is_executing() && !document.hidden && !this.is_interacting()
			&& !this.canvas.pointer?.isDown;
	}

	queue_offscreen()
	{
		if (!this.settings.capture_offscreen || !this.can_capture() || this.scheduler.pending.size || !this.graph) return;
		const nodes = this.graph.nodes;
		for (let count = 0; count < nodes.length; count++)
		{
			this.offscreen_cursor = ((this.offscreen_cursor ?? -1) + 1) % nodes.length;
			const node = nodes[this.offscreen_cursor];
			if (this.canvas.isNodeVisible(node) || !this.is_cacheable(node) || this.needs_live(node)) continue;
			let signature;
			try { signature = node_signature(node, this.canvas); } catch { continue; }
			if (signature === null || this.cache.entries.get(node)?.signature === signature
				|| this.attempted.get(node)?.signature === signature) continue;
			const state = {};
			for (const key of CANVAS_STATE) state[key] = this.canvas.ctx[key];
			this.scheduler.add(node, () => this.capture(node, signature, state, []));
			return;
		}
	}

	is_interacting()
	{
		return Boolean(this.canvas.dragging_canvas || this.canvas.isDragging || this.canvas.resizing_node
			|| this.canvas.resizingGroup || performance.now() < this.zooming_until);
	}

	// Nodes that stay live during navigation pay for their own titles, widget
	// values, badges, and shadows on every frame. Holding LiteGraph in its
	// low-quality path for the gesture removes that work, including DOM widgets
	// that opted into hiding at low detail. Only the movement is affected: no
	// capture can start while a gesture is in progress, and capture() clears the
	// low-quality flag while it draws.
	update_navigation_lod()
	{
		if (!this.settings.simplify_navigation || !this.is_enabled() || !this.is_interacting())
		{
			this.release_navigation_lod();
			return;
		}
		if (this.saved_lod === null)
		{
			const current = this.canvas.min_font_size_for_lod;
			// Leave a threshold another extension or the user already raised.
			if (current === undefined || current >= NAVIGATION_FONT_SIZE_LOD) return;
			this.saved_lod = current;
			this.canvas.min_font_size_for_lod = NAVIGATION_FONT_SIZE_LOD;
		}
		clearTimeout(this.lod_timer);
		this.lod_timer = setTimeout(() =>
		{
			this.lod_timer = null;
			// An interaction can outlast several frames on a slow graph.
			if (this.is_interacting()) this.update_navigation_lod();
			else this.release_navigation_lod();
		}, NAVIGATION_LOD_RELEASE_MS);
	}

	release_navigation_lod()
	{
		clearTimeout(this.lod_timer);
		this.lod_timer = null;
		if (this.saved_lod === null) return;
		this.canvas.min_font_size_for_lod = this.saved_lod;
		this.saved_lod = null;
		this.canvas.setDirty(true, false);
	}

	// Shadows and corner rounding are canvas flags that KJNodes also sets, so
	// remember what we replaced and put back only a value we set ourselves. The
	// flags follow the classic renderer: Nodes 2.0 nodes are DOM, and the radius
	// also rounds group containers, so Nodes 2.0 uses VueOptimizer's styles.
	apply_appearance(release = false)
	{
		const active = !release && this.settings.enabled && !window.LiteGraph?.vueNodesMode;
		let changed = false;
		if (active && this.settings.no_shadows)
		{
			if (!this.shadows_applied)
			{
				this.saved_shadows = this.canvas.render_shadows;
				this.shadows_applied = true;
			}
			if (this.canvas.render_shadows !== false)
			{
				this.canvas.render_shadows = false;
				changed = true;
			}
		}
		else if (this.shadows_applied)
		{
			if (this.canvas.render_shadows === false) this.canvas.render_shadows = this.saved_shadows;
			this.shadows_applied = false;
			changed = true;
		}
		if (active && this.settings.square_corners)
		{
			if (!this.corners_applied)
			{
				this.saved_round_radius = LiteGraph.ROUND_RADIUS;
				this.corners_applied = true;
			}
			if (LiteGraph.ROUND_RADIUS !== 0)
			{
				LiteGraph.ROUND_RADIUS = 0;
				changed = true;
			}
		}
		else if (this.corners_applied)
		{
			if (LiteGraph.ROUND_RADIUS === 0) LiteGraph.ROUND_RADIUS = this.saved_round_radius;
			this.corners_applied = false;
			changed = true;
		}
		if (changed) this.canvas.setDirty(true, true);
	}

	needs_live(node)
	{
		return Boolean(node.selected || this.canvas.selectedItems?.has(node) || this.canvas.node_over === node
			|| node.mouseOver || this.canvas.resizing_node === node || node.has_errors || node.execute_triggered
			|| node.action_triggered || typeof node.progress === "number"
			|| this.canvas.linkConnector?.renderLinks?.length);
	}

	is_cacheable(node)
	{
		return !(this.settings.exclude_pinned && node.pinned) && !this.blocked.has(node) && !this.excluded.has(node.type)
			&& node.graph === this.graph && (node.flags?.collapsed || (!node.imgs?.length && !node.images?.length
				&& !node.animatedImages && !node.properties?.previewExposures?.length));
	}

	// Every visible node is measured on every frame, and the measurement
	// serializes titles, properties, slots, and widget values. Reuse each node's
	// last measurement briefly while the viewport is moving. Idle frames, graph
	// revisions, and the end of an interaction always take a fresh measurement.
	measured_signature(node)
	{
		const graph = this.canvas.subgraph ?? this.canvas.graph;
		const now = performance.now();
		const recent = this.recent.get(node);
		if (recent && this.is_interacting() && recent.graph === graph
			&& recent.version === graph?._version && now - recent.time < SIGNATURE_INTERVAL_MS)
		{
			this.stats.reused_signatures++;
			return recent.signature;
		}
		let signature;
		try { signature = node_signature(node, this.canvas); }
		catch { signature = null; }
		this.recent.set(node, { graph, version: graph?._version, time: now, signature });
		return signature;
	}

	draw_node(node, ctx, args)
	{
		if (!this.is_enabled()) return this.draw_live(node, ctx, args);
		if (!this.is_cacheable(node))
		{
			this.cache.delete(node);
			this.scheduler.pending.delete(node);
			return this.draw_live(node, ctx, args);
		}
		const signature = this.measured_signature(node);
		if (signature === null)
		{
			this.cache.delete(node);
			this.scheduler.pending.delete(node);
			return this.draw_live(node, ctx, args);
		}
		const entry = this.cache.get(node);
		const valid = entry && entry.signature === signature;
		if (entry && !valid)
		{
			this.cache.delete(node);
			this.attempted.delete(node);
			this.stats.content_invalidations++;
		}
		if (this.needs_live(node))
		{
			this.scheduler.pending.delete(node);
			return this.draw_live(node, ctx, args);
		}
		const refresh = !valid || (this.settings.max_age_ms > 0
			&& performance.now() - entry.created >= this.settings.max_age_ms);
		let result;
		if (valid && (this.settings.cache_while_idle || this.is_interacting()))
		{
			this.canvas.current_node = node;
			ctx.save();
			ctx.globalAlpha = 1;
			ctx.shadowColor = "transparent";
			ctx.drawImage(entry.bitmap, entry.x, entry.y, entry.width, entry.height);
			ctx.restore();
			this.stats.hits++;
		}
		else result = this.draw_live(node, ctx, args);
		const attempted = this.attempted.get(node);
		if (refresh
			&& (attempted?.signature !== signature || attempted?.input !== this.scheduler.last_input
				|| (valid && attempted?.created !== entry.created)))
		{
			const state = {};
			for (const key of CANVAS_STATE) state[key] = ctx[key];
			// Recompute after native rendering has arranged slots and widgets.
			let arranged;
			try { arranged = node_signature(node, this.canvas); }
			catch { return result; }
			if (arranged !== null)
			{
				this.scheduler.add(node, () => this.capture(node, arranged, state, args));
			}
		}
		return result;
	}

	draw_live(node, ctx, args)
	{
		this.stats.live++;
		return this.original_node.call(this.canvas, node, ctx, ...args);
	}

	capture(node, signature, state, args)
	{
		if (!this.can_capture() || !this.is_cacheable(node) || this.needs_live(node) || (!this.settings.capture_offscreen && !this.canvas.isNodeVisible(node))) return;
		this.attempted.set(node, { signature, input: this.scheduler.last_input,
			created: this.cache.entries.get(node)?.created });
		let bitmap;
		const previous_node = this.canvas.current_node;
		const previous_scale = this.canvas.ds.scale;
		const previous_quality = this.canvas._isLowQuality;
		const start = performance.now();
		try
		{
			if (node_signature(node, this.canvas) !== signature) return;
			const bounds = node.boundingRect;
			if (!bounds || !bounds[2] || !bounds[3]) return;
			const x = bounds[0] - node.pos[0] - PADDING;
			const y = bounds[1] - node.pos[1] - PADDING;
			const width = bounds[2] + PADDING * 2;
			const height = bounds[3] + PADDING * 2;
			const ratio = this.settings.pixel_ratio;
			const pixel_width = Math.ceil(width * ratio);
			const pixel_height = Math.ceil(height * ratio);
			const bytes = pixel_width * pixel_height * 4;
			if (!Number.isFinite(bytes) || pixel_width <= 0 || pixel_height <= 0
				|| Math.max(pixel_width, pixel_height) > this.settings.max_dimension
				|| (!this.canvas.isNodeVisible(node) && this.cache.bytes + bytes > this.cache.limit_bytes)
				|| !this.cache.reserve(bytes, node)) return;
			bitmap = document.createElement("canvas");
			bitmap.width = pixel_width;
			bitmap.height = pixel_height;
			const ctx = bitmap.getContext("2d");
			for (const key of CANVAS_STATE)
			{
				if (state[key] !== undefined) ctx[key] = state[key];
			}
			ctx.setTransform(ratio, 0, 0, ratio, -x * ratio, -y * ratio);
			// Capture full detail in graph coordinates, independent of viewport zoom.
			this.canvas.ds.scale = 1;
			this.canvas._isLowQuality = false;
			this.original_node.call(this.canvas, node, ctx, ...args);
			if (this.settings.mark_cached)
			{
				ctx.save();
				ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
				draw_camera(ctx, LiteGraph.NODE_TITLE_HEIGHT / 2 - 10 - x, -LiteGraph.NODE_TITLE_HEIGHT / 2 - 10 - y);
				ctx.restore();
			}
			const elapsed = performance.now() - start;
			this.stats.max_capture_ms = Math.max(this.stats.max_capture_ms, elapsed);
			if (elapsed > this.settings.slow_capture_ms)
			{
				this.blocked.add(node);
				this.stats.slow_nodes++;
				return;
			}
			if (node_signature(node, this.canvas) !== signature) return;
			this.cache.set(node, { bitmap, bytes, x, y, width: pixel_width / ratio,
				height: pixel_height / ratio, signature, created: performance.now() });
			bitmap = null;
			this.stats.captures++;
			if (this.settings.cache_while_idle) this.canvas.setDirty(true, false);
		}
		catch
		{
			this.blocked.add(node);
			this.stats.failures++;
			if (this.settings.diagnostics) console.warn("[NodeSnapshots] A node capture failed; keeping it live.");
		}
		finally
		{
			this.canvas.current_node = previous_node;
			this.canvas.ds.scale = previous_scale;
			this.canvas._isLowQuality = previous_quality;
			if (bitmap) { bitmap.width = 0; bitmap.height = 0; }
			this.queue_offscreen();
		}
	}

	// Nodes that report output draw it while live, so their stored image has to go.
	invalidate_node(id)
	{
		const graph = this.canvas.subgraph ?? this.canvas.graph;
		const node = graph?.getNodeById(id) ?? graph?.getNodeById(Number(id));
		if (!node) return;
		this.cache.delete(node);
		this.scheduler.pending.delete(node);
		this.attempted.delete(node);
	}

	clear(reason = "manual")
	{
		this.stats.clears++;
		this.stats.last_clear_reason = reason;
		this.scheduler.clear();
		this.cache.clear();
		this.attempted = new WeakMap();
		this.recent = new WeakMap();
	}

	dispose()
	{
		this.release_navigation_lod();
		this.apply_appearance(true);
		this.clear();
		if (this.canvas.draw === this.draw_wrapper) this.canvas.draw = this.original_draw;
		if (this.canvas.drawNode === this.node_wrapper) this.canvas.drawNode = this.original_node;
	}
}
