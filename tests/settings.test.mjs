import test from "node:test";
import assert from "node:assert/strict";
import { install_settings } from "../web/settings.mjs";

test("requested defaults and Debug grouping preserve saved user values", async () =>
{
	const registered = new Map();
	const settings = await install_settings({ ui: { settings: {
		getSettingValue: (id, fallback) => id === "NodeSnapshot.pixel_ratio" ? 0.5 : fallback,
		addSetting: (setting) => registered.set(setting.id, setting)
	} } }, () => {});
	assert.equal(settings.memory_mb, 256);
	assert.equal(settings.links_overscan_px, 512);
	registered.get("NodeSnapshot.links_overscan_px").onChange(1024);
	assert.equal(settings.links_overscan_px, 1024);
	assert.equal(settings.cache_while_idle, true);
	assert.equal(settings.links_cache_while_idle, false);
	assert.equal(registered.get("NodeSnapshot.cache_while_idle").name, "Show node snapshots while idle");
	assert.equal(settings.exclude_pinned, false);
	assert.equal(settings.release_while_executing, false);
	assert.equal(settings.slow_capture_ms, 32);
	assert.equal(settings.idle_delay_ms, 50);
	assert.equal(settings.max_age_ms, 0);
	assert.equal(settings.vue_shadows, false);
	assert.equal(settings.pixel_ratio, 0.5);
	assert.equal(registered.get("NodeSnapshot.diagnostics").category[1], "Debug");
	registered.get("NodeSnapshot.pixel_ratio").onChange(0.75);
	assert.equal(settings.pixel_ratio, 0.75);
});
