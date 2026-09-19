import test from "node:test";
import assert from "node:assert/strict";
import { CaptureScheduler } from "../web/scheduler.mjs";

test("repeated draws coalesce capture tasks and clear cancels scheduled work", () =>
{
	const scheduler = new CaptureScheduler({ capture_budget_ms: 3, idle_delay_ms: 1000 }, () => true);
	let calls = 0;
	scheduler.add("node", () => calls++);
	scheduler.add("node", () => calls += 2);
	assert.equal(scheduler.pending.size, 1);
	scheduler.clear();
	assert.equal(scheduler.pending.size, 0);
	assert.equal(scheduler.timer, null);
	assert.equal(calls, 0);
});

test("input and execution prevent synchronous captures", () =>
{
	let allowed = false;
	const scheduler = new CaptureScheduler({ capture_budget_ms: 3, idle_delay_ms: 0 }, () => allowed);
	let calls = 0;
	scheduler.pending.set("node", () => calls++);
	scheduler.run(null);
	assert.equal(calls, 0);
	allowed = true;
	scheduler.settings.idle_delay_ms = 10000;
	scheduler.input();
	scheduler.run(null);
	assert.equal(calls, 0);
	scheduler.settings.idle_delay_ms = 0;
	scheduler.run(null);
	assert.equal(calls, 1);
	scheduler.clear();
});

test("yield between expensive nodes instead of consuming an entire queue", () =>
{
	const scheduler = new CaptureScheduler({ capture_budget_ms: 1, idle_delay_ms: 0 }, () => true);
	let calls = 0;
	scheduler.pending.set("slow", () =>
	{
		calls++;
		const start = performance.now();
		while (performance.now() - start < 3) { /* Simulate an indivisible native draw. */ }
	});
	scheduler.pending.set("next", () => calls++);
	scheduler.run(null);
	assert.equal(calls, 1);
	assert.equal(scheduler.pending.size, 1);
	assert.equal(scheduler.stats.overruns, 1);
	scheduler.clear();
});
