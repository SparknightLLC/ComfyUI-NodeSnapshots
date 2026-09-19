// Local browser benchmark. Workflow/settings writes and non-local requests are blocked.
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, basename } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.NODESNAPSHOTS_TEST_URL;
const workflow_path = process.env.NODESNAPSHOTS_WORKFLOW;
const output_path = process.env.NODESNAPSHOTS_RESULTS;
if (!base || !workflow_path || !output_path) throw new Error("Set NODESNAPSHOTS_TEST_URL, NODESNAPSHOTS_WORKFLOW and NODESNAPSHOTS_RESULTS.");
const links_only = process.env.NODESNAPSHOTS_LINKS_ONLY === "1";
const workflow = JSON.parse(await readFile(workflow_path, "utf8"));
const web_root = fileURLToPath(new URL("../web/", import.meta.url));
const browser = await chromium.launch({ headless: false, executablePath: process.env.BROWSER_EXECUTABLE });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
let errors = 0;
const results = { workflow: basename(workflow_path), nodes: workflow.nodes.length, links: workflow.links.length,
	viewport: [1920, 1080], device_scale_factor: 1, browser: browser.version(), headless: false,
	date: new Date().toISOString(), comparison: links_only ? "Link snapshots only; node snapshots always enabled" : "Entire extension", trials: [] };

await context.route("**/*", async (route) =>
{
	const request = route.request();
	const url = new URL(request.url());
	if (url.origin !== new URL(base).origin) return route.abort();
	if (!["GET", "HEAD"].includes(request.method()))
		return route.fulfill({ status: url.pathname === "/prompt" ? 403 : 200, contentType: "application/json", body: "{}" });
	// Serve the renamed assets even if the running server registered the old folder.
	const asset = url.pathname.match(/^\/extensions\/ComfyUI-NodeSnapshots?\/([^/]+)$/);
	if (asset)
	{
		const file = resolve(web_root, asset[1]);
		if (!file.startsWith(web_root)) return route.abort();
		return route.fulfill({ path: file, contentType: file.endsWith(".svg") ? "image/svg+xml" : "text/javascript" });
	}
	if (["/extensions", "/api/extensions"].includes(url.pathname))
	{
		const response = await route.fetch();
		const extensions = await response.json();
		results.extension_count = extensions.length;
		return route.fulfill({ response, json: extensions.map((path) => path.replace("/ComfyUI-NodeSnapshot/", "/ComfyUI-NodeSnapshots/")) });
	}
	return route.continue();
});

try
{
	for (const vue of [false, true])
	{
		const page = await context.newPage();
		page.on("pageerror", () => errors++);
		await page.goto(base);
		await page.waitForFunction(() => window.NodeSnapshots && window.comfyAPI?.app?.app?.canvas, null, { timeout: 90000 });
		await page.evaluate(async ({ workflow, vue }) =>
		{
			window.bench_app = (await import("/scripts/app.js")).app;
			await bench_app.ui.settings.setSettingValue("Comfy.VueNodes.Enabled", vue);
			const settings = { enabled: false, legacy_enabled: true, cache_while_idle: true, memory_mb: 256,
				capture_budget_ms: 3, idle_delay_ms: 50, slow_capture_ms: 32, max_dimension: 2048, pixel_ratio: 2,
				max_age_ms: 0, mark_cached: false, exclude_pinned: false, excluded_types: "", capture_offscreen: false,
				links_enabled: true, links_memory_mb: 32, links_overscan_px: 512, links_cache_while_idle: false, vue_enabled: true, vue_cache_enabled: true, vue_shadows: false };
			for (const [key, value] of Object.entries(settings)) await bench_app.ui.settings.setSettingValue(`NodeSnapshot.${key}`, value);
			await bench_app.loadGraphData(workflow);
			bench_app.canvas.deselectAllNodes();
		}, { workflow, vue });
		await page.waitForTimeout(3000);
		const environment = await page.evaluate(() =>
		{
			const gl = document.createElement("canvas").getContext("webgl");
			const debug = gl?.getExtension("WEBGL_debug_renderer_info");
			return { nodes: bench_app.graph.nodes.length, links: bench_app.graph.links.size,
				missing_nodes: bench_app.graph.nodes.filter((node) => !LiteGraph.registered_node_types[node.type] && !node.isSubgraphNode?.()).map((node) => node.type),
				gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
				reroutes: bench_app.graph.reroutes.size, floating_links: bench_app.graph.floatingLinks.size,
				canvas: [bench_app.canvas.canvas.width, bench_app.canvas.canvas.height] };
		});
		console.log(vue ? "Nodes 2.0" : "Legacy", environment);
		results[vue ? "vue_environment" : "legacy_environment"] = environment;
		if (environment.nodes !== workflow.nodes.length) throw new Error("Workflow node count changed.");
		for (const close of await page.locator("[role='dialog'] button[aria-label='Close']").all()) await close.click();
		await page.screenshot({ path: output_path + (vue ? ".vue.png" : ".legacy.png") });
		for (const view of (links_only ? ["dense"] : ["dense", "overview"]))
		{
			const camera = await page.evaluate(({ view, saved }) =>
			{
				const canvas = bench_app.canvas;
				let scale = saved.scale, offset = saved.offset;
				if (view === "dense")
				{
					scale = 0.65;
					const width = canvas.canvas.clientWidth/scale, height = canvas.canvas.clientHeight/scale;
					let best = -1;
					for (const center of bench_app.graph.nodes)
					{
						const x = center.pos[0]+center.size[0]/2, y = center.pos[1]+center.size[1]/2;
						const count = bench_app.graph.nodes.filter(n => n.pos[0] < x+width/2 && n.pos[0]+n.size[0] > x-width/2
							&& n.pos[1] < y+height/2 && n.pos[1]+n.size[1] > y-height/2).length;
						if (count > best) { best = count; offset = [width/2-x,height/2-y]; }
					}
				}
				if (view === "overview")
				{
					const nodes = bench_app.graph.nodes;
					const left = Math.min(...nodes.map((node) => node.pos[0]));
					const top = Math.min(...nodes.map((node) => node.pos[1] - 40));
					const right = Math.max(...nodes.map((node) => node.pos[0] + node.size[0]));
					const bottom = Math.max(...nodes.map((node) => node.pos[1] + node.size[1]));
					scale = Math.min((canvas.canvas.width - 160) / (right - left), (canvas.canvas.height - 160) / (bottom - top));
					offset = [canvas.canvas.width / (2 * scale) - (left + right) / 2, canvas.canvas.height / (2 * scale) - (top + bottom) / 2];
				}
				canvas.ds.scale = scale; canvas.ds.offset = [...offset]; canvas.setDirty(true, true);
				return { scale, offset: [...offset] };
			}, { view, saved: workflow.extra.ds });
			// Alternating order limits a consistent warm-browser/order advantage.
			for (const enabled of [false, true, true, false, false, true])
			{
				await page.evaluate(async ({ enabled, camera, links_only }) =>
				{
					bench_app.canvas.ds.scale = camera.scale; bench_app.canvas.ds.offset = [...camera.offset];
					await bench_app.ui.settings.setSettingValue("NodeSnapshot.enabled", links_only || enabled);
					if (links_only) await bench_app.ui.settings.setSettingValue("NodeSnapshot.links_enabled", enabled);
					NodeSnapshots.clearCache(); bench_app.canvas.setDirty(true, true);
				}, { enabled, camera, links_only });
				const warm_start = Date.now();
				let stable = 0, last_captures = -1, first_capture_ms = null;
				while (Date.now() - warm_start < (enabled || links_only ? 45000 : 2000))
				{
					await page.waitForTimeout(1000);
					const stats = await page.evaluate(() => NodeSnapshots.getStats());
					if (stats.bitmap_count && first_capture_ms === null) first_capture_ms = Date.now() - warm_start;
					const count = stats.legacy.captures + stats.vue.captures + stats.links.captures;
					stable = count === last_captures ? stable + 1 : 0; last_captures = count;
					if ((enabled || links_only) && stable >= 3 && !stats.vue.pending_capture && !stats.legacy.pending) break;
				}
				const warm_ms = Date.now() - warm_start;
				await page.evaluate(() =>
				{
					const canvas = bench_app.canvas;
					window.bench_measure = { before: NodeSnapshots.getStats(), original: canvas.draw,
						draw_times: [], intervals: [], fps: [], visible: [], running: true };
					canvas.draw = function(...args)
					{
						const start = performance.now();
						try { return bench_measure.original.apply(this, args); }
						finally { bench_measure.draw_times.push(performance.now()-start); }
					};
					let previous;
					function frame(now)
					{
						if (previous) bench_measure.intervals.push(now-previous);
						previous=now;
						bench_measure.fps.push(canvas.fps);
						bench_measure.visible.push(canvas.visible_nodes.length);
						if (bench_measure.running) requestAnimationFrame(frame);
					}
					requestAnimationFrame(frame);
				});
				await page.mouse.move(960,800);
				await page.mouse.down({button: "middle"});
				const pan_start = Date.now();
				while (Date.now()-pan_start < 7000)
				{
					const phase=(Date.now()-pan_start)/2000*Math.PI*2;
					await page.mouse.move(960+300*Math.sin(phase),800+30*Math.sin(phase*2));
					await page.waitForTimeout(10);
				}
				await page.mouse.up({button: "middle"});
				const trial = await page.evaluate(() =>
				{
					const m = bench_measure;
					m.running=false; bench_app.canvas.draw=m.original;
					const mean = values => values.reduce((a,b)=>a+b,0)/values.length;
					const percentile = (values,fraction) => [...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*fraction))];
					return {fps:1000/mean(m.intervals), comfy_fps_median:percentile(m.fps,.5), frame_mean_ms:mean(m.intervals),
						frame_p95_ms:percentile(m.intervals,.95),draw_mean_ms:mean(m.draw_times),draw_p95_ms:percentile(m.draw_times,.95),
						frames:m.intervals.length,frames_over_33ms:m.intervals.filter(ms=>ms>33.34).length,
						before:m.before,after:NodeSnapshots.getStats(),visible_nodes:bench_app.canvas.visible_nodes.length,
						visible_min:Math.min(...m.visible),visible_max:Math.max(...m.visible)};
				});
				const result = { renderer: vue ? "Nodes 2.0" : "Legacy", view, enabled, camera, warm_ms, first_capture_ms, ...trial };
				results.trials.push(result);
				console.log(JSON.stringify({ renderer: result.renderer, view, enabled, fps: trial.fps, draw_ms: trial.draw_mean_ms,
					warm_ms, bitmaps: trial.before.bitmap_count, visible: trial.visible_nodes, link_hits: trial.after.links.hits - trial.before.links.hits }));
				await writeFile(output_path, JSON.stringify({ ...results, browser_errors: errors }, null, 2));
			}
		}
		await page.close();
	}
}
finally { await browser.close(); }
