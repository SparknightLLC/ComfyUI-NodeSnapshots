// Run against a disposable server: replaces its workflow and settings.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
if (!process.env.NODESNAPSHOTS_TEST_URL) throw new Error("Set NODESNAPSHOTS_TEST_URL to a disposable server.");
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: Number(process.env.NODESNAPSHOTS_TEST_DPR || 1) });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

try
{
	await page.goto(process.env.NODESNAPSHOTS_TEST_URL);
	await page.waitForFunction(() => window.NodeSnapshots && window.comfyAPI?.app?.app?.canvas, null, { timeout: 90000 });
	await page.evaluate(async () =>
	{
		window.test_app = (await import("/scripts/app.js")).app;
		for (const [key, value] of Object.entries({ enabled: true, links_enabled: true, links_cache_while_idle: true, links_overscan_px: 128, mark_cached: false,
			idle_delay_ms: 50, slow_capture_ms: 100, cache_while_idle: true }))
			await test_app.ui.settings.setSettingValue(`NodeSnapshot.${key}`, value);
		await test_app.ui.settings.setSettingValue("Comfy.VueNodes.Enabled", false);
		test_app.rootGraph.clear();
		const origin = LiteGraph.createNode("EmptyLatentImage");
		const target = LiteGraph.createNode("VAEDecode");
		origin.pos = [100, 140]; target.pos = [800, 380];
		test_app.rootGraph.add(origin); test_app.rootGraph.add(target); origin.connect(0, target, 0);
		const cover = LiteGraph.createNode("EmptyLatentImage");
		cover.pos = [440, 240]; test_app.rootGraph.add(cover);
		const group = new LiteGraph.LGraphGroup("Behind the links");
		group.pos = [60, 70]; group.size = [1150, 650]; test_app.rootGraph.add(group);
		test_app.canvas.ds.scale = 0.8; test_app.canvas.ds.offset = [50, 90];
		test_app.canvas.show_info = false;
		test_app.canvas.setDirty(true, true);
	});
	for (const vue of [false, true])
	{
		await page.evaluate(async (vue) => test_app.ui.settings.setSettingValue("Comfy.VueNodes.Enabled", vue), vue);
		await page.waitForTimeout(1800);
		await page.waitForFunction(() => document.querySelector("[data-node-snapshots-links]"));
		const idle_before = await page.evaluate(() => NodeSnapshots.getStats().links);
		await page.evaluate(async () => test_app.ui.settings.setSettingValue("NodeSnapshot.links_cache_while_idle", false));
		await page.waitForFunction(() => !document.querySelector("[data-node-snapshots-links]"));
		const idle = await page.evaluate(() =>
		{
			const canvas = test_app.canvas;
			canvas.draw(true, true);
			const idle = NodeSnapshots.getStats().links;
			canvas.dragging_canvas = true;
			canvas.ds.offset[0] += 10;
			canvas.draw(true, true);
			const panning = NodeSnapshots.getStats().links;
			canvas.dragging_canvas = false;
			document.dispatchEvent(new PointerEvent("pointerup"));
			return { idle, panning, hit_paths: canvas.renderedPaths.size };
		});
		assert.equal(idle.idle.pixel_bytes, idle_before.pixel_bytes, "Idle native rendering retains the link bitmap");
		assert.equal(idle.panning.captures, idle_before.captures, "Next pan reuses the retained bitmap");
		assert.ok(idle.panning.layer_hits > idle.idle.layer_hits);
		assert.ok(idle.hit_paths > 0);
		await page.waitForFunction(() => !document.querySelector("[data-node-snapshots-links]"));
		await page.evaluate(() =>
		{
			test_app.canvas.canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 0 }));
			test_app.canvas.draw(true, true);
		});
		assert.equal(await page.locator("[data-node-snapshots-links]").count(), 1, "Wheel navigation can use the retained link image");
		await page.waitForFunction(() => !document.querySelector("[data-node-snapshots-links]"));
		await page.evaluate(async () => test_app.ui.settings.setSettingValue("NodeSnapshot.links_cache_while_idle", true));
		await page.waitForFunction(() => document.querySelector("[data-node-snapshots-links]"));
		for (const zoom of [0.8, 0.95])
		{
			await page.evaluate((zoom) =>
			{
				test_app.canvas.ds.scale = zoom;
				test_app.canvas.ds.offset[0] += 12;
				test_app.canvas.draw(true, true);
			}, zoom);
			await page.waitForTimeout(500);
			const layered = await page.screenshot();
			const state = await page.evaluate(async () =>
			{
				const canvas = test_app.canvas;
				const layer = document.querySelector("[data-node-snapshots-links]");
				const state = { children: layer?.children.length, hit_paths: canvas.renderedPaths.size,
					stats: NodeSnapshots.getStats().links, foreground_alpha: canvas.ctx.getContextAttributes().alpha };
				await test_app.ui.settings.setSettingValue("NodeSnapshot.links_enabled", false);
				canvas.draw(true, true);
				return state;
			});
			assert.equal(state.children, 2, "Separate background and link canvases");
			assert.ok(state.hit_paths > 0, "Native graph-space hit paths remain available");
			assert.ok(state.foreground_alpha, "Foreground supports transparent compositing");
			await page.waitForTimeout(100);
			const live = await page.screenshot();
			const difference = await page.evaluate(async ([layered, live]) =>
			{
				const pixels = async (data) =>
				{
					const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
					const surface = document.createElement("canvas"); surface.width = image.width; surface.height = image.height;
					const ctx = surface.getContext("2d"); ctx.drawImage(image, 0, 0);
					return ctx.getImageData(0, 0, surface.width, surface.height).data;
				};
				const a = await pixels(layered), b = await pixels(live);
				let changed = 0;
				for (let i = 0; i < a.length; i += 4)
					if (Math.max(Math.abs(a[i]-b[i]), Math.abs(a[i+1]-b[i+1]), Math.abs(a[i+2]-b[i+2])) > 40) changed++;
				return changed / (a.length / 4);
			}, [layered.toString("base64"), live.toString("base64")]);
			console.log({ vue, zoom, difference, state });
			assert.ok(difference < 0.005, "Composited page matches live group/link/node ordering");
			assert.equal(await page.locator("[data-node-snapshots-links]").count(), 0, "Disabling removes layer");
			await page.evaluate(async () => test_app.ui.settings.setSettingValue("NodeSnapshot.links_enabled", true));
			await page.waitForFunction(() => document.querySelector("[data-node-snapshots-links]"));
		}
		const pan = await page.evaluate(() =>
		{
			const canvas = test_app.canvas;
			const layer = document.querySelector("[data-node-snapshots-links]");
			const bitmap = layer.lastElementChild;
			const fg_draw = canvas.ctx.drawImage, bg_draw = canvas.bgctx.drawImage;
			let copies = 0;
			canvas.ctx.drawImage = function(source, ...args)
			{
				if (source === canvas.bgcanvas) copies++;
				return fg_draw.call(this, source, ...args);
			};
			canvas.bgctx.drawImage = function(source, ...args)
			{
				if (source === bitmap) copies++;
				return bg_draw.call(this, source, ...args);
			};
			const before = NodeSnapshots.getStats().links;
			const transform = bitmap.style.transform;
			canvas.dragging_canvas = true;
			try
			{
				for (let i = 0; i < 10; i++) { canvas.ds.offset[0]++; canvas.draw(true, true); }
			}
			finally { canvas.dragging_canvas = false; canvas.ctx.drawImage = fg_draw; canvas.bgctx.drawImage = bg_draw; }
			return { copies, moved: transform !== bitmap.style.transform,
				fast: NodeSnapshots.getStats().links.pan_validation_hits - before.pan_validation_hits };
		});
		assert.equal(pan.copies, 0, "Panning copies neither the cached links nor the background into a canvas");
		assert.ok(pan.moved && pan.fast > 0, "Panning moves the compositor layer and skips redundant geometry scans");
		const fallback = await page.evaluate(() =>
		{
			const canvas = test_app.canvas;
			const before = NodeSnapshots.getStats().links;
			canvas.dragging_canvas = true;
			canvas.ds.offset[0] += 400 / canvas.ds.scale;
			for (let i = 0; i < 20; i++) canvas.draw(true, true);
			const after = NodeSnapshots.getStats().links;
			canvas.dragging_canvas = false;
			document.dispatchEvent(new PointerEvent("pointerup"));
			canvas.draw(true, true);
			return { before, after };
		});
		assert.equal(fallback.after.geometry_checks, fallback.before.geometry_checks, "Uncovered pans do not validate an unusable image");
		assert.equal(fallback.after.captures, fallback.before.captures, "Uncovered pans do not capture");
		assert.equal(fallback.after.live - fallback.before.live, 20, "Every uncovered pan frame uses native links");
		await page.waitForFunction(() => document.querySelector("[data-node-snapshots-links]"));
		await page.evaluate(() => { test_app.graph.config.links_ontop = true; test_app.canvas.draw(true, true); });
		assert.equal(await page.locator("[data-node-snapshots-links]").count(), 0, "Links-on-top uses the native layer order");
		await page.evaluate(() => { test_app.graph.config.links_ontop = false; test_app.canvas.draw(true, true); });
		await page.waitForFunction(() => document.querySelector("[data-node-snapshots-links]"));
		await page.setViewportSize({ width: 1300, height: 900 });
		await page.waitForTimeout(500);
		assert.ok(await page.evaluate(() =>
		{
			const layer = document.querySelector("[data-node-snapshots-links]");
			return layer && layer.clientWidth === test_app.canvas.canvas.clientWidth;
		}), "Layer follows canvas resize");
		await page.setViewportSize({ width: 1440, height: 1000 });
		await page.evaluate(async () => test_app.ui.settings.setSettingValue("NodeSnapshot.links_overscan_px", 512));
		await page.waitForFunction(() => document.querySelector("[data-node-snapshots-links]"));
		const overscan = await page.evaluate(() =>
		{
			const canvas = test_app.canvas;
			const bitmap = document.querySelector("[data-node-snapshots-links]").lastElementChild;
			const rect = bitmap.getBoundingClientRect(), front = canvas.canvas.getBoundingClientRect();
			const before = NodeSnapshots.getStats().links;
			canvas.dragging_canvas = true;
			canvas.ds.offset[0] += 300 / canvas.ds.scale;
			canvas.draw(true, true);
			canvas.dragging_canvas = false;
			const after = NodeSnapshots.getStats().links;
			return { margin: front.left-rect.left, before, after, width: bitmap.width, height: bitmap.height };
		});
		assert.ok(Math.abs(overscan.margin - 512) < 2, "Overscan uses CSS screen pixels at every device pixel ratio");
		assert.ok(overscan.after.layer_hits > overscan.before.layer_hits, "Larger overscan serves a 300-pixel pan from the layer");
		assert.equal(overscan.after.live, overscan.before.live);
		assert.equal(overscan.after.captures, overscan.before.captures);
		assert.ok(overscan.width <= 4096 && overscan.height <= 4096);
		assert.ok(overscan.after.pixel_bytes <= 16 * 1024 * 1024, "Half of the 32 MiB budget remains available for replacement");
		await page.evaluate(async () => test_app.ui.settings.setSettingValue("NodeSnapshot.links_overscan_px", 0));
		await page.waitForFunction(() => document.querySelector("[data-node-snapshots-links]"));
		assert.ok(await page.evaluate(() =>
		{
			const before = NodeSnapshots.getStats().links;
			test_app.canvas.draw(true, true);
			return NodeSnapshots.getStats().links.layer_hits > before.layer_hits;
		}), "Zero overscan still covers the current viewport without rounding gaps");
		await page.evaluate(async () => test_app.ui.settings.setSettingValue("NodeSnapshot.links_overscan_px", 128));

	}
	assert.deepEqual(errors, []);
	console.log("PASS: full-page compositing, group/node order, zoom, resize and cleanup in both renderers.");

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
