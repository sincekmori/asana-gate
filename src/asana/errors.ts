// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { isObject } from "../json.ts";

/** One entry of an Asana error response's `errors` array. */
interface AsanaErrorEntry {
	readonly message: string;
	readonly help?: string;
	readonly phrase?: string;
}

/** The messages of error entries, as one line. */
function messagesOf(entries: readonly AsanaErrorEntry[]): string {
	return entries.map((entry) => entry.message).join("; ");
}

/** The `help` text Asana attaches to its error responses. */
const ASANA_ERROR_HELP =
	"For more information on API status codes and how to handle them, read the docs on errors: https://developers.asana.com/docs/errors";

/** Details of an {@link AsanaApiError}. */
interface AsanaApiErrorDetails {
	readonly status: number;
	readonly errors: readonly AsanaErrorEntry[];
	/** The response body as Asana sent it (a 412 from the Events API carries a `sync` token in it). */
	readonly body?: unknown;
	/** Seconds to wait before retrying, from a 429 response. */
	readonly retryAfter?: number;
}

/** An error response from the Asana API (or one shaped like it). */
class AsanaApiError extends Error {
	public override readonly name: string = "AsanaApiError";
	public readonly status: number;
	public readonly errors: readonly AsanaErrorEntry[];
	public readonly body: unknown;
	public readonly retryAfter: number | undefined;

	public constructor(details: AsanaApiErrorDetails) {
		super(`Asana API responded ${details.status}: ${messagesOf(details.errors) || "(no message)"}`);
		this.status = details.status;
		this.errors = details.errors;
		this.body = details.body;
		this.retryAfter = details.retryAfter;
	}

	/** The response body, as Asana sent it (or reconstructed from the entries). */
	public toBody(): Record<string, unknown> {
		return isObject(this.body) ? { ...this.body } : { errors: this.errors.map((e) => ({ ...e })) };
	}
}

/** Parses an error response body into entries, tolerating non-JSON bodies. */
function parseErrorEntries(body: unknown, status: number): AsanaErrorEntry[] {
	const raw = isObject(body) && Array.isArray(body.errors) ? body.errors : [];
	const entries = raw
		.filter((e) => isObject(e))
		.map((e) => ({
			message: typeof e.message === "string" ? e.message : `HTTP ${status}`,
			...(typeof e.help === "string" && { help: e.help }),
			...(typeof e.phrase === "string" && { phrase: e.phrase }),
		}));
	return entries.length > 0 ? entries : [{ message: `HTTP ${status}` }];
}

/** What Asana answers for an object that does not exist, has a malformed gid, or that the token cannot read. */
const ABSENT_STATUSES: ReadonlySet<number> = new Set([400, 403, 404]);

/**
 * Whether an error means the object is absent rather than that the request
 * failed: a rate limit, an expired token or a server error is not absence,
 * and treating it so would change what the policy decides.
 */
function isAbsent(error: unknown): error is AsanaApiError {
	return error instanceof AsanaApiError && ABSENT_STATUSES.has(error.status);
}

export { ASANA_ERROR_HELP, AsanaApiError, isAbsent, messagesOf, parseErrorEntries };
export type { AsanaApiErrorDetails, AsanaErrorEntry };
