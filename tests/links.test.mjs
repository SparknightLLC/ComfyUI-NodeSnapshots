import test from "node:test";
import assert from "node:assert/strict";
import { LinkCache } from "../web/links.mjs";

function fixture()
{
	globalThis.LiteGraph = { vueNodesMode: false, HIDDEN_LINK: -1, getTime: () => 2000 };
	const cache = Object.create(LinkCache.prototype);
	const node = { id: 1, pos: [0, 0], size: [200, 100], flags: {}, mode: 0,
		inputs: [{ link: 1, pos: [0, 30] }], outputs: [] };
	cache.canvas = { graph: { _version: 1, nodes: [node], links: new Map([[1, { id: 1, origin_id: 2, target_id: 1 }]]) },
		setDirty() {}, constructor: { link_type_colors: { MODEL: "red" } } };
	cache.signature_values = []; cache.revision = 0;
	return cache;
}

test("link validation retains images through pan/zoom but detects direct geometry and palette edits", () =>
{
	const cache = fixture();
	const initial = cache.signature();
	cache.canvas.ds = { scale: 2, offset: [100, 200] };
	assert.equal(cache.signature(), initial);
	for (const mutate of [
		() => cache.canvas.graph.nodes[0].pos[0]++,
		() => cache.canvas.graph.nodes[0].inputs[0].pos[1]++,
		() => cache.canvas.graph.nodes[0].size[1]++,
		() => cache.canvas.graph.links.get(1).target_slot = 3,
		() => cache.canvas.constructor.link_type_colors.MODEL = "blue",
		() => cache.canvas.graph.nodes[0].inputs.push({ link: 2 }),
		() => cache.canvas.graph.nodes[0].inputs.pop(),
		() => LiteGraph.vueNodesMode = true
	])
	{
		const before = cache.signature(); mutate();
		const after = cache.signature();
		assert.notEqual(after, before);
		assert.equal(cache.signature(), after);
	}
});

test("hidden links clear native hit paths without validating or capturing geometry", () =>
{
	const cache = fixture();
	cache.settings = { enabled: true, links_enabled: true };
	globalThis.document = { hidden: false };
	cache.is_executing = () => false;
	cache.canvas.links_render_mode = -1;
	cache.scheduler = { clear() {} };
	cache.stats = { live: 0 };
	cache.signature = () => assert.fail("Hidden links must not inspect geometry");
	let calls = 0;
	cache.original = () => calls++;
	cache.draw({}, []);
	assert.equal(calls, 1);
	assert.equal(cache.entry, null);
	assert.equal(cache.signature_values.length, 0);
});

test("pointer release preserves an existing image; editing still clears it", () =>
{
	const cache = fixture();
	cache.scheduler = { input() {}, clear() {} };
	cache.entry = { bitmap: { width: 100, height: 100 } };
	cache.input({ type: "pointerup" });
	assert.equal(cache.entry.bitmap.width, 100);
	cache.input({ type: "input" });
	assert.equal(cache.entry, null);
});


test("panning skips repeated geometry scans, rechecks revisions immediately and polls unreported edits", () =>
{
	const cache = fixture();
	cache.stats = { geometry_checks: 0, pan_validation_hits: 0 };
	cache.canvas.dragging_canvas = true;
	const initial = cache.validation_signature();
	assert.equal(cache.validation_signature(), initial);
	assert.equal(cache.stats.geometry_checks, 1);
	assert.equal(cache.stats.pan_validation_hits, 1);
	cache.canvas.graph._version++;
	assert.notEqual(cache.validation_signature(), initial);
	const styled = cache.revision;
	cache.canvas.connections_width = 7;
	assert.notEqual(cache.validation_signature(), styled);
	const revision = cache.revision;
	cache.canvas.graph.nodes[0].pos[0]++;
	assert.equal(cache.validation_signature(), revision);
	cache.validation_time = performance.now() - 101;
	assert.notEqual(cache.validation_signature(), revision);
	const next = cache.revision;
	cache.canvas.graph.nodes[0].pos[0]++;
	cache.canvas.dragging_canvas = false;
	assert.notEqual(cache.validation_signature(), next);
});


test("live fallback during panning neither scans geometry nor queues a capture", () =>
{
	const cache = fixture();
	cache.stats = { live: 0 };
	cache.safe = () => true;
	cache.canvas.dragging_canvas = true;
	cache.canvas.visible_area = [500, 0, 100, 100];
	cache.scheduler = { clear() {}, add() { assert.fail("No captures while panning"); } };
	cache.signature = () => assert.fail("Live links need no cache signature");
	cache.validation_signature = cache.signature;
	let draws = 0;
	cache.original = () => draws++;
	const ctx = { getTransform: () => ({ a: 1, d: 1, e: 0, f: 0 }) };
	// The first frame leaves the bounded bitmap. Later frames have no bitmap.
	cache.entry = { graph: cache.canvas.graph, x: 0, y: 0, width: 100, height: 100,
		bitmap: { width: 100, height: 100 } };
	for (let i = 0; i < 20; i++) cache.draw(ctx, []);
	assert.equal(draws, 20);
	cache.canvas.dragging_canvas = false;
	cache.canvas.pointer = { isDown: true };
	cache.draw(ctx, []);
	assert.equal(draws, 21);
	assert.equal(cache.entry, null);
});


test("idle links render natively while retaining a valid image for the next pan", () =>
{
	const cache = fixture();
	cache.settings = { links_cache_while_idle: false, cache_while_idle: true };
	cache.stats = { live: 0, hits: 0, layer_hits: 0, geometry_checks: 0, pan_validation_hits: 0 };
	cache.safe = () => true;
	cache.canvas.visible_area = [0, 0, 50, 50];
	cache.entry = { graph: cache.canvas.graph, signature: cache.signature(), x: -100, y: -100, width: 300, height: 300 };
	const entry = cache.entry;
	let live = 0;
	cache.original = () => live++;
	cache.show_layer = () => true;
	const ctx = { getTransform: () => ({ a: 1, d: 1, e: 0, f: 0 }) };
	cache.draw(ctx, []);
	assert.equal(live, 1);
	assert.equal(cache.entry, entry);
	cache.canvas.dragging_canvas = true;
	cache.draw(ctx, []);
	assert.equal(cache.stats.layer_hits, 1);
	assert.equal(live, 1);
	cache.canvas.dragging_canvas = false;
	cache.settings.links_cache_while_idle = true;
	cache.settings.cache_while_idle = false;
	cache.draw(ctx, []);
	assert.equal(cache.stats.layer_hits, 2, "Link idle display is independent of the node setting");
});
