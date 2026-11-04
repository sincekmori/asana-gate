// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { parse } from "yaml";
import * as z from "zod";

import { messageOf } from "./log.ts";

/** Makes the error a loader throws for a message, so each loader keeps its own error class. */
type Fail = (message: string) => Error;

/** The document in YAML `text`; `source` names it in the error `fail` makes when it is malformed. */
function parseYaml(text: string, source: string, fail: Fail): unknown {
	try {
		return parse(text);
	} catch (error) {
		throw fail(`${source}: invalid YAML: ${messageOf(error)}`);
	}
}

/** `raw` as `schema` reads it; when it does not fit, `fail` makes the error, naming `source`. */
function validated<T>(
	schema: z.ZodType<T>,
	raw: unknown,
	options: { readonly source: string; readonly fail: Fail },
): T {
	const result = schema.safeParse(raw);
	if (!result.success) {
		throw options.fail(`${options.source}: ${z.prettifyError(result.error)}`);
	}
	return result.data;
}

export { parseYaml, validated };
export type { Fail };
