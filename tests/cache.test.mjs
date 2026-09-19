import test from "node:test";
import assert from "node:assert/strict";
import { BitmapCache } from "../web/cache.mjs";

function entry(bytes)
{
	return { bytes, bitmap: { width: 10, height: 10 } };
}

test("eviction respects recent use and releases bitmap backing storage", () =>
{
	const cache = new BitmapCache(100);
	const first = entry(40);
	const second = entry(40);
	cache.set("first", first);
	cache.set("second", second);
	cache.get("first");
	assert.equal(cache.reserve(50), true);
	assert.equal(second.bitmap.width, 0);
	assert.equal(cache.get("first"), first);
	assert.equal(cache.bytes, 40);
	cache.set("third", entry(50));
	assert.equal(cache.bytes, 90);
	cache.clear();
	assert.equal(first.bitmap.width, 0);
	assert.equal(cache.bytes, 0);
});

test("oversized captures are rejected without evicting useful images", () =>
{
	const cache = new BitmapCache(100);
	cache.set("first", entry(80));
	assert.equal(cache.reserve(101), false);
	assert.equal(cache.bytes, 80);
	assert.equal(cache.entries.size, 1);
});

test("replacing a node accounts for exactly one image", () =>
{
	const cache = new BitmapCache(100);
	const old = entry(60);
	cache.set("node", old);
	cache.set("node", entry(40));
	assert.equal(cache.bytes, 40);
	assert.equal(old.bitmap.height, 0);
});

test("idle refresh retains the usable image and budgets both generations", () =>
{
	const cache = new BitmapCache(100);
	const old = entry(40);
	cache.set("refreshing", old);
	cache.set("other", entry(40));
	assert.equal(cache.reserve(40, "refreshing"), true);
	assert.equal(cache.entries.get("refreshing"), old);
	assert.equal(cache.entries.has("other"), false);
	assert.equal(old.bitmap.width, 10);
	assert.equal(cache.reserve(61, "refreshing"), false);
	assert.equal(old.bitmap.width, 10);
	cache.set("refreshing", entry(40));
	assert.equal(old.bitmap.width, 0);
	assert.equal(cache.bytes, 40);
});
