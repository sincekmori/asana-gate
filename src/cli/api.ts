// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { parseArgs } from "node:util";

import { isHttpMethod } from "../gate/router.ts";
import { GATED_OPTIONS, UsageError, usageRows } from "./context.ts";
import { readData } from "./flags.ts";
import { runGated } from "./run.ts";

const API_OPTIONS = {
	query: {
		type: "string",
		short: "q",
		multiple: true,
		placeholder: "<key=value>",
		description: "Query parameter (repeatable; opt_fields takes a comma list)",
	},
	data: {
		type: "string",
		short: "d",
		placeholder: "<json>",
		description: 'Request body as JSON ("@file" reads a file, "-" reads stdin)',
	},
	...GATED_OPTIONS,
} as const;

const USAGE = `Usage: asana-gate api <METHOD> <path> [options]

Call any Asana REST operation through the policy. The path is the part below
/api/1.0, for example /tasks/123 or /workspaces/456/tasks/search.

The response body is always printed as JSON.

Options:
${usageRows(API_OPTIONS)}

Examples:
  asana-gate api GET /tasks/123 -q opt_fields=name,completed
  asana-gate api POST /tasks -d '{"name": "Write docs", "projects": ["123"]}'
  asana-gate api PUT /tasks/123 -d @task.json`;

/** Runs `asana-gate api <METHOD> <path>`. */
async function runApi(argv: readonly string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: [...argv],
		options: API_OPTIONS,
		allowPositionals: true,
		strict: true,
	});
	if (values.help === true) {
		console.log(USAGE);
		return 0;
	}
	const [methodArg, path] = positionals;
	const method = methodArg?.toUpperCase();
	if (method === undefined || path === undefined || !isHttpMethod(method)) {
		throw new UsageError(`api needs a method (GET, POST, PUT, DELETE) and a path\n\n${USAGE}`);
	}
	const query: Record<string, string> = {};
	for (const pair of values.query ?? []) {
		const separator = pair.indexOf("=");
		if (separator === -1) {
			throw new UsageError(`--query expects key=value, got "${pair}"`);
		}
		query[pair.slice(0, separator)] = pair.slice(separator + 1);
	}
	const body =
		values.data === undefined ? undefined : await readData(values.data, values.directory);
	return runGated(() => ({ method, path, query, body }), { ...values, json: true });
}

export { runApi };
