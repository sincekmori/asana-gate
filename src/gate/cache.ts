// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

/** One cached value and when it stops being valid. */
interface CacheEntry<V> {
	readonly value: V;
	readonly expires: number;
}

/** Expired entries are swept once the cache holds this many, then at twice its size after each sweep. */
const SWEEP_AT = 256;

/** A small in-memory cache whose entries expire after the cache's time to live, or their own. */
class TtlCache<V> {
	private readonly entries = new Map<string, CacheEntry<V>>();
	private readonly ttlMs: number;
	private sweepAt = SWEEP_AT;

	public constructor(ttlMs: number) {
		this.ttlMs = ttlMs;
	}

	public get(key: string): V | undefined {
		const entry = this.entries.get(key);
		if (entry === undefined) {
			return undefined;
		}
		if (entry.expires <= Date.now()) {
			this.entries.delete(key);
			return undefined;
		}
		return entry.value;
	}

	public set(key: string, value: V, ttlMs: number = this.ttlMs): void {
		this.entries.set(key, { value, expires: Date.now() + ttlMs });
		if (this.entries.size >= this.sweepAt) {
			this.sweep();
		}
	}

	public delete(key: string): void {
		this.entries.delete(key);
	}

	/** Deletes every entry `drop` selects; resolves to their keys. */
	public deleteWhere(drop: (key: string, value: V) => boolean): string[] {
		const keys: string[] = [];
		// Deleting the entry being visited does not disturb a Map's iteration.
		for (const [key, entry] of this.entries) {
			if (drop(key, entry.value)) {
				this.entries.delete(key);
				keys.push(key);
			}
		}
		return keys;
	}

	/** Drops every expired entry, so a long-running cache does not keep what nobody reads again. */
	private sweep(): void {
		const now = Date.now();
		for (const [key, entry] of this.entries) {
			if (entry.expires <= now) {
				this.entries.delete(key);
			}
		}
		this.sweepAt = Math.max(SWEEP_AT, this.entries.size * 2);
	}
}

export { TtlCache };
export type { CacheEntry };
