import { draw_camera } from "./marker.mjs";
import { CaptureScheduler } from "./scheduler.mjs";
import { DomRasterizer } from "./dom-raster.mjs";

const NODE_SELECTOR = ".lg-node[data-node-id]";

// Only used at capture/remount, never on each navigation frame. Live form values
// are properties, so markup alone cannot validate a retained DOM image.
function source_signature(source)
{
	const walker = document.createTreeWalker(source, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
	const indices = new Map();
	const parts = [];
	do
	{
		const node = walker.currentNode;
		indices.set(node, parts.length);
		if (!(node instanceof Element)) { parts.push([indices.get(node.parentNode), node.textContent]); continue; }
		const attributes = [...node.attributes].filter((attribute) => !attribute.name.startsWith("data-node-snapshot") && attribute.name !== "style")
			.map((attribute) => [attribute.name, attribute.value]).sort(([left], [right]) => left.localeCompare(right));
		const style = [...node.style].filter((name) => !name.startsWith("--node-snapshot-"))
			.sort().map((name) => [name, node.style.getPropertyValue(name), node.style.getPropertyPriority(name)]);
		parts.push([indices.get(node.parentNode), node.tagName, attributes, style, node.value, node.checked, node.selectedIndex]);
	}
	while (walker.nextNode());
	return JSON.stringify(parts);
}

const STYLE_TEXT = `
[data-node-snapshot-capturing] [data-node-snapshot-body] { content-visibility: visible !important; }
[data-node-snapshot-raster] { display: none; position: absolute; pointer-events: none; z-index: 1; }
[data-node-snapshot-image] > [data-testid="node-inner-wrapper"] { visibility: hidden !important; }
[data-node-snapshot-image] > [data-node-snapshot-raster] { display: block; }
.lg-node:hover > [data-testid="node-inner-wrapper"],
.lg-node:focus-within > [data-testid="node-inner-wrapper"],
.lg-node:has([data-testid="node-state-outline-overlay"]) > [data-testid="node-inner-wrapper"] { visibility: visible !important; }
.lg-node:hover > [data-node-snapshot-raster],
.lg-node:focus-within > [data-node-snapshot-raster],
.lg-node:has([data-testid="node-state-outline-overlay"]) > [data-node-snapshot-raster] { display: none; }
`;

export class DomSnapshotCache
{
	constructor(settings, cache, get_canvas, is_executing)
	{
		this.settings = settings;
		this.cache = cache;
		this.get_canvas = get_canvas;
		this.is_executing = is_executing;
		this.records = new Map();
		this.visible = new Set();
		this.job = null;
		this.pane = null;
		this.navigation_until = 0;
		this.update_frame = null;
		this.stats = { captures: 0, restored: 0, failures: 0, unsupported: 0, max_step_ms: 0, prepare_ms: 0, decode_ms: 0, last_failure: null, invalidations: 0, last_invalidation: null };
		this.rasterizer = new DomRasterizer();
		this.scheduler = new CaptureScheduler(settings, () => this.can_capture());
		this.style = document.createElement("style");
		this.style.textContent = STYLE_TEXT;
		this.intersection = new IntersectionObserver((entries) =>
		{
			for (const entry of entries)
			{
				const record = this.records.get(entry.target);
				if (!record) continue;
				if (entry.isIntersecting)
				{
					if (!this.visible.has(record) && record.captured) record.attempted = -1;
					// Reattach retained images before spending time rasterizing new nodes.
					if (!this.visible.has(record) && this.cache.entries.has(record.node))
						this.visible = new Set([record, ...this.visible]);
					else this.visible.add(record);
				}
				else { this.visible.delete(record); this.show_image(record, false); }
			}
			this.request_update();
		});
		this.resize = new ResizeObserver((entries) =>
		{
			for (const entry of entries)
			{
				const record = this.records.get(entry.target.parentElement);
				if (!record) continue;
				if (!record.root.isConnected || record.node.graph !== (this.get_canvas()?.subgraph ?? this.get_canvas()?.graph))
				{
					this.release(record); continue;
				}
				const size = entry.borderBoxSize[0];
				if (!size.inlineSize || !size.blockSize) continue;
				if (record.width !== size.inlineSize || record.height !== size.blockSize)
				{
					record.width = size.inlineSize;
					record.height = size.blockSize;
					this.invalidate(record, "resize");
				}
			}
			this.request_update();
		});
		this.observer = new MutationObserver((mutations) =>
		{
			for (const mutation of mutations)
			{
				const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
				if (mutation.type === "attributes" && mutation.oldValue === target?.getAttribute(mutation.attributeName)) continue;
				if (target?.closest("[data-node-snapshot-raster]")) continue;
				const root = target?.closest(NODE_SELECTOR);
				const record = this.records.get(root);
				if (record)
				{
					if (!root.isConnected || record.node.graph !== (this.get_canvas()?.subgraph ?? this.get_canvas()?.graph))
					{
						this.release(record); continue;
					}
					if (mutation.type === "childList" && target === root)
					{
						if ([...mutation.removedNodes].includes(record.source))
						{
							this.release(record); this.collect(root);
						}
						// Selection outlines and footers are outside the captured subtree.
						continue;
					}
					if (target !== root && !record.source.contains(target)) continue;
					if (mutation.type === "attributes" && target === root
						&& mutation.attributeName !== "data-collapsed") continue;
					if (mutation.type === "attributes" && mutation.attributeName.startsWith("data-node-snapshot")) continue;
					if (mutation.type === "attributes" && mutation.attributeName === "style"
						&& target.hasAttribute("data-node-snapshot-body")
						&& (mutation.oldValue ?? "").replace(/--node-snapshot-(width|height):[^;]*;?/g, "").trim()
							=== (target.getAttribute("style") ?? "").replace(/--node-snapshot-(width|height):[^;]*;?/g, "").trim()) continue;
					if (mutation.type !== "childList" || [...mutation.addedNodes, ...mutation.removedNodes]
						.some((node) => !(node instanceof Element && node.hasAttribute("data-node-snapshot-raster"))))
						this.invalidate(record, `${target?.tagName}:${mutation.attributeName ?? mutation.type}`);
				}
				for (const node of mutation.addedNodes)
				{
					if (node instanceof Element && !node.hasAttribute("data-node-snapshot-raster")) this.collect(node);
				}
			}
			this.request_update();
		});
	}

	sync()
	{
		this.excluded = new Set(this.settings.excluded_types.split(",").map((name) => name.trim()).filter(Boolean));
		const pane = this.settings.enabled && this.settings.vue_cache_enabled && window.LiteGraph?.vueNodesMode
			? document.querySelector("[data-testid='transform-pane']") : null;
		if (pane !== this.pane)
		{
			this.detach(this.settings.enabled && this.settings.vue_cache_enabled && window.LiteGraph?.vueNodesMode);
			if (!pane) return;
			this.pane = pane;
			document.head.append(this.style);
			this.collect(pane);
			this.observer.observe(pane, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true });
		}
		for (const [root, record] of this.records)
		{
			if (!root.isConnected) this.release(record);
			else if ((this.excluded.has(record.node.type) || (this.settings.exclude_pinned && record.node.pinned))) this.invalidate(record);
		}
		this.update();
	}

	configure(key)
	{
		if (["enabled", "vue_cache_enabled"].includes(key)) this.detach();
		else if (["pixel_ratio", "max_dimension", "mark_cached", "slow_capture_ms"].includes(key)) this.clear();
		else if (["memory_mb", "excluded_types", "exclude_pinned", "capture_offscreen"].includes(key))
		{
			for (const record of this.records.values()) record.attempted = -1;
		}
	}

	collect(root)
	{
		const roots = root.matches(NODE_SELECTOR) ? [root] : root.querySelectorAll(NODE_SELECTOR);
		const graph = this.get_canvas()?.subgraph ?? this.get_canvas()?.graph;
		for (const element of roots)
		{
			if (this.records.has(element)) continue;
			const source = element.querySelector(":scope > [data-testid='node-inner-wrapper']");
			const id = element.dataset.nodeId;
			const node = graph?.getNodeById(id) ?? graph?.getNodeById(Number(id));
			if (!node || !source) continue;
			const record = { root: element, source, node, revision: 0, attempted: -1, width: 0, height: 0, image_shown: false };
			this.records.set(element, record);
			this.intersection.observe(element);
			this.resize.observe(source);
		}
	}

	needs_live(record)
	{
		return record.node.selected || this.get_canvas()?.selectedItems?.has(record.node)
			|| record.root.matches(":hover, :focus-within")
			|| record.root.querySelector("[data-testid='node-state-outline-overlay']");
	}

	// The attribute drives the raster and visibility styles, so rewriting it every
	// frame creates mutation records and style work for an unchanged value.
	show_image(record, shown)
	{
		if (record.image_shown === shown) return;
		record.image_shown = shown;
		record.root.toggleAttribute("data-node-snapshot-image", shown);
	}

	is_interacting()
	{
		const canvas = this.get_canvas();
		return canvas?.dragging_canvas || canvas?.isDragging || canvas?.resizing_node
			|| canvas?.resizingGroup || performance.now() < this.navigation_until;
	}

	can_capture()
	{
		return Boolean(this.pane && this.settings.enabled && this.settings.vue_cache_enabled
			&& window.LiteGraph?.vueNodesMode && !this.is_executing() && !document.hidden
			&& !this.is_interacting() && !this.get_canvas()?.pointer?.isDown);
	}

	input(event)
	{
		this.scheduler.input();
		if (event.type === "wheel" && (event.target === this.get_canvas()?.canvas || this.pane?.contains(event.target)))
			this.navigation_until = performance.now() + 180;
		const root = event.target.closest?.(NODE_SELECTOR);
		const record = this.records.get(root);
		if (record && ["input", "change"].includes(event.type)) this.invalidate(record);
		this.request_update();
	}

	request_update()
	{
		if (this.update_frame !== null) return;
		this.update_frame = requestAnimationFrame(() => { this.update_frame = null; this.update(); });
	}

	update()
	{
		if (!this.pane) return;
		const reuse = this.settings.cache_while_idle || this.is_interacting();
		const candidates = this.settings.capture_offscreen && !this.job && this.can_capture()
			? new Set([...this.visible, ...this.records.values()]) : this.visible;
		for (const record of candidates)
		{
			if (this.excluded?.has(record.node.type) || (this.settings.exclude_pinned && record.node.pinned))
			{
				this.show_image(record, false);
				continue;
			}
			const entry = this.cache.entries.get(record.node);
			if (!record.root.isConnected) continue;
			const valid = entry?.owner === this && entry.record === record && entry.revision === record.revision;
			const onscreen = this.visible.has(record);
			this.show_image(record, Boolean(onscreen && valid && reuse && this.job?.record !== record && !this.needs_live(record)));
			if (onscreen && valid && reuse) this.cache.get(record.node);
			const stale = valid && this.settings.max_age_ms > 0 && performance.now() - entry.created >= this.settings.max_age_ms;
			if (!this.job && (!valid || stale) && !this.needs_live(record)
				&& record.width > 0 && record.height > 0
				&& (record.attempted !== record.revision || (stale && record.attempted_created !== entry.created)))
			{
				record.attempted = record.revision;
				record.attempted_created = entry?.created;
				const job = { record, revision: record.revision, iterator: null };
				this.job = job;
				record.root.setAttribute("data-node-snapshot-capturing", "");
				this.scheduler.add(record.node, () => this.step(job));
			}
		}
		this.scheduler.schedule();
	}

	valid_job(job)
	{
		return this.job === job && job.record.revision === job.revision && job.record.root.isConnected
			&& (this.visible.has(job.record) || this.settings.capture_offscreen) && !(this.settings.exclude_pinned && job.record.node.pinned) && !this.needs_live(job.record) && this.can_capture();
	}

	step(job)
	{
		if (!job || !this.valid_job(job)) { this.finish(job, true); return; }
		const start = performance.now();
		try
		{
			const { record } = job;
			if (!job.iterator)
			{
				this.show_image(record, false);
				job.signature = source_signature(record.source);
				const retained = this.cache.entries.get(record.node);
				if (retained?.owner === this && retained.record !== record
					&& retained.signature === job.signature && retained.width === record.width && retained.height === record.height)
				{
					retained.record = record;
					retained.revision = record.revision;
					record.captured = true;
					record.root.append(retained.bitmap);
					this.stats.restored++;
					this.finish(job); return;
				}
				const width = Math.ceil(record.width * this.settings.pixel_ratio);
				const height = Math.ceil(record.height * this.settings.pixel_ratio);
				if (Math.max(width, height) > this.settings.max_dimension || width * height * 4 > this.cache.limit_bytes
					|| (!this.visible.has(record) && this.cache.bytes + width * height * 4 > this.cache.limit_bytes))
				{
					this.finish(job); return;
				}
				job.iterator = this.rasterizer.prepare(record.source, record.width, record.height);
			}
			const next = job.iterator.next();
			const elapsed = performance.now() - start;
			this.stats.prepare_ms += elapsed;
			this.stats.max_step_ms = Math.max(this.stats.max_step_ms, elapsed);
			if (elapsed > this.settings.slow_capture_ms) throw new Error("slow_step");
			if (next.done)
			{
				const decoding_started = performance.now();
				this.rasterizer.decode(next.value, record.width, record.height)
					.then((image) =>
					{
						this.stats.decode_ms += performance.now() - decoding_started;
						if (this.job === job) this.scheduler.add(record.node, () => this.publish(job, image));
					})
					.catch((error) => this.failed(job, error));
			}
			else this.scheduler.add(record.node, () => this.step(job));
		}
		catch (error) { this.failed(job, error); }
	}

	publish(job, image)
	{
		if (!this.valid_job(job)) { this.finish(job, true); return; }
		const { record } = job;
		const ratio = this.settings.pixel_ratio;
		const width = Math.ceil(record.width * ratio);
		const height = Math.ceil(record.height * ratio);
		const bytes = width * height * 4;
		if (!this.visible.has(record) && this.cache.bytes + bytes > this.cache.limit_bytes) { this.finish(job); return; }
		if (!this.cache.reserve(bytes, record.node)) { this.finish(job); return; }
		const bitmap = document.createElement("canvas");
		bitmap.width = width;
		bitmap.height = height;
		try
		{
			const ctx = bitmap.getContext("2d");
			ctx.drawImage(image, 0, 0, width, height);
			if (this.settings.mark_cached)
			{
				ctx.scale(ratio, ratio);
				const icon = record.source.querySelector("[data-testid='node-collapse-button'] i");
				const source_bounds = record.source.getBoundingClientRect();
				const icon_bounds = icon?.getBoundingClientRect();
				const scale = record.width / source_bounds.width;
				const size = icon_bounds ? Math.max(20, icon_bounds.width * scale) : 20;
				const x = icon_bounds ? (icon_bounds.x - source_bounds.x + icon_bounds.width / 2) * scale - size / 2 : 5;
				const y = icon_bounds ? (icon_bounds.y - source_bounds.y + icon_bounds.height / 2) * scale - size / 2 : 5;
				draw_camera(ctx, x, y, size);
			}
			bitmap.setAttribute("data-node-snapshot-raster", "");
			Object.assign(bitmap.style, { left: `${record.source.offsetLeft}px`, top: `${record.source.offsetTop}px`,
				width: `${record.width}px`, height: `${record.height}px` });
			const entry = { owner: this, record, bitmap, bytes, revision: record.revision, created: performance.now(),
				signature: job.signature, width: record.width, height: record.height,
				dispose: () => { bitmap.remove(); if (entry.record) this.show_image(entry.record, false); entry.record = null; } };
			this.cache.set(record.node, entry);
			record.captured = true;
			record.root.append(bitmap);
			this.stats.captures++;
		}
		catch (error) { bitmap.width = 0; bitmap.height = 0; this.failed(job, error); return; }
		this.finish(job);
	}

	failed(job, error)
	{
		if (this.job !== job) return;
		const reasons = ["unsupported_content", "dynamic_style", "pseudo_content", "external_style_resource", "external_font", "font_load", "slow_step"];
		this.stats.last_failure = reasons.includes(error?.message) ? error.message : "rasterize";
		this.stats.failures++;
		if (this.stats.last_failure !== "rasterize") this.stats.unsupported++;
		if (this.settings.diagnostics) console.warn(`[NodeSnapshots] DOM capture kept live: ${this.stats.last_failure}`);
		this.finish(job);
	}

	finish(job, retry = false)
	{
		if (this.job !== job) return;
		job?.record.root.removeAttribute("data-node-snapshot-capturing");
		if (retry && job) job.record.attempted = -1;
		this.job = null;
		this.request_update();
	}

	invalidate(record, reason = "reset")
	{
		this.stats.invalidations++;
		this.stats.last_invalidation = reason;
		record.revision++;
		const entry = this.cache.entries.get(record.node);
		if (entry?.owner === this && entry.record === record) this.cache.delete(record.node);
	}

	// Nodes that report output draw it while live, so their stored image has to go.
	invalidate_node(id)
	{
		const canvas = this.get_canvas();
		const graph = canvas?.subgraph ?? canvas?.graph;
		const node = graph?.getNodeById(id) ?? graph?.getNodeById(Number(id));
		if (!node) return;
		for (const record of this.records.values())
		{
			if (record.node === node) this.invalidate(record, "executed");
		}
	}

	clear()
	{
		this.scheduler.clear();
		this.job?.record.root.removeAttribute("data-node-snapshot-capturing");
		this.job = null;
		for (const [node, entry] of this.cache.entries)
		{
			if (entry.owner === this) this.cache.delete(node);
		}
		for (const record of this.records.values()) this.invalidate(record);
	}

	release(record)
	{
		record.root.removeAttribute("data-node-snapshot-capturing");
		this.show_image(record, false);
		const entry = this.cache.entries.get(record.node);
		if (entry?.owner === this && entry.record === record)
		{
			entry.bitmap.remove();
			entry.record = null;
		}
		if (this.job?.record === record)
		{
			this.scheduler.clear();
			this.job = null;
		}
		this.intersection.unobserve(record.root);
		this.resize.unobserve(record.source);
		this.visible.delete(record);
		this.records.delete(record.root);
	}

	detach(preserve = false)
	{
		if (preserve) { this.scheduler.clear(); this.job = null; }
		else this.clear();
		this.observer.disconnect();
		this.intersection.disconnect();
		this.resize.disconnect();
		cancelAnimationFrame(this.update_frame);
		this.update_frame = null;
		for (const record of [...this.records.values()]) this.release(record);
		this.style.remove();
		this.pane = null;
	}
}
