// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { parseRetryAfter } from "../../src/asana/headers.ts";
import { wait } from "../../src/asana/semaphore.ts";

const USER_AGENT = "asana-gate docs check (+https://github.com/sincekmori/asana-gate)";

/** How often a page is asked for before it counts as unreadable, and the longest wait between two tries. */
const ATTEMPTS = 6;
const MAX_WAIT_SECONDS = 60;

/**
 * The text at `url`. The site limits how fast it is read, which a fast
 * runner exceeds, so a 429 (or a 5xx) is tried again after the wait the
 * answer names, else after 1, 2, 4… seconds. `read` is the `fetch` to use
 * (tests supply one).
 */
async function textOf(url: string, read: typeof fetch = fetch, attempt = 0): Promise<string> {
	const response = await read(url, { headers: { "user-agent": USER_AGENT } });
	if (response.ok) {
		return response.text();
	}
	const transient = response.status === 429 || response.status >= 500;
	if (!transient || attempt + 1 >= ATTEMPTS) {
		throw new Error(`HTTP ${response.status}`);
	}
	const seconds = parseRetryAfter(response.headers.get("retry-after")) ?? 2 ** attempt;
	await wait(Math.min(seconds, MAX_WAIT_SECONDS) * 1000);
	return textOf(url, read, attempt + 1);
}

export default textOf;
