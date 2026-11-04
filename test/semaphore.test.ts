// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { Semaphore } from "../src/asana/semaphore.ts";

/** Acquires a slot and notes `name` in `order` once it holds it. */
async function holder(semaphore: Semaphore, name: string, order: string[]): Promise<() => void> {
	const release = await semaphore.acquire();
	order.push(name);
	return release;
}

describe("semaphore", () => {
	it("hands a released slot to the waiter, so a newcomer cannot take it too", async () => {
		const semaphore = new Semaphore(1);
		const order: string[] = [];
		const releaseA = await holder(semaphore, "a", order);
		const b = holder(semaphore, "b", order);
		releaseA();
		// Arrives after the release, before the waiter runs.
		const c = holder(semaphore, "c", order);
		const releaseB = await b;
		await Promise.resolve();
		expect(order).toStrictEqual(["a", "b"]);
		// A second release of the same slot frees nothing more.
		releaseB();
		releaseB();
		const releaseC = await c;
		const d = holder(semaphore, "d", order);
		await Promise.resolve();
		expect(order).toStrictEqual(["a", "b", "c"]);
		releaseC();
		await d;
		expect(order).toStrictEqual(["a", "b", "c", "d"]);
	});
});
