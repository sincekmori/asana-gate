// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

/** A counting semaphore that caps how many callers run at once. */
class Semaphore {
	private active = 0;
	private readonly waiting: ((ready: boolean) => void)[] = [];
	private readonly limit: number;

	public constructor(limit: number) {
		this.limit = Math.max(1, limit);
	}

	/**
	 * Waits for a slot and returns the function that releases it. A released
	 * slot passes straight to the longest waiter, so a caller arriving between
	 * the release and the waiter's turn cannot take it too.
	 */
	public async acquire(): Promise<() => void> {
		if (this.active >= this.limit) {
			const { promise, resolve } = Promise.withResolvers<boolean>();
			this.waiting.push(resolve);
			await promise;
		} else {
			this.active += 1;
		}
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			const next = this.waiting.shift();
			if (next === undefined) {
				this.active -= 1;
				return;
			}
			next(true);
		};
	}
}

/** Runs `task` while holding a slot of `semaphore`. */
async function withSemaphore<T>(semaphore: Semaphore, task: () => Promise<T>): Promise<T> {
	const release = await semaphore.acquire();
	try {
		return await task();
	} finally {
		release();
	}
}

/**
 * Resolves after `ms`, or rejects with the signal's reason once it aborts.
 * It runs on the global timer rather than `node:timers/promises`, so a fake
 * clock (as tests install) drives the client's waits too.
 */
function wait(ms: number, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted === true) {
		return Promise.reject(signal.reason as Error);
	}
	const { promise, resolve, reject } = Promise.withResolvers<boolean>();
	const state: { timer?: NodeJS.Timeout } = {};
	const abort = (): void => {
		clearTimeout(state.timer);
		reject(signal?.reason as Error);
	};
	state.timer = setTimeout(() => {
		signal?.removeEventListener("abort", abort);
		resolve(true);
	}, ms);
	signal?.addEventListener("abort", abort, { once: true });
	return promise;
}

export { Semaphore, wait, withSemaphore };
