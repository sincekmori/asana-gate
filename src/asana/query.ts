// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

/** Query values; arrays are joined with commas (as `opt_fields` expects). */
type QueryValue = string | number | boolean | readonly string[] | undefined;

/** A query as Asana reads it: undefined members dropped, lists comma-joined, the rest as strings. */
function renderQuery(query: Readonly<Record<string, QueryValue>> = {}): Record<string, string> {
	const rendered: Record<string, string> = {};
	for (const [key, value] of Object.entries(query)) {
		if (value !== undefined) {
			rendered[key] = Array.isArray(value) ? value.join(",") : String(value);
		}
	}
	return rendered;
}

/** The items of a comma-separated list (`opt_fields`, a list flag), trimmed, empty ones dropped. */
function splitList(text: string): string[] {
	return text
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item !== "");
}

export { renderQuery, splitList };
export type { QueryValue };
