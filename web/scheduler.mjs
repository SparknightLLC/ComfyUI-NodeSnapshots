export class CaptureScheduler
{
	constructor(settings, can_run)
	{
		this.settings = settings;
		this.can_run = can_run;
		this.pending = new Map();
		this.handle = null;
		this.timer = null;
		this.last_input = performance.now();
		this.stats = { batches: 0, tasks: 0, max_batch_ms: 0, overruns: 0 };
	}

	input()
	{
		this.last_input = performance.now();
	}

	add(key, task)
	{
		this.pending.set(key, task);
		this.schedule();
	}

	schedule()
	{
		if (this.handle !== null || this.timer !== null || !this.pending.size) return;
		const delay = this.settings.idle_delay_ms - (performance.now() - this.last_input);
		if (delay > 0)
		{
			this.timer = setTimeout(() => { this.timer = null; this.schedule(); }, delay + 1);
			return;
		}
		if (!this.can_run()) return;
		// No forced idle deadline: interactive work must never force a capture.
		if (typeof requestIdleCallback === "function")
		{
			this.handle = requestIdleCallback((deadline) => this.run(deadline));
		}
		else
		{
			this.handle = setTimeout(() => this.run(null), 32);
		}
	}

	run(deadline)
	{
		this.handle = null;
		if (!this.can_run() || performance.now() - this.last_input < this.settings.idle_delay_ms)
		{
			// Resume from a later live draw; do not poll while the tab is busy/hidden.
			return;
		}
		const start = performance.now();
		const budget = this.settings.capture_budget_ms;
		while (this.pending.size && performance.now() - start < budget)
		{
			if (deadline && deadline.timeRemaining() < 1) break;
			const [key, task] = this.pending.entries().next().value;
			this.pending.delete(key);
			task();
			this.stats.tasks++;
		}
		const elapsed = performance.now() - start;
		this.stats.batches++;
		this.stats.max_batch_ms = Math.max(this.stats.max_batch_ms, elapsed);
		if (elapsed > budget) this.stats.overruns++;
		this.schedule();
	}

	clear()
	{
		clearTimeout(this.timer);
		this.timer = null;
		if (this.handle !== null)
		{
			if (typeof cancelIdleCallback === "function") cancelIdleCallback(this.handle);
			else clearTimeout(this.handle);
		}
		this.handle = null;
		this.pending.clear();
	}
}
