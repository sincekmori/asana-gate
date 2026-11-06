// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { messageOf } from "../log.ts";
import { AsanaApiError } from "./errors.ts";

/** Helpers of the client's Batch API handling: chunking, and joining the chunks' results. */

/** Whether a path is Asana's Batch API, however it is written. */
function isBatchPath(path: string): boolean {
	return path.replace(/^\/+/u, "").split("?")[0] === "batch";
}

/** `items` in chunks of at most `size`. */
function chunksOf<T>(items: readonly T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let start = 0; start < items.length; start += size) {
		chunks.push(items.slice(start, start + size));
	}
	return chunks;
}

/** The batch results of `count` actions whose request failed with `reason`, one per action. */
function failedActions(reason: unknown, count: number): unknown[] {
	const failure =
		reason instanceof AsanaApiError
			? { status_code: reason.status, headers: {}, body: reason.toBody() }
			: { status_code: 500, headers: {}, body: { errors: [{ message: messageOf(reason) }] } };
	return Array.from({ length: count }, () => failure);
}

/**
 * The results of every chunk in order, exactly one per action. A chunk that
 * failed while others ran answers one result per action, so the caller sees
 * which actions ran instead of one error for all of them; a chunk answered
 * with fewer results than actions (or none) fills the rest with failures, so
 * a later chunk's results never shift onto earlier actions.
 */
function joinedResults(
	settled: readonly PromiseSettledResult<{ readonly data: unknown }>[],
	chunks: readonly (readonly unknown[])[],
): unknown[] {
	return settled.flatMap((result, index): unknown[] => {
		const count = chunks[index]?.length ?? 0;
		if (result.status === "rejected") {
			return failedActions(result.reason, count);
		}
		const data: unknown[] = Array.isArray(result.value.data)
			? result.value.data.slice(0, count)
			: [];
		const missing = new Error("Asana returned no result for this action");
		return [...data, ...failedActions(missing, count - data.length)];
	});
}

export { chunksOf, isBatchPath, joinedResults };
