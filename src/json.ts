// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { messageOf } from "./message.ts";

/** A parsed JSON object (not an array). */
type JsonObject = Record<string, unknown>;

/** Whether a parsed JSON value is an object rather than an array, a scalar or null. */
function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The string value of a member, if it is a string. */
function stringOf(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** The value in JSON `text`; `source` names it in the error `fail` makes when it is malformed. */
function parseJson(text: string, source: string, fail: (message: string) => Error): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw fail(`${source}: invalid JSON: ${messageOf(error)}`);
	}
}

/** The length of the string literal starting at `start` (a `"`), escapes included. */
function stringLength(text: string, start: number): number {
	let end = start + 1;
	while (end < text.length && text[end] !== '"') {
		end += text[end] === "\\" ? 2 : 1;
	}
	return end + 1 - start;
}

/** The index after the whitespace and comments starting at `start`. */
function skipBlank(text: string, start: number): number {
	let at = start;
	for (;;) {
		if (/\s/u.test(text[at] ?? "")) {
			at += 1;
		} else if (text.startsWith("//", at)) {
			const end = text.indexOf("\n", at);
			at = end === -1 ? text.length : end;
		} else if (text.startsWith("/*", at)) {
			const end = text.indexOf("*/", at + 2);
			at = end === -1 ? text.length : end + 2;
		} else {
			return at;
		}
	}
}

/**
 * JSON with comments and trailing commas (JSONC, as VS Code and Cursor write
 * their configuration) reduced to JSON; strings are left as they are.
 */
function stripJsonc(text: string): string {
	let out = "";
	let at = 0;
	while (at < text.length) {
		const char = text[at] ?? "";
		if (char === '"') {
			const length = stringLength(text, at);
			out += text.slice(at, at + length);
			at += length;
		} else if (text.startsWith("//", at) || text.startsWith("/*", at)) {
			at = skipBlank(text, at);
		} else if (char === "," && /[}\]]/u.test(text[skipBlank(text, at + 1)] ?? "")) {
			at += 1;
		} else {
			out += char;
			at += 1;
		}
	}
	return out;
}

/** The value in JSONC `text` (JSON with comments and trailing commas). */
function parseJsonc(text: string, source: string, fail: (message: string) => Error): unknown {
	return parseJson(stripJsonc(text), source, fail);
}

export { isObject, parseJson, parseJsonc, stringOf };
export type { JsonObject };
