// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { setTimeout as sleep } from "node:timers/promises";

import { splitList } from "../../src/asana/query.ts";
import type { Fake } from "./gate.ts";

/** What the gate asked of Asana: one `METHOD /path` per request, in order. */
const requests = (fake: Fake): string[] =>
	fake.calls.map((call) => `${call.method} ${call.url.pathname.replace(/^\/api\/1\.0/u, "")}`);

/** The opt_fields of the first request whose path ends with `path`. */
const fieldsSentTo = (fake: Fake, path: string): string[] =>
	splitList(
		fake.calls
			.find((call) => call.url.pathname.endsWith(path))
			?.url.searchParams.get("opt_fields") ?? "",
	);

/** `fetch`, recording how many requests were in flight as each started; a path in `failing` answers 500. */
function tracked(
	fetch: typeof globalThis.fetch,
	failing: ReadonlySet<string> = new Set(),
): { fetch: typeof globalThis.fetch; concurrency: number[] } {
	const concurrency: number[] = [];
	let inFlight = 0;
	const wrapped: typeof globalThis.fetch = async (input, init) => {
		inFlight += 1;
		concurrency.push(inFlight);
		try {
			// Answer on a later turn, so requests sent together overlap.
			await sleep(1);
			const url = input instanceof Request ? input.url : input;
			const path = new URL(url).pathname.replace(/^\/api\/1\.0/u, "");
			return failing.has(path)
				? Response.json({ errors: [{ message: "Server Error" }] }, { status: 500 })
				: await fetch(input, init);
		} finally {
			inFlight -= 1;
		}
	};
	return { fetch: wrapped, concurrency };
}

/** Read everywhere, but nothing of team Design (project 23, where task 103 is also homed). */
const TEAM_POLICY = `
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { team: Design }
    deny: ["*"]
`;

/** The same tasks hidden by their project; no rule names a team. */
const PROJECT_POLICY = `
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { project: "23" }
    deny: ["*"]
`;

export { fieldsSentTo, PROJECT_POLICY, requests, TEAM_POLICY, tracked };
