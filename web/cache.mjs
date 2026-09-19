// Pixel storage only. Browser canvas/GPU bookkeeping is additional memory.
export class BitmapCache
{
	constructor(limit_bytes)
	{
		this.limit_bytes = limit_bytes;
		this.bytes = 0;
		this.entries = new Map();
	}

	get(key)
	{
		const entry = this.entries.get(key);
		if (entry)
		{
			this.entries.delete(key);
			this.entries.set(key, entry);
		}
		return entry;
	}

	delete(key)
	{
		const entry = this.entries.get(key);
		if (!entry) return;
		this.entries.delete(key);
		this.bytes -= entry.bytes;
		entry.dispose?.();
		entry.bitmap.width = 0;
		entry.bitmap.height = 0;
	}

	reserve(bytes, retained_key)
	{
		const retained_bytes = this.entries.get(retained_key)?.bytes ?? 0;
		if (bytes + retained_bytes > this.limit_bytes) return false;
		while (this.bytes + bytes > this.limit_bytes && this.entries.size)
		{
			const key = this.entries.keys().next().value;
			if (key === retained_key) this.get(key);
			else this.delete(key);
		}
		return true;
	}

	set(key, entry)
	{
		this.delete(key);
		if (!this.reserve(entry.bytes)) return false;
		this.entries.set(key, entry);
		this.bytes += entry.bytes;
		return true;
	}

	clear()
	{
		for (const key of this.entries.keys()) this.delete(key);
	}
}
