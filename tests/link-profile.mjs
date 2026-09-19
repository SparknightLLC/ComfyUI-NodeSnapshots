// Visible-browser link validation diagnostic. Uses a separate context and blocks workflow/settings writes.
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
const overscan_test = process.env.NODESNAPSHOTS_PROFILE_OVERSCAN === "1";
const test_node_ids = (process.env.NODESNAPSHOTS_TEST_NODE_IDS || "").split(",").map(Number);
if (!overscan_test && (test_node_ids.length !== 2 || test_node_ids.some((id) => !Number.isInteger(id))))
	throw new Error("Set NODESNAPSHOTS_TEST_NODE_IDS to the two comma-separated test node IDs.");
const workflow = JSON.parse(await readFile(workflow_path, "utf8"));
const web_root = fileURLToPath(new URL("../web/", import.meta.url));
const browser = await chromium.launch({ headless: false, executablePath: process.env.BROWSER_EXECUTABLE });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
let errors = 0;
const results = { workflow: basename(workflow_path), nodes: workflow.nodes.length, links: workflow.links.length,
	viewport: [1920, 1080], device_scale_factor: 1, browser: browser.version(), headless: false,
	date: new Date().toISOString(), comparison: overscan_test ? "Link overscan in a congested view; node snapshots always enabled" : "Live links, cached links, and temporary validation bypass; node snapshots always enabled", trials: [] };

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
		if (asset[1] === "links.mjs")
		{
			const source = (await readFile(file, "utf8")).replace("this.canvas = canvas;", "this.canvas = canvas; globalThis.profile_link_cache = this;");
			return route.fulfill({ body: source, contentType: "text/javascript" });
		}
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
	const page = await context.newPage();
	page.on("pageerror", (error) => { errors++; console.log(error.message); });
	await page.goto(base);
	await page.waitForFunction(() => window.NodeSnapshots && window.profile_link_cache, null, { timeout: 90000 });
	await page.evaluate(async ({ workflow, test_node_ids, overscan_test }) =>
	{
		window.bench_app = (await import("/scripts/app.js")).app;
		await bench_app.ui.settings.setSettingValue("Comfy.VueNodes.Enabled", false);
		for (const [key, value] of Object.entries({ enabled: true, links_enabled: true, mark_cached: false,
			cache_while_idle: true, idle_delay_ms: 50, slow_capture_ms: 32, capture_offscreen: false }))
			await bench_app.ui.settings.setSettingValue(`NodeSnapshot.${key}`, value);
		await bench_app.loadGraphData(workflow);
		bench_app.canvas.deselectAllNodes();
		const canvas = bench_app.canvas;
		if (overscan_test)
		{
			// Find the viewport containing the most node rectangles at a fixed zoom.
			canvas.ds.scale = 0.65;
			const width = canvas.canvas.clientWidth / canvas.ds.scale, height = canvas.canvas.clientHeight / canvas.ds.scale;
			let best = -1;
			for (const center of bench_app.graph.nodes)
			{
				const x = center.pos[0] + center.size[0]/2, y = center.pos[1] + center.size[1]/2;
				const count = bench_app.graph.nodes.filter(n => n.pos[0] < x+width/2 && n.pos[0]+n.size[0] > x-width/2
					&& n.pos[1] < y+height/2 && n.pos[1]+n.size[1] > y-height/2).length;
				if (count > best) { best = count; window.profile_camera = [width/2-x,height/2-y]; }
			}
		}
		else
		{
			const nodes = bench_app.graph.nodes.filter((n) => test_node_ids.includes(Number(n.id)));
			if (nodes.length !== 2) throw new Error("Saved test nodes not found");
			const x = (Math.min(...nodes.map(n=>n.pos[0])) + Math.max(...nodes.map(n=>n.pos[0]+n.size[0]))) / 2;
			const y = (Math.min(...nodes.map(n=>n.pos[1])) + Math.max(...nodes.map(n=>n.pos[1]+n.size[1]))) / 2;
			canvas.ds.scale = workflow.extra.ds.scale;
			window.profile_camera = [canvas.canvas.clientWidth / (2*canvas.ds.scale)-x, canvas.canvas.clientHeight/(2*canvas.ds.scale)-y];
		}
		canvas.ds.offset = [...profile_camera];
		canvas.setDirty(true,true);
		window.profile_mode = "cached";
		window.profile_times = {};
		for (const key of ["signature", "validation_signature", "safe", "show_layer", "hide_layer", "capture", "clear"])
		{
			const original = profile_link_cache[key];
			profile_link_cache[key] = function(...args)
			{
				if (profile_mode === "without_validation" && key === "signature") return this.revision;
				const start = performance.now(), layer = this.layer;
				try { return original.apply(this,args); }
				finally
				{
					const item = profile_times[key] ??= {calls:0, ms:0, max_ms:0, removals:0};
					const elapsed = performance.now()-start;
					item.calls++; item.ms+=elapsed; item.max_ms=Math.max(item.max_ms,elapsed);
					if(layer && !this.layer) item.removals++;
				}
			};
		}
	}, { workflow, test_node_ids, overscan_test });
	for (const close of await page.locator("[role='dialog'] button[aria-label='Close']").all()) await close.click();
	const cdp = await context.newCDPSession(page);
	await cdp.send("Performance.enable");
	const modes = overscan_test ? ["live", "128", "512", "1024", "1024", "512", "128", "live", "live", "128", "512", "1024"]
		: ["live", "cached", "without_validation", "without_validation", "cached", "live"];
	for (const amplitude of (overscan_test ? [300] : [60, 300])) for (const mode of modes)
	{
		await page.evaluate(async ({mode, overscan_test})=>
		{
			profile_mode="cached";
			if (overscan_test) await bench_app.ui.settings.setSettingValue("NodeSnapshot.links_overscan_px", mode === "live" ? 128 : Number(mode));
			bench_app.canvas.ds.offset=[...profile_camera];
			await bench_app.ui.settings.setSettingValue("NodeSnapshot.links_enabled", mode!=="live");
			NodeSnapshots.clearCache(); bench_app.canvas.setDirty(true,true);
		},{mode, overscan_test});
		let stable = 0, previous_captures = -1;
		const warm_start = Date.now();
		do
		{
			await page.waitForTimeout(1000);
			const stats = await page.evaluate(() => NodeSnapshots.getStats());
			const captures = stats.legacy.captures + stats.links.captures;
			stable = captures === previous_captures && !stats.legacy.pending ? stable+1 : 0;
			previous_captures = captures;
		} while (stable < 3 && Date.now()-warm_start < 45000);
		const before = await cdp.send("Performance.getMetrics");
		await page.evaluate((mode)=>
		{
			profile_mode=mode; profile_times={};
			window.profile_start=NodeSnapshots.getStats().links;
			window.profile_frames=[];
			window.profile_running=true;
			let previous;
			function frame(now)
			{
				if(previous) profile_frames.push({interval:now-previous, fps:bench_app.canvas.fps, visible:bench_app.canvas.visible_nodes.length, panning:bench_app.canvas.dragging_canvas});
				previous=now;
				if(profile_running) requestAnimationFrame(frame);
			}
			requestAnimationFrame(frame);
		},mode);
		// Real pointer input, including native drag state and dirty flags.
		await page.mouse.move(960,800); await page.mouse.down({button:"middle"});
		const start=Date.now();
		while(Date.now()-start<7000)
		{
			const phase=(Date.now()-start)/2000*Math.PI*2;
			await page.mouse.move(960+amplitude*Math.sin(phase),800+30*Math.sin(phase*2));
			await page.waitForTimeout(10);
		}
		await page.mouse.up({button:"middle"});
		const trial=await page.evaluate(()=>
		{
			profile_running=false;
			const intervals=profile_frames.map(f=>f.interval).sort((a,b)=>a-b);
			const counter=profile_frames.map(f=>f.fps).sort((a,b)=>a-b);
			return {fps:1000/(intervals.reduce((a,b)=>a+b,0)/intervals.length), frame_p95_ms:intervals[Math.floor(intervals.length*.95)],
				comfy_fps_median:counter[Math.floor(counter.length*.5)], panning_frames:profile_frames.filter(f=>f.panning).length,
				frames:intervals.length,times:profile_times,before:profile_start,after:NodeSnapshots.getStats().links,
				visible_min:Math.min(...profile_frames.map(f=>f.visible)), visible_max:Math.max(...profile_frames.map(f=>f.visible)),
				visible:bench_app.canvas.visible_nodes.map(n=>n.id),offset:[...bench_app.canvas.ds.offset]};
		});
		const after=await cdp.send("Performance.getMetrics");
		trial.browser_work = Object.fromEntries(after.metrics.filter(m=>["LayoutDuration","RecalcStyleDuration","TaskDuration"].includes(m.name))
			.map(m=>[m.name,m.value-before.metrics.find(b=>b.name===m.name).value]));
		results.trials.push({mode,amplitude,...trial});
		console.log(JSON.stringify({mode, amplitude, fps: trial.fps, comfy_fps: trial.comfy_fps_median,
			cache_share: (trial.after.hits-trial.before.hits)/((trial.after.hits-trial.before.hits)+(trial.after.live-trial.before.live)), visible: trial.visible.length, bytes: trial.before.pixel_bytes, signature: trial.times.signature, layer_removals: trial.times.hide_layer?.removals || 0}));
		await writeFile(output_path,JSON.stringify({...results,browser_errors:errors},null,2));
	}
}
finally { await browser.close(); }
