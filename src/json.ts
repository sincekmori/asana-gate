// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { parse, type ParseError, printParseErrorCode } from "jsonc-parser";

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

/** The value in JSONC `text` (JSON with comments and trailing commas, as VS Code and Cursor write their configuration). */
function parseJsonc(text: string, source: string, fail: (message: string) => Error): unknown {
	const errors: ParseError[] = [];
	const value: unknown = parse(text, errors, { allowTrailingComma: true });
	const [error] = errors;
	if (error !== undefined) {
		throw fail(
			`${source}: invalid JSON: ${printParseErrorCode(error.error)} at offset ${error.offset}`,
		);
	}
	return value;
}

export { isObject, parseJson, parseJsonc, stringOf };
export type { JsonObject };
