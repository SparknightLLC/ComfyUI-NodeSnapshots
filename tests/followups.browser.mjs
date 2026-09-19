// Run against a disposable server: replaces its workflow and settings.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
if (!process.env.NODESNAPSHOTS_TEST_URL) throw new Error("Set NODESNAPSHOTS_TEST_URL to a disposable server.");
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

try
{
	await page.goto(process.env.NODESNAPSHOTS_TEST_URL);
	await page.waitForFunction(() => window.NodeSnapshots && window.comfyAPI?.app?.app?.canvas, null, { timeout: 90000 });
	await page.evaluate(async () =>
	{
		window.test_app = (await import("/scripts/app.js")).app;
		const settings = {
			enabled: true, legacy_enabled: true, vue_cache_enabled: true, cache_while_idle: true,
			mark_cached: true, capture_offscreen: false, exclude_pinned: true, idle_delay_ms: 50,
			slow_capture_ms: 100, max_age_ms: 0, pixel_ratio: 2, links_enabled: true, links_cache_while_idle: true, links_overscan_px: 128
		};
		for (const [key, value] of Object.entries(settings))
			await test_app.ui.settings.setSettingValue(`NodeSnapshot.${key}`, value);
		await test_app.ui.settings.setSettingValue("Comfy.VueNodes.Enabled", false);
		test_app.rootGraph.clear();
		window.test_nodes = [];
		for (let index = 0; index < 3; index++)
		{
			const node = LiteGraph.createNode("EmptyLatentImage");
			node.pos = [index === 2 ? 20000 : index * 400, 0];
			test_app.rootGraph.add(node);
			test_nodes.push(node);
		}
		test_nodes[1].pin(true);
		test_app.canvas.ds.scale = 0.65;
		test_app.canvas.ds.offset = [80, 240];
		NodeSnapshots.clearCache();
		test_app.canvas.setDirty(true, true);
	});
	await page.waitForFunction(() => NodeSnapshots.getStats().legacy.bitmap_count === 1);
	await page.waitForTimeout(300);
	assert.equal(await page.evaluate(() => NodeSnapshots.getStats().legacy.bitmap_count), 1, "Pinned and offscreen nodes excluded");
	await page.evaluate(async () => test_app.ui.settings.setSettingValue("NodeSnapshot.capture_offscreen", true));
	await page.waitForFunction(() => NodeSnapshots.getStats().legacy.bitmap_count === 2);
	await page.evaluate(() => { test_nodes[1].pin(false); test_app.canvas.setDirty(true, true); });
	await page.waitForFunction(() => NodeSnapshots.getStats().legacy.bitmap_count === 3);
	await page.evaluate(async () =>
	{
		test_nodes[1].pin(true);
		await test_app.ui.settings.setSettingValue("Comfy.VueNodes.Enabled", true);
	});
	await page.waitForFunction(() => NodeSnapshots.getStats().vue.snapshots === 2, null, { timeout: 45000 });
	const pinned_id = await page.evaluate(() => test_nodes[1].id);
	assert.equal(await page.locator(`.lg-node[data-node-id="${pinned_id}"] canvas[data-node-snapshot-raster]`).count(), 0);
	await page.evaluate(() => test_nodes[1].pin(false));
	await page.waitForFunction(() => NodeSnapshots.getStats().vue.snapshots === 3, null, { timeout: 20000 });
	console.log("PASS: pinned exclusion and offscreen capture in both renderers.");

	await page.evaluate(async () =>
	{
		await test_app.ui.settings.setSettingValue("Comfy.VueNodes.Enabled", false);
		await test_app.ui.settings.setSettingValue("NodeSnapshot.capture_offscreen", false);
		test_app.rootGraph.clear();
		window.link_nodes = [];
		for (let index = 0; index < 120; index++)
		{
			const origin = LiteGraph.createNode("EmptyLatentImage");
			const target = LiteGraph.createNode("VAEDecode");
			origin.pos = [-400, index * 8];
			target.pos = [1800, index * 8];
			test_app.rootGraph.add(origin);
			test_app.rootGraph.add(target);
			origin.connect(0, target, 0);
			link_nodes.push(origin, target);
		}
		// An extremely long crossing link must not allocate a graph-sized image.
		link_nodes[0].pos[0] = -100000;
		link_nodes[1].pos[0] = 100000;
		test_app.canvas.ds.scale = 0.65;
		test_app.canvas.ds.offset = [80, 240];
		NodeSnapshots.clearCache();
		test_app.canvas.setDirty(true, true);
	});
	await page.waitForFunction(() => NodeSnapshots.getStats().links.captures > 0, null, { timeout: 15000 });
	for (const vue of [false, true])
	{
		await page.evaluate(async (value) =>
		{
			await test_app.ui.settings.setSettingValue("Comfy.VueNodes.Enabled", value);
			test_app.canvas.setDirty(true, true);
		}, vue);
		await page.waitForFunction(() => NodeSnapshots.getStats().links.pixel_bytes > 0, null, { timeout: 15000 });
		const result = await page.evaluate(async () =>
		{
			const canvas = test_app.canvas;
			const surface = document.createElement("canvas");
			surface.width = canvas.canvas.width;
			surface.height = canvas.canvas.height;
			const ctx = surface.getContext("2d");
			ctx.setTransform(canvas.ds.scale, 0, 0, canvas.ds.scale,
				canvas.ds.offset[0] * canvas.ds.scale, canvas.ds.offset[1] * canvas.ds.scale);
			canvas.drawConnections(ctx);
			const cached = ctx.getImageData(0, 0, surface.width, surface.height).data;
			const before = NodeSnapshots.getStats().links;
			const cached_start = performance.now();
			for (let index = 0; index < 30; index++) canvas.drawConnections(ctx);
			const cached_ms = (performance.now() - cached_start) / 30;
			ctx.save();
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, surface.width, surface.height);
			ctx.restore();
			await test_app.ui.settings.setSettingValue("NodeSnapshot.links_enabled", false);
			canvas.drawConnections(ctx);
			const live = ctx.getImageData(0, 0, surface.width, surface.height).data;
			const live_start = performance.now();
			for (let index = 0; index < 30; index++) canvas.drawConnections(ctx);
			const live_ms = (performance.now() - live_start) / 30;
			let changed = 0;
			let painted = 0;
			for (let index = 0; index < live.length; index += 4)
			{
				if (live[index + 3]) painted++;
				if (Math.max(...[0, 1, 2, 3].map((channel) => Math.abs(live[index + channel] - cached[index + channel]))) > 40) changed++;
			}
			await test_app.ui.settings.setSettingValue("NodeSnapshot.links_enabled", true);
			canvas.setDirty(true, true);
			return { changed: changed / (live.length / 4), painted, before, cached_ms, live_ms };
		});
		console.log("Links", vue ? "Nodes 2.0" : "Legacy", JSON.stringify(result));
		assert.ok(result.painted > 1000, "Visible links are drawn");
		assert.ok(result.changed < 0.025, "Cached link pixels match live");
		assert.ok(result.before.hits > 0);
		assert.ok(result.before.pixel_bytes <= 32 * 1024 * 1024);
		await page.waitForFunction(() => NodeSnapshots.getStats().links.pixel_bytes > 0);
		const pan = await page.evaluate(() =>
		{
			const canvas = test_app.canvas;
			const before = NodeSnapshots.getStats().links;
			canvas.dragging_canvas = true;
			canvas.ds.offset[0] += 20;
			canvas.draw(true, true);
			canvas.dragging_canvas = false;
			document.dispatchEvent(new PointerEvent("pointerup"));
			canvas.draw(true, true);
			return { before, after: NodeSnapshots.getStats().links };
		});
		assert.ok(pan.after.hits > pan.before.hits, "Small pans reuse the bounded link image");
		assert.equal(pan.after.captures, pan.before.captures);
		const move = await page.evaluate(() =>
		{
			link_nodes[2].pos[1] += 30;
			const before = NodeSnapshots.getStats().links;
			test_app.canvas.draw(true, true);
			return { before, after: NodeSnapshots.getStats().links };
		});
		assert.ok(move.after.live > move.before.live, "Endpoint motion invalidates links");
		await page.waitForFunction(() => NodeSnapshots.getStats().links.pixel_bytes > 0);
		const hidden = await page.evaluate(async () =>
		{
			const canvas = test_app.canvas;
			const mode = canvas.links_render_mode;
			const before = NodeSnapshots.getStats().links;
			canvas.links_render_mode = LiteGraph.HIDDEN_LINK ?? -1;
			canvas.draw(true, true);
			await new Promise((resolve) => setTimeout(resolve, 250));
			const after = NodeSnapshots.getStats().links;
			const hit_paths = canvas.renderedPaths.size;
			canvas.links_render_mode = mode;
			canvas.setDirty(true, true);
			return { before, after, hit_paths };
		});
		assert.equal(hidden.after.pixel_bytes, 0, "Hidden links release their bitmap");
		assert.equal(hidden.after.captures, hidden.before.captures, "Hidden links never queue blank captures");
		assert.equal(hidden.hit_paths, 0, "Native hidden-link hit-path cleanup still runs");
	}
	assert.deepEqual(errors, []);
	console.log("PASS: bounded link pixels, panning reuse, endpoint invalidation in both renderers.");
}
catch (error)
{
	console.log(await page.evaluate(() => NodeSnapshots.getStats()));
	console.log(errors);
	throw error;
}
finally
{
	await browser.close();
}
