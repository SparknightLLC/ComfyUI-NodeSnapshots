import test from "node:test";
import assert from "node:assert/strict";
import { LegacyCache, node_signature } from "../web/legacy.mjs";

function classic_canvas(settings, canvas)
{
	globalThis.window = { LiteGraph: { vueNodesMode: false } };
	globalThis.LiteGraph = { ROUND_RADIUS: 8 };
	const cache = Object.create(LegacyCache.prototype);
	cache.settings = settings;
	cache.canvas = canvas;
	cache.saved_shadows = true;
	cache.shadows_applied = false;
	cache.saved_round_radius = 8;
	cache.corners_applied = false;
	return cache;
}

test("classic canvas shadows and corners follow the appearance settings", () =>
{
	const settings = { enabled: true, no_shadows: true, square_corners: true };
	const canvas = { render_shadows: true, setDirty() { this.redraws = (this.redraws ?? 0) + 1; } };
	const cache = classic_canvas(settings, canvas);
	cache.apply_appearance();
	assert.equal(canvas.render_shadows, false);
	assert.equal(LiteGraph.ROUND_RADIUS, 0);
	assert.equal(canvas.redraws, 1);

	// While a setting owns the flag, another writer cannot leave it changed.
	canvas.render_shadows = true;
	cache.apply_appearance();
	assert.equal(canvas.render_shadows, false);

	settings.enabled = false;
	cache.apply_appearance();
	assert.equal(canvas.render_shadows, true, "The replaced shadow value is restored");
	assert.equal(LiteGraph.ROUND_RADIUS, 8, "The replaced radius is restored");
});

test("flags another extension already set are left as they were", () =>
{
	const settings = { enabled: true, no_shadows: true, square_corners: true };
	const canvas = { render_shadows: false, setDirty() {} };
	const cache = classic_canvas(settings, canvas);
	LiteGraph.ROUND_RADIUS = 0;
	cache.apply_appearance();
	settings.no_shadows = false;
	settings.square_corners = false;
	cache.apply_appearance();
	assert.equal(canvas.render_shadows, false, "KJNodes' disabled shadows stay disabled");
	assert.equal(LiteGraph.ROUND_RADIUS, 0, "KJNodes' square corners stay square");
});

test("Nodes 2.0 nodes keep their canvas flags untouched", () =>
{
	const settings = { enabled: true, no_shadows: true, square_corners: true };
	const canvas = { render_shadows: true, setDirty() {} };
	const cache = classic_canvas(settings, canvas);
	window.LiteGraph.vueNodesMode = true;
	cache.apply_appearance();
	assert.equal(canvas.render_shadows, true);
	assert.equal(LiteGraph.ROUND_RADIUS, 8);
});

test("stored images follow the canvas corner radius", () =>
{
	const node = { title: "Test", size: [300, 200], widgets: [{ value: 512 }] };
	const canvas = { editor_alpha: 1, render_shadows: true, round_radius: 8 };
	const rounded = node_signature(node, canvas);
	canvas.round_radius = 0;
	assert.notEqual(node_signature(node, canvas), rounded);
});
