import { CaptureScheduler } from "./scheduler.mjs";

const MAX_DIMENSION = 4096;
const PAN_VALIDATION_MS = 100;
const STYLE_KEYS = ["links_render_mode", "connections_width", "render_connections_border", "render_connections_shadows",
	"low_quality", "highquality_render", "linkMarkerShape", "render_connection_arrows", "default_link_color", "editor_alpha"];

export class LinkCache
{
	constructor(canvas, settings, is_executing)
	{
		this.canvas = canvas;
		this.settings = settings;
		this.is_executing = is_executing;
		this.entry = null;
		this.signature_values = [];
		this.revision = 0;
		this.stats = { captures: 0, hits: 0, live: 0, failures: 0, slow_captures: 0, max_capture_ms: 0, geometry_checks: 0, pan_validation_hits: 0, layer_hits: 0 };
		this.original = canvas.drawConnections;
		this.scheduler = new CaptureScheduler(settings, () => this.safe() && !this.is_executing()
			&& !canvas.pointer?.isDown && !canvas.dragging_canvas);
		const owner = this;
		this.wrapper = function(ctx, ...args) { return owner.draw(ctx, args); };
		canvas.drawConnections = this.wrapper;
		this.original_front = canvas.drawFrontCanvas;
		this.front_wrapper = function(...args)
		{
			if (owner.layer && (!owner.safe() || !owner.show_snapshots()))
			{
				if (!owner.safe()) owner.clear();
				else owner.hide_layer();
				this.drawBackCanvas(false, ...args);
			}
			const ctx = this.ctx;
			const draw_image = ctx.drawImage;
			// Keep the native foreground pass, but let the compositor display its
			// background underneath the link layer instead of copying it over links.
			if (owner.layer) ctx.drawImage = function(source, ...coordinates)
			{
				if (source !== owner.canvas.bgcanvas) return draw_image.call(this, source, ...coordinates);
			};
			try { return owner.original_front.apply(this, args); }
			finally { ctx.drawImage = draw_image; }
		};
		canvas.drawFrontCanvas = this.front_wrapper;
	}

	show_snapshots()
	{
		return this.settings.links_cache_while_idle || this.canvas.dragging_canvas || this.zooming;
	}

	safe()
	{
		const canvas = this.canvas;
		const graph = canvas.graph;
		if (!(this.settings.enabled && this.settings.links_enabled && !document.hidden
			&& canvas.links_render_mode !== (LiteGraph.HIDDEN_LINK ?? -1)
			&& graph?.links.size > 0 && !canvas.subgraph && !graph.reroutes.size && !graph.floatingLinks.size
			&& !canvas.isDragging && !canvas.resizing_node && !canvas.resizingGroup
			&& !canvas.linkConnector?.renderLinks?.length && !canvas.over_link_center)) return false;
		for (const key in canvas.highlighted_links) return false;
		const now = LiteGraph.getTime();
		for (const link of graph.links.values())
			if (link._last_time && now - link._last_time < 1000) return false;
		return true;
	}

	track(value)
	{
		if (!Object.is(this.signature_values[this.cursor], value))
		{
			this.signature_values[this.cursor] = value;
			this.changed = true;
		}
		this.cursor++;
	}

	validation_signature()
	{
		const canvas = this.canvas;
		const graph = canvas.graph;
		const now = performance.now();
		const fast = [graph, graph._version, graph.nodes.length, graph.links.size, Boolean(LiteGraph.vueNodesMode),
			...STYLE_KEYS.map((key) => canvas[key])];
		if (canvas.dragging_canvas && this.validation_panning && now - this.validation_time < PAN_VALIDATION_MS
			&& this.validation_fast?.every((value, index) => Object.is(value, fast[index])))
		{
			this.stats.pan_validation_hits++;
			return this.revision;
		}
		this.validation_fast = fast;
		this.validation_time = now;
		this.validation_panning = Boolean(canvas.dragging_canvas);
		this.stats.geometry_checks++;
		return this.signature();
	}

	signature()
	{
		const canvas = this.canvas;
		const graph = canvas.graph;
		const nodes = graph.nodes;
		const colors_by_type = canvas.constructor.link_type_colors;
		this.cursor = 0;
		this.changed = false;
		this.track(graph);
		this.track(graph._version);
		this.track(Boolean(LiteGraph.vueNodesMode));
		for (const key of STYLE_KEYS) this.track(canvas[key]);
		let colors = 0;
		for (const key in colors_by_type)
		{
			this.track(key); this.track(colors_by_type[key]); colors++;
		}
		this.track(colors);
		// Extensions can mutate coordinates and slot arrays without emitting a graph
		// event. Compare their scalar values in reusable storage, without serializing
		// the graph or retaining mutable arrays as the previous geometry.
		this.track(nodes.length);
		for (const node of nodes)
		{
			const pos = node.pos, size = node.size, inputs = node.inputs, outputs = node.outputs;
			this.track(node); this.track(node.id);
			this.track(pos[0]); this.track(pos[1]);
			this.track(size[0]); this.track(size[1]);
			this.track(node.flags.collapsed); this.track(node.mode);
			this.track(inputs?.length);
			if (inputs) for (const slot of inputs) this.track_slot(slot, true);
			this.track(outputs?.length);
			if (outputs) for (const slot of outputs) this.track_slot(slot, false);
		}
		this.track(graph.links.size);
		for (const link of graph.links.values())
		{
			this.track(link.id); this.track(link.origin_id); this.track(link.origin_slot);
			this.track(link.target_id); this.track(link.target_slot); this.track(link.color); this.track(link.type);
		}
		if (this.cursor !== this.signature_values.length) this.changed = true;
		this.signature_values.length = this.cursor;
		if (this.changed) this.revision++;
		return this.revision;
	}

	track_slot(slot, input)
	{
		const pos = slot.pos;
		if (input) this.track(slot.link);
		this.track(pos?.length);
		if (pos) for (const coordinate of pos) this.track(coordinate);
		this.track(slot.dir);
	}

	draw(ctx, args)
	{
		if (!this.safe())
		{
			this.clear();
			this.signature_values.length = 0;
			this.stats.live++;
			return this.original.call(this.canvas, ctx, ...args);
		}
		const transform = ctx.getTransform();
		const view = this.canvas.visible_area;
		const entry = this.entry;
		if (entry && entry.graph === this.canvas.graph
			&& view[0] >= entry.x && view[1] >= entry.y
			&& view[0] + view[2] <= entry.x + entry.width && view[1] + view[3] <= entry.y + entry.height
			&& entry.signature === this.validation_signature())
		{
			if (!this.show_snapshots())
			{
				this.hide_layer();
				this.stats.live++;
				return this.original.call(this.canvas, ctx, ...args);
			}
			if (this.show_layer(ctx, transform, entry))
			{
				this.stats.hits++;
				this.stats.layer_hits++;
				return;
			}
			ctx.save();
			ctx.globalAlpha = 1;
			ctx.shadowColor = "transparent";
			ctx.shadowBlur = 0;
			ctx.drawImage(entry.bitmap, entry.x, entry.y, entry.width, entry.height);
			ctx.restore();
			this.stats.hits++;
			return;
		}
		this.stats.live++;
		this.clear();
		this.original.call(this.canvas, ctx, ...args);
		// An uncovered pan already uses native links. Do not scan graph geometry
		// or queue captures that cannot run until the gesture ends.
		if (this.canvas.dragging_canvas || this.canvas.pointer?.isDown) return;
		// Capture only when idle. Until then native drawing also maintains link hit paths.
		const arranged_signature = this.signature();
		if (this.blocked_signature === arranged_signature) return;
		this.scheduler.add(this.canvas, () => this.capture(args, arranged_signature, transform));
	}

	show_layer(ctx, transform, entry)
	{
		const canvas = this.canvas;
		const front = canvas.canvas;
		// Export contexts and unusual layer orders retain ordinary bitmap drawing.
		if (ctx !== canvas.bgctx) return false;
		if (canvas.graph.config?.links_ontop || canvas.viewport
			|| !canvas.clear_background || canvas.bgcanvas === front || !front.parentElement
			|| !front.clientWidth || !front.clientHeight) { this.hide_layer(); return false; }
		if (!this.layer)
		{
			const style = getComputedStyle(front);
			if (style.position === "static" || style.transform !== "none" || canvas.bgcanvas.isConnected
				|| !canvas.ctx.getContextAttributes().alpha) return false;
			this.front_background = front.style.background;
			front.style.background = "transparent";
			this.background_style = canvas.bgcanvas.getAttribute("style");
			const layer = document.createElement("div");
			layer.dataset.nodeSnapshotsLinks = "";
			layer.style.cssText = `position:absolute;pointer-events:none;overflow:hidden;z-index:${style.zIndex};`;
			canvas.bgcanvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none";
			entry.bitmap.style.cssText = "position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform;pointer-events:none";
			layer.append(canvas.bgcanvas, entry.bitmap);
			front.before(layer);
			this.layer = layer;
		}
		const sx = front.clientWidth / front.width, sy = front.clientHeight / front.height;
		Object.assign(this.layer.style, { left: `${front.offsetLeft}px`, top: `${front.offsetTop}px`,
			width: `${front.clientWidth}px`, height: `${front.clientHeight}px` });
		entry.bitmap.style.transform = `matrix(${transform.a * entry.width / entry.bitmap.width * sx},0,0,${transform.d * entry.height / entry.bitmap.height * sy},${(transform.a * entry.x + transform.e) * sx},${(transform.d * entry.y + transform.f) * sy})`;
		return true;
	}

	hide_layer()
	{
		if (!this.layer) return;
		this.canvas.bgcanvas.remove();
		if (this.background_style === null) this.canvas.bgcanvas.removeAttribute("style");
		else this.canvas.bgcanvas.setAttribute("style", this.background_style);
		this.canvas.canvas.style.background = this.front_background;
		this.layer.remove();
		this.layer = null;
		this.canvas.setDirty(true, true);
	}

	capture(args, signature, transform)
	{
		if (!this.safe() || this.is_executing()) return;
		if (signature !== this.signature()) { this.canvas.setDirty(true, true); return; }
		// The context is normally restored by the time idle work runs. Use the
		// graph transform saved at the actual connection draw, not its current CTM.
		const area = [...this.canvas.visible_area];
		const canvas_width = this.canvas.canvas.clientWidth;
		if (!canvas_width) return;
		const margin = this.settings.links_overscan_px * this.canvas.canvas.width / canvas_width;
		const x = margin ? (-transform.e - margin) / transform.a : area[0];
		const y = margin ? (-transform.f - margin) / transform.d : area[1];
		const width = area[2] + 2 * margin / transform.a;
		const height = area[3] + 2 * margin / transform.d;
		const limit = this.settings.links_memory_mb * 1024 * 1024;
		let ratio = Math.min(transform.a, MAX_DIMENSION / width, MAX_DIMENSION / height, Math.sqrt(limit / 8 / (width * height)));
		const bitmap = document.createElement("canvas");
		bitmap.width = Math.max(1, Math.floor(width * ratio));
		bitmap.height = Math.max(1, Math.floor(height * ratio));
		const ctx = bitmap.getContext("2d");
		// With no margin, rounding down pixel dimensions must not shrink viewport coverage.
		if (!margin) ratio = Math.min(bitmap.width / width, bitmap.height / height);
		ctx.setTransform(ratio, 0, 0, ratio, -x * ratio, -y * ratio);
		ctx.shadowColor = this.canvas.render_connections_shadows ? "black" : "transparent";
		ctx.shadowBlur = this.canvas.render_connections_shadows ? 6 : 0;
		const start = performance.now();
		try
		{
			this.canvas.visible_area.set([x, y, width, height]);
			this.original.call(this.canvas, ctx, ...args);
			if (performance.now() - start > this.settings.slow_capture_ms)
			{
				this.blocked_signature = signature;
				this.stats.slow_captures++;
				bitmap.width = 0; bitmap.height = 0;
				return;
			}
			this.clear();
			this.entry = { bitmap, graph: this.canvas.graph, signature, x, y, width: bitmap.width / ratio, height: bitmap.height / ratio };
			this.stats.captures++;
			this.canvas.setDirty(true, true);
		}
		catch
		{
			bitmap.width = 0; bitmap.height = 0;
			this.blocked_signature = signature;
			this.stats.failures++;
		}
		finally
		{
			this.canvas.visible_area.set(area);
			this.stats.max_capture_ms = Math.max(this.stats.max_capture_ms, performance.now() - start);
		}
	}

	input(event)
	{
		this.scheduler.input();
		if (event.type === "wheel" && (event.target === this.canvas.canvas
			|| event.target?.closest?.("[data-testid='transform-pane']")))
		{
			this.zooming = true;
			clearTimeout(this.zoom_timer);
			this.zoom_timer = setTimeout(() =>
			{
				this.zooming = false;
				this.canvas.setDirty(true, true);
			}, 180);
		}
		if (event.type === "pointerup" || event.type === "pointercancel") this.canvas.setDirty(true, true);
		if (event.type !== "pointermove") this.validation_panning = false;
		if (event.type === "pointerup" || event.type === "keydown") this.blocked_signature = null;
		if (["keydown", "input", "change"].includes(event.type)) this.clear();
	}

	clear()
	{
		this.hide_layer();
		this.validation_panning = false;
		this.scheduler.clear();
		if (this.entry) { this.entry.bitmap.width = 0; this.entry.bitmap.height = 0; }
		this.entry = null;
	}

	dispose()
	{
		clearTimeout(this.zoom_timer);
		this.clear();
		this.signature_values.length = 0;
		if (this.canvas.drawFrontCanvas === this.front_wrapper) this.canvas.drawFrontCanvas = this.original_front;
		if (this.canvas.drawConnections === this.wrapper) this.canvas.drawConnections = this.original;
	}
}
