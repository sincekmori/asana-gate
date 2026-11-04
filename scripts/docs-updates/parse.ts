// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading developers.asana.com from the Markdown source each page serves
 * (`<page>.md`): the pages the site's index (`llms.txt`) lists, and when a
 * page was last updated, which its front matter says.
 */

/** A page of the site and when it was last updated. */
interface Page {
	readonly url: string;
	readonly title: string;
	/** From the page's front matter; `undefined` when it does not say. */
	readonly updatedAt?: Date;
	/** Why the page could not be read, when it could not. */
	readonly problem?: string;
}

/** A Markdown page of the site the index links to, whatever its path. */
const PAGE_LINK = /\((?<url>https:\/\/developers\.asana\.com\/[^\s()]+\.md)\)/gu;

/** The pages an index links to, in order, once each. */
function pagesOf(index: string): string[] {
	const urls = [...index.matchAll(PAGE_LINK)].map((match) => match.groups?.url ?? "");
	return [...new Set(urls.filter((url) => url !== ""))];
}

/** A page's title: its first level-one heading, else its URL. */
function titleOf(markdown: string, url: string): string {
	return /^# (?<title>.+)$/mu.exec(markdown)?.groups?.title?.trim() ?? url;
}

/** When a page was last updated, from the `updatedAt` of its front matter; `undefined` when it does not say. */
function updatedAtOf(markdown: string): Date | undefined {
	const front = /^---\n(?<front>.*?)\n---/su.exec(markdown)?.groups?.front ?? "";
	const value = /^updatedAt:\s*(?<at>\S+)\s*$/mu.exec(front)?.groups?.at;
	if (value === undefined) {
		return undefined;
	}
	const at = new Date(value);
	return Number.isNaN(at.getTime()) ? undefined : at;
}

const day = (at: Date): string => at.toISOString().slice(0, 10);
const item = (page: Page): string => `- [${page.title}](${page.url})`;

/**
 * The pages updated since `since` (newest first), those that could not be
 * read, and those whose front matter names no update time, as Markdown;
 * empty when there is nothing to report.
 */
function render(pages: readonly Page[], since: Date): string {
	const updated = pages
		.filter((page): page is Page & { updatedAt: Date } => (page.updatedAt ?? since) > since)
		.toSorted((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
	const unreadable = pages.filter((page) => page.problem !== undefined);
	const undated = pages.filter(
		(page) => page.updatedAt === undefined && page.problem === undefined,
	);
	const sections: string[][] = [
		[
			`Pages of developers.asana.com updated since ${since.toISOString()}:`,
			...updated.map((page) => `- ${day(page.updatedAt)} [${page.title}](${page.url})`),
		],
		[
			"Pages that could not be read:",
			...unreadable.map((page) => `${item(page)}: ${page.problem}`),
		],
		["Pages whose front matter names no update time:", ...undated.map((page) => item(page))],
	];
	return sections
		.filter((section) => section.length > 1)
		.map((section) => `${section.join("\n")}\n`)
		.join("\n");
}

export { pagesOf, render, titleOf, updatedAtOf };
export type { Page };
