// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

// Lists the pages of developers.asana.com updated within the last days, read
// from the `updatedAt` front matter of the Markdown source each page serves
// (`<page>.md`). The OpenAPI definition carries no wording, so an early-access
// endpoint's opt-in flag, a deprecation the definition does not mark or an
// access restriction appears only on those pages; the weekly workflow lists
// what changed, and a person reads it.
//
//   node scripts/docs-updates.ts [--days 7]

import { parseArgs } from "node:util";

import { Semaphore } from "../src/asana/semaphore.ts";
import { messageOf } from "../src/message.ts";
import textOf from "./docs-updates/fetch.ts";
import { type Page, pagesOf, render, titleOf, updatedAtOf } from "./docs-updates/parse.ts";

const INDEX = "https://developers.asana.com/llms.txt";
const DAY_MS = 86_400_000;

/** Pages in flight at once: few, since the site limits how fast it is read. */
const inFlight = new Semaphore(4);

/** A page with its update time; one that cannot be read is reported as such rather than silently missing. */
async function pageOf(url: string): Promise<Page> {
	const release = await inFlight.acquire();
	try {
		const markdown = await textOf(url);
		const updatedAt = updatedAtOf(markdown);
		return { url, title: titleOf(markdown, url), ...(updatedAt && { updatedAt }) };
	} catch (error) {
		return { url, title: url, problem: messageOf(error) };
	} finally {
		release();
	}
}

const { values } = parseArgs({ options: { days: { type: "string", default: "7" } } });
const days = Number(values.days);
if (!Number.isInteger(days) || days <= 0) {
	throw new Error(`--days must be a positive whole number, not "${values.days}"`);
}
const since = new Date(Date.now() - days * DAY_MS);
const index = await textOf(INDEX);
const pages = await Promise.all(
	pagesOf(index)
		.toSorted()
		.map((url) => pageOf(url)),
);
process.stdout.write(render(pages, since));
