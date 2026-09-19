// Run only against a disposable ComfyUI user directory: this replaces its graph.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const url = process.env.NODESNAPSHOTS_TEST_URL;
if (!url) throw new Error("Set NODESNAPSHOTS_TEST_URL to an isolated ComfyUI test server.");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({
	headless: true,
	...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {})
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

try
{
	await page.goto(url);
	await page.waitForFunction(() => window.NodeSnapshots && window.comfyAPI?.app?.app?.canvas, null, { timeout: 90000 });
	await page.locator("[data-testid='queue-button']").waitFor();
	const theme_marker = await page.evaluate(async () =>
	{
		const marker = await import("/extensions/ComfyUI-NodeSnapshots/marker.mjs");
		const canvas = document.createElement("canvas"); canvas.width = canvas.height = 256;
		const ctx = canvas.getContext("2d");
		marker.draw_camera(ctx, 0, 0, 256);
		const actual = [...ctx.getImageData(50, 90, 1, 1).data];
		const button = document.querySelector("[data-testid='queue-button']");
		ctx.fillStyle = getComputedStyle(button).backgroundColor;
		ctx.fillRect(0, 0, 1, 1);
		return { actual, expected: [...ctx.getImageData(0, 0, 1, 1).data] };
	});
	assert.deepEqual(theme_marker.actual, theme_marker.expected, "Camera matches the Run button accent");
	await page.evaluate(() => document.body.style.setProperty("--primary-background", "rgb(180, 70, 210)"));
	await page.waitForFunction(async () =>
	{
		const marker = await import("/extensions/ComfyUI-NodeSnapshots/marker.mjs");
		const canvas = document.createElement("canvas"); canvas.width = canvas.height = 256;
		const ctx = canvas.getContext("2d"); marker.draw_camera(ctx, 0, 0, 256);
		const pixel = ctx.getImageData(50, 90, 1, 1).data;
		return pixel[0] === 180 && pixel[1] === 70 && pixel[2] === 210;
	});
	await page.evaluate(async () =>
	{
		document.body.style.setProperty("--primary-background", "rgb(0, 140, 233)");
		await (await import("/extensions/ComfyUI-NodeSnapshots/marker.mjs")).load_camera();
	});
	console.log("PASS: camera matches Run accent and follows theme changes.");
	await page.evaluate(async () =>
	{
		const { app } = await import("/scripts/app.js");
		window.test_app = app;
		await app.ui.settings.setSettingValue("NodeSnapshot.enabled", true);
		await app.ui.settings.setSettingValue("NodeSnapshot.legacy_enabled", true);
		await app.ui.settings.setSettingValue("NodeSnapshot.vue_cache_enabled", true);
		await app.ui.settings.setSettingValue("NodeSnapshot.vue_enabled", true);
		await app.ui.settings.setSettingValue("NodeSnapshot.pixel_ratio", 2);
		await app.ui.settings.setSettingValue("NodeSnapshot.memory_mb", 256);
		await app.ui.settings.setSettingValue("NodeSnapshot.capture_offscreen", false);
		await app.ui.settings.setSettingValue("NodeSnapshot.exclude_pinned", false);
		await app.ui.settings.setSettingValue("NodeSnapshot.cache_while_idle", false);
		await app.ui.settings.setSettingValue("NodeSnapshot.mark_cached", false);
		await app.ui.settings.setSettingValue("NodeSnapshot.max_age_ms", 0);
		await app.ui.settings.setSettingValue("Comfy.VueNodes.Enabled", false);
		await app.ui.settings.setSettingValue("NodeSnapshot.idle_delay_ms", 50);
		await app.ui.settings.setSettingValue("NodeSnapshot.slow_capture_ms", 100);
		app.graph.clear();
		for (let index = 0; index < 100; index++)
		{
			const node = LiteGraph.createNode("EmptyLatentImage");
			node.pos = [(index % 10) * 340, Math.floor(index / 10) * 240];
			if (index === 99) node.pos = [20000, 20000];
			app.graph.add(node);
		}
		app.canvas.ds.scale = 0.65;
		app.canvas.ds.offset = [80, 240];
		app.canvas.setDirty(true, true);
	});
	await page.waitForFunction(() => NodeSnapshots.getStats().legacy.captures > 20
		&& NodeSnapshots.getStats().legacy.pending === 0, null, { timeout: 30000 });
	const warm = await page.evaluate(() => NodeSnapshots.getStats());
	console.log("Warm cache:", JSON.stringify(warm));
	const comparison = await page.evaluate(() =>
	{
		const canvas = test_app.canvas;
		canvas.draw(true, true);
		const normal = canvas.ctx.getImageData(0, 0, canvas.canvas.width, canvas.canvas.height).data;
		const before = NodeSnapshots.getStats().legacy.hits;
		canvas.dragging_canvas = true;
		canvas.draw(true, true);
		const cached = canvas.ctx.getImageData(0, 0, canvas.canvas.width, canvas.canvas.height).data;
		canvas.dragging_canvas = false;
		let changed = 0;
		for (let index = 0; index < normal.length; index += 4)
		{
			if (Math.max(Math.abs(normal[index] - cached[index]), Math.abs(normal[index + 1] - cached[index + 1]),
				Math.abs(normal[index + 2] - cached[index + 2])) > 32) changed++;
		}
		return { hits: NodeSnapshots.getStats().legacy.hits - before, changed_ratio: changed / (normal.length / 4) };
	});
	console.log("Live/cached rendering:", JSON.stringify(comparison));
	assert.ok(comparison.hits > 0, "Panning must actually reuse images");
	assert.ok(comparison.changed_ratio < 0.025, "Cached rendering must preserve the graph appearance");
	const timing = await page.evaluate(() =>
	{
		const canvas = test_app.canvas;
		const measure = (panning) =>
		{
			canvas.dragging_canvas = panning;
			const start = performance.now();
			for (let index = 0; index < 20; index++) canvas.draw(true, true);
			return (performance.now() - start) / 20;
		};
		const live_ms = measure(false);
		const cached_ms = measure(true);
		canvas.dragging_canvas = false;
		return { live_ms, cached_ms };
	});
	console.log("Main-thread draw time (synthetic graph, excludes compositor):", JSON.stringify(timing));
	const retention = await page.evaluate(() =>
	{
		const canvas = test_app.canvas;
		const before = NodeSnapshots.getStats().legacy;
		canvas.ds.scale = 0.3;
		canvas.draw(true, true);
		const zoomed = NodeSnapshots.getStats().legacy;
		canvas.ds.scale = 0.65;
		canvas.draw(true, true);
		const node = canvas.visible_nodes[0];
		node.pos[0] += 10;
		node.selected = true;
		canvas.isDragging = true;
		canvas.draw(true, true);
		const dragged = NodeSnapshots.getStats().legacy;
		canvas.isDragging = false;
		node.selected = false;
		canvas.resizing_node = node;
		canvas.draw(true, true);
		const resized = NodeSnapshots.getStats().legacy;
		canvas.resizing_node = null;
		return { before, zoomed, dragged, resized };
	});
	for (const state of [retention.zoomed, retention.dragged, retention.resized])
	{
		assert.equal(state.bitmap_count, retention.before.bitmap_count, "Navigation must retain existing snapshots");
		assert.equal(state.captures, retention.before.captures, "Navigation must not recapture images");
		assert.ok(state.hits > retention.before.hits);
	}
	assert.ok(retention.resized.hits > retention.dragged.hits, "Peers reuse snapshots during node resizing");
	const invalidation = await page.evaluate(async () =>
	{
		const canvas = test_app.canvas;
		const bitmaps = () => NodeSnapshots.getStats().legacy.bitmap_count;
		const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		const before = bitmaps();
		canvas.node_over = canvas.visible_nodes[0];
		canvas.dragging_canvas = true;
		canvas.draw(true, true);
		const after_hover = bitmaps();
		canvas.node_over = undefined;
		const edited = canvas.visible_nodes[1];
		canvas.dragging_canvas = false;
		canvas.draw(true, true);
		// Panning reuses each measurement for a short interval, so an edit made
		// mid-gesture is picked up by the next validation pass instead.
		canvas.dragging_canvas = true;
		edited.widgets[0].value += 64;
		canvas.draw(true, true);
		const after_pan_edit = bitmaps();
		await wait(150);
		canvas.draw(true, true);
		const after_validation = bitmaps();
		// Recapture the invalidated node, then confirm idle edits still invalidate it at once.
		canvas.dragging_canvas = false;
		for (let attempt = 0; attempt < 60 && bitmaps() < after_hover; attempt++)
		{
			await wait(50);
			canvas.draw(true, true);
		}
		const recaptured = bitmaps();
		edited.widgets[0].value += 64;
		canvas.draw(true, true);
		return { before, after_hover, after_pan_edit, after_validation, recaptured, after_idle_edit: bitmaps() };
	});
	assert.equal(invalidation.after_hover, invalidation.before, "Hover must retain the unedited snapshot");
	assert.equal(invalidation.after_pan_edit, invalidation.after_hover, "Panning must reuse a node measurement within the validation interval");
	assert.equal(invalidation.after_validation, invalidation.after_hover - 1, "A mid-pan edit must invalidate on the next validation pass");
	assert.ok(invalidation.recaptured >= invalidation.after_hover, "The invalidated node recaptures once the pan ends");
	assert.equal(invalidation.after_idle_edit, invalidation.recaptured - 1, "Changed widget must invalidate its node while idle");
	const before_styles = await page.evaluate(() => NodeSnapshots.getStats().legacy.clears);
	await page.evaluate(() => { document.body.style.cursor = "crosshair"; document.body.classList.add("nodesnapshot-test-unrelated"); });
	await page.waitForTimeout(50);
	assert.equal(await page.evaluate(() => NodeSnapshots.getStats().legacy.clears), before_styles, "Unrelated body styles must not clear images");
	await page.evaluate(async () =>
	{
		document.body.style.removeProperty("cursor");
		document.body.classList.remove("nodesnapshot-test-unrelated");
		await test_app.ui.settings.setSettingValue("NodeSnapshot.cache_while_idle", true);
		await test_app.ui.settings.setSettingValue("NodeSnapshot.mark_cached", true);
	});
	await page.waitForFunction(() => NodeSnapshots.getStats().legacy.bitmap_count > 20
		&& NodeSnapshots.getStats().legacy.pending === 0);
	const marker = await page.evaluate(() =>
	{
		const canvas = test_app.canvas;
		const before = NodeSnapshots.getStats().legacy;
		// Count cached blits. Camera markers must already be part of those images.
		const original_image = canvas.ctx.drawImage;
		const original_arc = canvas.ctx.arc;
		let images = 0;
		let arcs = 0;
		canvas.ctx.drawImage = function (...args) { images++; return original_image.apply(this, args); };
		canvas.ctx.arc = function (...args) { arcs++; return original_arc.apply(this, args); };
		canvas.draw(true, true);
		canvas.ctx.drawImage = original_image;
		canvas.ctx.arc = original_arc;
		const pixels = canvas.ctx.getImageData(0, 0, canvas.canvas.width, canvas.canvas.height).data;
		let accent_pixels = 0;
		for (let index = 0; index < pixels.length; index += 4)
		{
			if (pixels[index] < 70 && pixels[index + 1] > 100 && pixels[index + 2] > 200) accent_pixels++;
		}
		const after = NodeSnapshots.getStats().legacy;
		return { hits: after.hits - before.hits, arcs, images, accent_pixels };
	});
	console.log("Continuous reuse and baked camera markers:", JSON.stringify(marker));
	assert.ok(marker.hits > 20, "Continuous mode reuses images without panning");
	assert.ok(marker.accent_pixels > 100, "Reused snapshots must visibly show accent-colored cameras");
	assert.equal(marker.arcs, 0, "No realtime marker paths");
	assert.ok(marker.images <= marker.hits + 1, "Only one blit per snapshot, plus the native background copy");
	await page.evaluate(async () =>
	{
		const host = [...document.querySelectorAll("*")].find((element) => element.__vue_app__);
		window.test_navigation = host.__vue_app__.config.globalProperties.$pinia._s.get("subgraphNavigation");
		window.test_subgraph = test_app.rootGraph.convertToSubgraph(new Set([test_app.rootGraph.nodes.at(-1)]));
		test_subgraph.node.pos = [20000, 20000];
		const offscreen = LiteGraph.createNode("EmptyLatentImage");
		offscreen.pos = [24000, 24000];
		test_app.rootGraph.add(offscreen);
		await test_navigation.navigateToGraph(test_subgraph.subgraph);
	});
	// First visit loads navigation UI fonts. Let that legitimate font refresh finish.
	await page.waitForTimeout(200);
	await page.evaluate(async () => { await document.fonts.ready; await test_navigation.navigateToGraph(test_app.rootGraph); });
	await page.waitForFunction(() => NodeSnapshots.getStats().legacy.bitmap_count > 20 && NodeSnapshots.getStats().legacy.pending === 0);
	await page.evaluate(async () => test_app.ui.settings.setSettingValue("NodeSnapshot.idle_delay_ms", 5000));
	const before_subgraph = await page.evaluate(() => NodeSnapshots.getStats().legacy);
	await page.evaluate(async () => test_navigation.navigateToGraph(test_subgraph.subgraph));
	await page.waitForTimeout(100);
	await page.evaluate(async () => test_navigation.navigateToGraph(test_app.rootGraph));
	const after_subgraph = await page.evaluate(() =>
	{
		test_app.canvas.draw(true, true);
		return NodeSnapshots.getStats().legacy;
	});
	assert.equal(after_subgraph.clears, before_subgraph.clears, "Subgraph navigation must not clear the cache");
	assert.equal(after_subgraph.captures, before_subgraph.captures, "Returning to the main graph must not recapture it");
	assert.ok(after_subgraph.hits > before_subgraph.hits, "Retained main graph images must be reused on return");
	await page.evaluate(async () => test_app.ui.settings.setSettingValue("NodeSnapshot.idle_delay_ms", 50));
	await page.evaluate(async () =>
	{
		await test_app.ui.settings.setSettingValue("NodeSnapshot.max_age_ms", 500);
		test_app.canvas.dragging_canvas = true;
	});
	const aged_count = await page.evaluate(() => NodeSnapshots.getStats().legacy.bitmap_count);
	await page.waitForTimeout(650);
	assert.equal(await page.evaluate(() =>
	{
		test_app.canvas.draw(true, true);
		return NodeSnapshots.getStats().legacy.bitmap_count;
	}), aged_count, "Aging must not discard images mid-interaction");
	const captures_before_refresh = await page.evaluate(() => NodeSnapshots.getStats().legacy.captures);
	await page.evaluate(() => { test_app.canvas.dragging_canvas = false; test_app.canvas.setDirty(true, true); });
	await page.waitForFunction((count) => NodeSnapshots.getStats().legacy.captures > count, captures_before_refresh);
	await page.evaluate(async () => test_app.ui.settings.setSettingValue("NodeSnapshot.legacy_enabled", false));
	assert.equal(await page.evaluate(() => NodeSnapshots.getStats().legacy.bitmap_count), 0, "Legacy disable releases images");
	const disabled_hits = await page.evaluate(() => NodeSnapshots.getStats().legacy.hits);
	await page.evaluate(() => test_app.canvas.draw(true, true));
	assert.equal(await page.evaluate(() => NodeSnapshots.getStats().legacy.hits), disabled_hits, "Legacy disable stops reuse");
	await page.evaluate(async () => test_app.ui.settings.setSettingValue("NodeSnapshot.legacy_enabled", true));
	await page.waitForFunction(() => NodeSnapshots.getStats().legacy.bitmap_count > 20
		&& NodeSnapshots.getStats().legacy.pending === 0);

	await page.evaluate(async () =>
	{
		const { api } = await import("/scripts/api.js");
		api.dispatchEvent(new CustomEvent("execution_start", { detail: {} }));
	});
	const running = await page.evaluate(() =>
	{
		// A real pan starts with a pointer press, which also lifts rendering
		// suppression that other extensions apply while a prompt is running.
		document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		test_app.canvas.dragging_canvas = true;
		const before = NodeSnapshots.getStats().legacy;
		test_app.canvas.draw(true, true);
		const after = NodeSnapshots.getStats().legacy;
		test_app.canvas.dragging_canvas = false;
		return { executing: NodeSnapshots.getStats().executing, bitmaps: after.bitmap_count,
			clears: after.clears - before.clears, hits: after.hits - before.hits, captures: after.captures - before.captures };
	});
	assert.equal(running.executing, true, "Execution start is tracked");
	assert.ok(running.bitmaps > 20, "Execution must retain cached images");
	assert.equal(running.clears, 0, "Execution must not clear the cache");
	assert.ok(running.hits > 0, "Panning during execution must reuse images");
	assert.equal(running.captures, 0, "Execution must not queue captures");
	const reported = await page.evaluate(async () =>
	{
		const { api } = await import("/scripts/api.js");
		const node = test_app.canvas.visible_nodes[0];
		const before = NodeSnapshots.getStats().legacy.bitmap_count;
		api.dispatchEvent(new CustomEvent("executed", { detail: { node: node.id, output: {} } }));
		return { before, after: NodeSnapshots.getStats().legacy.bitmap_count };
	});
	assert.ok(reported.after > 20, "Reported output must not clear unrelated images");
	assert.ok(reported.after >= reported.before - 1, "Reported output must invalidate at most its own node");
	await page.evaluate(async () =>
	{
		const { api } = await import("/scripts/api.js");
		api.dispatchEvent(new CustomEvent("executing", { detail: null }));
		await test_app.ui.settings.setSettingValue("NodeSnapshot.release_while_executing", true);
	});
	await page.waitForFunction(() => NodeSnapshots.getStats().legacy.bitmap_count > 20
		&& NodeSnapshots.getStats().legacy.pending === 0);
	const released = await page.evaluate(async () =>
	{
		const { api } = await import("/scripts/api.js");
		api.dispatchEvent(new CustomEvent("execution_start", { detail: {} }));
		const after_start = NodeSnapshots.getStats().legacy.bitmap_count;
		api.dispatchEvent(new CustomEvent("executing", { detail: null }));
		await test_app.ui.settings.setSettingValue("NodeSnapshot.release_while_executing", false);
		return after_start;
	});
	assert.equal(released, 0, "Release images while executing must free stored images at run start");
	await page.evaluate(async () =>
	{
		const { api } = await import("/scripts/api.js");
		api.dispatchEvent(new CustomEvent("executing", { detail: null }));
		await test_app.ui.settings.setSettingValue("NodeSnapshot.max_age_ms", 0);
		await test_app.ui.settings.setSettingValue("Comfy.VueNodes.Enabled", true);
	});
	await page.waitForFunction(() => NodeSnapshots.getStats().vue.managed_bodies > 0, null, { timeout: 30000 });
	await page.waitForFunction(() => NodeSnapshots.getStats().vue.skipped_bodies > 0, null, { timeout: 10000 });
	await page.waitForFunction(() => NodeSnapshots.getStats().vue.captures > 0, null, { timeout: 45000 });
	await page.evaluate(async () => test_app.ui.settings.setSettingValue("NodeSnapshot.max_age_ms", 0));
	await page.waitForFunction(() => document.querySelector("[data-node-snapshot-image]"));
	const captured_id = await page.locator("[data-node-snapshot-image]").first().getAttribute("data-node-id");
	const captured_node = page.locator(`.lg-node[data-node-id="${captured_id}"]`);
	await page.waitForFunction((id) => getComputedStyle(document.querySelector(`.lg-node[data-node-id="${id}"] > [data-testid="node-inner-wrapper"]`)).visibility === "hidden", captured_id);
	console.log("Raster presentation:", JSON.stringify(await captured_node.evaluate((root) => ({
		active: root.hasAttribute("data-node-snapshot-image"), hover: root.matches(":hover"),
		visibility: getComputedStyle(root.querySelector("[data-testid='node-inner-wrapper']")).visibility,
		display: getComputedStyle(root.querySelector("[data-node-snapshot-raster]")).display
	}))));
	const clip = await captured_node.boundingBox();
	const raster_png = await page.screenshot({ clip, caret: "initial" });
	assert.equal(await captured_node.getAttribute("data-node-snapshot-image"), "", "Raster remains active during the screenshot");
	await page.evaluate(async () => test_app.ui.settings.setSettingValue("NodeSnapshot.cache_while_idle", false));
	await page.waitForFunction((id) => !document.querySelector(`.lg-node[data-node-id="${id}"]`).hasAttribute("data-node-snapshot-image"), captured_id);
	const native_png = await page.screenshot({ clip, caret: "initial" });
	const dom_pixels = await page.evaluate(async ([raster, native]) =>
	{
		const read = async (data) =>
		{
			const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
			const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
			const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0); return ctx.getImageData(0, 0, image.width, image.height).data;
		};
		const left = await read(raster); const right = await read(native);
		if (left.length !== right.length) return 1;
		let changed = 0, accent = 0;
		for (let index = 0; index < left.length; index += 4)
		{
			if (left[index] < 70 && left[index + 1] > 100 && left[index + 2] > 200) accent++;
			if (Math.max(...[0, 1, 2].map((channel) => Math.abs(left[index + channel] - right[index + channel]))) > 40) changed++;
		}
		return { changed: changed / (left.length / 4), accent };
	}, [raster_png.toString("base64"), native_png.toString("base64")]);
	console.log("Nodes 2.0 native/raster pixel difference:", dom_pixels);
	assert.ok(dom_pixels.changed < 0.08, "DOM screenshot must preserve node text and controls");
	assert.ok(dom_pixels.accent > 10, "The presented DOM snapshot must show its baked marker");
	if (process.env.NODESNAPSHOTS_SCREENSHOT)
	{
		await import("node:fs/promises").then((fs) => fs.writeFile(process.env.NODESNAPSHOTS_SCREENSHOT + ".native.png", native_png));
		await import("node:fs/promises").then((fs) => fs.writeFile(process.env.NODESNAPSHOTS_SCREENSHOT + ".raster.png", raster_png));
	}
	const restored_before = await page.evaluate(() => NodeSnapshots.getStats().vue.restored);
	await captured_node.evaluate((root) => { window.test_bitmap = root.querySelector("[data-node-snapshot-raster]"); });
	await page.evaluate(async () => test_navigation.navigateToGraph(test_subgraph.subgraph));
	await page.waitForTimeout(650);
	await page.evaluate(async () => test_navigation.navigateToGraph(test_app.rootGraph));
	await page.waitForFunction((count) => NodeSnapshots.getStats().vue.restored > count, restored_before, { timeout: 15000 });
	assert.equal(await captured_node.evaluate((root) => root.querySelector("[data-node-snapshot-raster]") === test_bitmap), true, "The same DOM bitmap survives subgraph navigation");
	await page.waitForTimeout(500);
	console.log("Nodes 2.0 before geometry reads:", JSON.stringify(await page.evaluate(() => NodeSnapshots.getStats())));
	const dimensions = await page.evaluate(() => [...document.querySelectorAll(".lg-node")].map((node) =>
		({ id: node.dataset.nodeId, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
	console.log("Nodes 2.0:", JSON.stringify(await page.evaluate(() => NodeSnapshots.getStats())));
	if (process.env.NODESNAPSHOTS_SCREENSHOT) await page.screenshot({ path: process.env.NODESNAPSHOTS_SCREENSHOT });
	await page.evaluate(async () => test_app.ui.settings.setSettingValue("NodeSnapshot.enabled", false));
	await page.waitForTimeout(500);
	const restored = await page.evaluate(() => [...document.querySelectorAll(".lg-node")].map((node) =>
		({ id: node.dataset.nodeId, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
	assert.equal(await page.locator("[data-node-snapshot-body]").count(), 0);
	for (const node of dimensions)
	{
		const other = restored.find((item) => item.id === node.id);
		if (other)
		{
			assert.ok(Math.abs(node.width - other.width) < 1, `Width changed for ${node.id}`);
			assert.ok(Math.abs(node.height - other.height) < 1, `Height changed for ${node.id}`);
		}
	}
	await page.evaluate(async () =>
	{
		await test_app.ui.settings.setSettingValue("NodeSnapshot.enabled", true);
		await test_app.ui.settings.setSettingValue("Comfy.VueNodes.Enabled", false);
		test_app.canvas.setDirty(true, true);
	});
	await page.waitForFunction(() => NodeSnapshots.getStats().legacy.bitmap_count > 0
		&& NodeSnapshots.getStats().vue.managed_bodies === 0);
	await page.evaluate(async () =>
	{
		test_app.rootGraph.clear();
		const inner = LiteGraph.createNode("EmptyLatentImage");
		test_app.rootGraph.add(inner);
		const { node } = test_app.rootGraph.convertToSubgraph(new Set([inner]));
		node.pos = [450, 0];
		window.test_note = LiteGraph.createNode("Note");
		test_app.rootGraph.add(test_note);
		test_note.pos = [0, 0];
		test_note.collapse();
		test_app.canvas.ds.scale = 0.65;
		test_app.canvas.ds.offset = [80, 240];
		await test_app.ui.settings.setSettingValue("NodeSnapshot.cache_while_idle", true);
		NodeSnapshots.clearCache();
		test_app.canvas.setDirty(true, true);
	});
	await page.waitForFunction(() => NodeSnapshots.getStats().legacy.bitmap_count === 2, null, { timeout: 15000 });
	console.log("PASS: collapsed Note and plain subgraph snapshots.");
	await page.evaluate(async () =>
	{
		test_note.collapse();
		await test_app.ui.settings.setSettingValue("Comfy.VueNodes.Enabled", true);
	});
	await page.waitForFunction(() => document.querySelector(`[data-node-id="${test_note.id}"][data-node-snapshot-image]`), null, { timeout: 20000 });
	const note_root = page.locator(".lg-node").filter({ has: page.locator("textarea") });
	assert.equal(await note_root.count(), 1, "Expanded Note retains its editable textarea");
	await note_root.hover();
	assert.equal(await note_root.locator("[data-testid='node-inner-wrapper']").evaluate((element) => getComputedStyle(element).visibility), "visible", "Hover restores live Notes 2.0 editing");
	await note_root.locator("textarea").fill("Changed note");
	assert.equal(await note_root.getAttribute("data-node-snapshot-image"), null, "Editing invalidates the Note image");
	await note_root.locator("textarea").blur();
	await page.mouse.move(1400, 900);
	await page.waitForFunction(() => document.querySelector(`[data-node-id="${test_note.id}"][data-node-snapshot-image]`), null, { timeout: 20000 });
	await page.evaluate(async () => test_app.ui.settings.setSettingValue("NodeSnapshot.pixel_ratio", 0.5));
	await page.waitForFunction(() => document.querySelector(`[data-node-id="${test_note.id}"][data-node-snapshot-image]`), null, { timeout: 20000 });
	assert.equal(await note_root.evaluate((root) =>
	{
		const bitmap = root.querySelector("[data-node-snapshot-raster]");
		return bitmap.width === Math.ceil(parseFloat(bitmap.style.width) * 0.5);
	}), true, "Sub-1 pixel ratios reduce actual bitmap dimensions");
	const unsupported_before = await page.evaluate(() => NodeSnapshots.getStats().vue.unsupported);
	await note_root.locator("[data-testid='node-inner-wrapper']").evaluate((element) => element.append(document.createElement("canvas")));
	await page.waitForFunction((count) => NodeSnapshots.getStats().vue.unsupported > count, unsupported_before);
	assert.equal(await note_root.getAttribute("data-node-snapshot-image"), null, "Unsupported canvas content stays live");
	assert.deepEqual(errors, [], "Unexpected frontend exceptions");
	console.log("PASS: real frontend capture, pixel comparison, execution retention, Nodes 2.0, and disable cleanup.");
}
catch (error)
{
	console.log("Failure state:", JSON.stringify(await page.evaluate(() => window.NodeSnapshots?.getStats())));
	console.log("Frontend exceptions:", JSON.stringify(errors));
	throw error;
}
finally
{
	await browser.close();
}
