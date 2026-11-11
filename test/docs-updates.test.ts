// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import textOf from "../scripts/docs-updates/fetch.ts";
import { pagesOf, render, titleOf, updatedAtOf } from "../scripts/docs-updates/parse.ts";

const INDEX = `# Asana Docs
- [Agents](https://developers.asana.com/reference/agents.md)
  - [Get agents](https://developers.asana.com/reference/getagentsforworkspace.md): list
- [Deprecations](https://developers.asana.com/docs/deprecations.md)
- [Agents again](https://developers.asana.com/reference/agents.md)
- [Elsewhere](https://example.com/reference/other.md)
`;

const PAGE = `---
updatedAt: 2026-05-20T19:54:10.000Z
agentTools:
  projectIndex: https://developers.asana.com/llms.txt
---

# Get a list of agents in a workspace

Returns the compact records of agents.

# OpenAPI definition
`;

/** A fetch that answers each call with the next status, the last one from then on. */
const answering = (...statuses: number[]): ReturnType<typeof vi.fn<typeof globalThis.fetch>> => {
	const queue = [...statuses];
	return vi.fn<typeof globalThis.fetch>(() => {
		const status = queue.length > 1 ? queue.shift() : queue[0];
		return Promise.resolve(new Response("page", { status, headers: { "retry-after": "0" } }));
	});
};

describe("reading a docs page", () => {
	it("tries again when the site limits the rate or fails, and gives up on anything else", async () => {
		const limited = answering(429, 503, 200);
		await expect(textOf("https://x/a.md", limited)).resolves.toBe("page");
		expect(limited).toHaveBeenCalledTimes(3);
		const missing = answering(404);
		await expect(textOf("https://x/b.md", missing)).rejects.toThrow("HTTP 404");
		expect(missing).toHaveBeenCalledOnce();
	});

	it("stops after a bounded number of tries", async () => {
		const always = answering(429);
		await expect(textOf("https://x/c.md", always)).rejects.toThrow("HTTP 429");
		expect(always).toHaveBeenCalledTimes(6);
	});
});

describe("docs updates", () => {
	it("lists the pages an index links to, once each, on this site only", () => {
		expect(pagesOf(INDEX)).toStrictEqual([
			"https://developers.asana.com/reference/agents.md",
			"https://developers.asana.com/reference/getagentsforworkspace.md",
			"https://developers.asana.com/docs/deprecations.md",
		]);
	});

	it("reads a page's title and update time from its front matter", () => {
		expect(titleOf(PAGE, "u")).toBe("Get a list of agents in a workspace");
		expect(updatedAtOf(PAGE)).toStrictEqual(new Date("2026-05-20T19:54:10.000Z"));
		expect(
			updatedAtOf("# No front matter\n\nupdatedAt: 2026-05-20T19:54:10.000Z\n"),
		).toBeUndefined();
		expect(updatedAtOf("---\nupdatedAt: yesterday\n---\n# Title\n")).toBeUndefined();
	});

	it("renders the pages updated since a time, newest first, with the unreadable and undated ones", () => {
		const since = new Date("2026-11-01T00:00:00.000Z");
		const text = render(
			[
				{ url: "https://x/old.md", title: "Old", updatedAt: new Date("2026-10-01T00:00:00.000Z") },
				{ url: "https://x/a.md", title: "A", updatedAt: new Date("2026-11-02T00:00:00.000Z") },
				{ url: "https://x/b.md", title: "B", updatedAt: new Date("2026-11-03T12:00:00.000Z") },
				{ url: "https://x/gone.md", title: "https://x/gone.md", problem: "HTTP 404" },
				{ url: "https://x/undated.md", title: "Undated" },
			],
			since,
		);
		expect(text).toBe(
			[
				"Pages of developers.asana.com updated since 2026-11-01T00:00:00.000Z:",
				"- 2026-11-03 [B](https://x/b.md)",
				"- 2026-11-02 [A](https://x/a.md)",
				"",
				"Pages that could not be read:",
				"- [https://x/gone.md](https://x/gone.md): HTTP 404",
				"",
				"Pages whose front matter names no update time:",
				"- [Undated](https://x/undated.md)",
				"",
			].join("\n"),
		);
		expect(render([{ url: "https://x/old.md", title: "Old", updatedAt: new Date(0) }], since)).toBe(
			"",
		);
	});
});
