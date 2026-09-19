import test from "node:test";
import assert from "node:assert/strict";
import { LegacyCache, node_signature } from "../web/legacy.mjs";

test("viewport zoom, LOD, position, hover, and selection preserve node images", () =>
{
	const node = { title: "Test", pos: [10, 20], size: [300, 200], flags: {}, widgets: [{ value: 512 }] };
	const canvas = { ds: { scale: 1 }, low_quality: false, editor_alpha: 1 };
	const before = node_signature(node, canvas);
	node.pos = [5000, 8000];
	node.selected = true;
	node.mouseOver = true;
	canvas.ds.scale = 0.1;
	canvas.low_quality = true;
	assert.equal(node_signature(node, canvas), before);
});

test("appearance, size, and widget changes still invalidate individual nodes", () =>
{
	const node = { title: "Test", size: [300, 200], widgets: [{ value: 512 }], inputs: [{ name: "image", link: null }] };
	const canvas = { editor_alpha: 1 };
	let previous = node_signature(node, canvas);
	for (const change of [() => node.size[0]++, () => node.widgets[0].value++, () => node.inputs[0].link = 42,
		() => node.title = "Changed", () => canvas.editor_alpha = 0.5])
	{
		change();
		const next = node_signature(node, canvas);
		assert.notEqual(next, previous);
		previous = next;
	}
});

test("DOM and object-valued widgets remain live", () =>
{
	assert.equal(node_signature({ widgets: [{ element: {} }] }, {}), null);
	assert.equal(node_signature({ widgets: [{ value: { animated: true } }] }, {}), null);
});

test("collapsed nodes do not inspect invisible DOM or object-valued widgets", () =>
{
	const node = { title: "Note", flags: { collapsed: true }, widgets: [{ element: {}, value: "text" }] };
	const before = node_signature(node, {});
	assert.equal(typeof before, "string");
	node.widgets[0].value = { data: "hidden" };
	assert.equal(node_signature(node, {}), before);
	node.flags.collapsed = false;
	assert.equal(node_signature(node, {}), null);
});

test("panning reuses a node measurement until the graph revision changes", () =>
{
	const cache = Object.create(LegacyCache.prototype);
	const node = { title: "Test", size: [300, 200], widgets: [{ value: 512 }] };
	cache.canvas = { ds: { scale: 1 }, graph: { _version: 1 }, editor_alpha: 1 };
	cache.recent = new WeakMap();
	cache.stats = { reused_signatures: 0 };
	cache.is_interacting = () => true;
	const measured = cache.measured_signature(node);
	assert.equal(cache.measured_signature(node), measured);
	assert.equal(cache.stats.reused_signatures, 1);
	node.widgets[0].value++;
	cache.canvas.graph._version++;
	assert.notEqual(cache.measured_signature(node), measured);
	cache.is_interacting = () => false;
	const idle = cache.measured_signature(node);
	node.widgets[0].value++;
	assert.notEqual(cache.measured_signature(node), idle);
});

test("executing nodes stay live so progress bars are never baked into images", () =>
{
	const cache = Object.create(LegacyCache.prototype);
	cache.canvas = {};
	assert.equal(cache.needs_live({ progress: 0 }), true);
	assert.equal(cache.needs_live({ progress: 0.5 }), true);
	assert.equal(cache.needs_live({ progress: undefined }), false);
	assert.equal(cache.needs_live({ has_errors: true }), true);
});
