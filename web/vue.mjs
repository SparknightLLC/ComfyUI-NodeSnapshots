const BODY_SELECTOR = ".lg-node [data-testid^='node-body-']";
const STYLE_TEXT = `
[data-node-snapshot-body] {
	content-visibility: auto;
	contain-intrinsic-size: auto var(--node-snapshot-width, 200px) auto var(--node-snapshot-height, 100px);
	overflow-clip-margin: 32px;
}
.lg-node:hover [data-node-snapshot-body],
.lg-node:focus-within [data-node-snapshot-body],
.lg-node:has([data-testid="node-state-outline-overlay"]) [data-node-snapshot-body] {
	content-visibility: visible;
}
[data-node-snapshot-navigation] .lg-node,
[data-node-snapshot-no-shadows] .lg-node {
	filter: none !important;
}
[data-node-snapshot-square] .lg-node > [data-testid="node-inner-wrapper"],
[data-node-snapshot-square] .lg-node [data-testid^="node-header-"],
[data-node-snapshot-square] .lg-node [data-testid^="node-body-"],
[data-node-snapshot-square] .lg-node [data-testid="subgraph-enter-button"],
[data-node-snapshot-square] .lg-node [data-testid="advanced-inputs-button"],
[data-node-snapshot-square] .lg-node [data-testid="node-state-outline-overlay"] {
	border-radius: 0 !important;
}
`;

// Keep Vue's elements, event handlers, geometry, and component lifecycle intact.
// The browser decides when offscreen bodies can skip layout and paint.
export class VueOptimizer
{
	constructor(settings)
	{
		this.settings = settings;
		this.pane = null;
		this.bodies = new Set();
		this.skipped = new Set();
		this.pending = new Set();
		this.handle = null;
		this.navigation_timer = null;
		this.style = document.createElement("style");
		this.style.textContent = STYLE_TEXT;
		this.observer = new MutationObserver((records) =>
		{
			for (const record of records)
			{
				for (const node of record.addedNodes)
				{
					if (node instanceof Element) this.collect(node);
				}
				for (const node of record.removedNodes)
				{
					if (!(node instanceof Element) || this.pane?.contains(node)) continue;
					if (this.bodies.has(node)) this.release(node);
					this.pending.delete(node);
					for (const body of node.querySelectorAll("[data-testid^='node-body-']"))
					{
						if (this.bodies.has(body)) this.release(body);
						this.pending.delete(body);
					}
				}
			}
		});
		this.resize = new ResizeObserver((entries) =>
		{
			for (const entry of entries)
			{
				const { width, height } = entry.contentRect;
				if (this.skipped.has(entry.target) || width <= 0 || height <= 0) continue;
				entry.target.style.setProperty("--node-snapshot-width", `${width}px`);
				entry.target.style.setProperty("--node-snapshot-height", `${height}px`);
				// Measure once while live before allowing size containment offscreen.
				entry.target.setAttribute("data-node-snapshot-body", "");
			}
		});
		this.visibility_listener = (event) =>
		{
			if (event.skipped) this.skipped.add(event.target);
			else this.skipped.delete(event.target);
		};
	}

	sync()
	{
		const pane = this.settings.enabled && window.LiteGraph?.vueNodesMode
			? document.querySelector("[data-testid='transform-pane']") : null;
		if (pane === this.pane) return;
		this.detach();
		if (!pane) return;
		this.pane = pane;
		document.head.append(this.style);
		pane.toggleAttribute("data-node-snapshot-no-shadows", this.settings.no_shadows);
		pane.toggleAttribute("data-node-snapshot-square", this.settings.square_corners);
		if (this.settings.vue_enabled && CSS.supports("content-visibility", "auto"))
		{
			this.collect(pane);
			this.observer.observe(pane, { childList: true, subtree: true });
		}
	}

	collect(root)
	{
		if (root.matches(BODY_SELECTOR)) this.pending.add(root);
		for (const body of root.querySelectorAll(BODY_SELECTOR)) this.pending.add(body);
		if (this.handle === null && this.pending.size) this.handle = requestAnimationFrame(() => this.prepare());
	}

	prepare()
	{
		this.handle = null;
		const start = performance.now();
		for (const body of this.pending)
		{
			this.pending.delete(body);
			if (!this.pane?.contains(body) || this.bodies.has(body)) continue;
			this.bodies.add(body);
			body.addEventListener("contentvisibilityautostatechange", this.visibility_listener);
			this.resize.observe(body);
			if (performance.now() - start >= this.settings.capture_budget_ms) break;
		}
		if (this.pending.size) this.handle = requestAnimationFrame(() => this.prepare());
	}

	navigation()
	{
		if (!this.settings.enabled || !this.settings.vue_shadows || !this.pane) return;
		this.pane.setAttribute("data-node-snapshot-navigation", "");
		clearTimeout(this.navigation_timer);
		this.navigation_timer = setTimeout(() => this.pane?.removeAttribute("data-node-snapshot-navigation"), 180);
	}

	release(body)
	{
		this.resize.unobserve(body);
		body.removeEventListener("contentvisibilityautostatechange", this.visibility_listener);
		body.removeAttribute("data-node-snapshot-body");
		body.style.removeProperty("--node-snapshot-width");
		body.style.removeProperty("--node-snapshot-height");
		this.bodies.delete(body);
		this.skipped.delete(body);
	}

	detach()
	{
		this.observer.disconnect();
		this.resize.disconnect();
		cancelAnimationFrame(this.handle);
		clearTimeout(this.navigation_timer);
		this.handle = null;
		this.pending.clear();
		for (const body of this.bodies) this.release(body);
		this.pane?.removeAttribute("data-node-snapshot-navigation");
		this.pane?.removeAttribute("data-node-snapshot-no-shadows");
		this.pane?.removeAttribute("data-node-snapshot-square");
		this.pane = null;
		this.style.remove();
	}
}
