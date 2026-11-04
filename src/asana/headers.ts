// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

/** Parsers of the response headers Asana speaks through: `Retry-After` and `Asana-Change`. */

/**
 * Parses a `Retry-After` header into seconds: a whole number of seconds or an
 * HTTP date (RFC 9110 §10.2.3). A blank or malformed value is no header at all;
 * a date must name its month, as every HTTP date form does, because
 * `Date.parse` also reads values such as `1.5` or `-1` as dates long past.
 */
function parseRetryAfter(value: string | null): number | undefined {
	const text = value?.trim() ?? "";
	if (/^\d+$/u.test(text)) {
		return Number(text);
	}
	const at = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/u.test(text)
		? Date.parse(text)
		: Number.NaN;
	return Number.isNaN(at) ? undefined : Math.max(0, (at - Date.now()) / 1000);
}

/** One announcement of an `Asana-Change` header. */
interface AnnouncedChange {
	readonly name: string;
	readonly info?: string;
	readonly affected: boolean;
}

/** Parses an `Asana-Change` header: `name=x;info=url;affected=true, name=y;info=url`. */
function parseAsanaChange(header: string | null): AnnouncedChange[] {
	if (header === null) {
		return [];
	}
	const changes: AnnouncedChange[] = [];
	for (const entry of header.split(",")) {
		const fields = new Map<string, string>();
		for (const pair of entry.split(";")) {
			const separator = pair.indexOf("=");
			if (separator !== -1) {
				fields.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
			}
		}
		const name = fields.get("name");
		if (name !== undefined && name !== "") {
			const info = fields.get("info");
			changes.push({
				name,
				...(info !== undefined && { info }),
				affected: fields.get("affected") === "true",
			});
		}
	}
	return changes;
}

/** The `Asana-Enable` and `Asana-Disable` request headers for the flags given; none for no flags. */
function flagHeaders(
	enable: readonly string[],
	disable: readonly string[],
): Record<string, string> {
	return {
		...(enable.length > 0 && { "asana-enable": enable.join(",") }),
		...(disable.length > 0 && { "asana-disable": disable.join(",") }),
	};
}

export { flagHeaders, parseAsanaChange, parseRetryAfter };
export type { AnnouncedChange };
