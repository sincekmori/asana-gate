// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { parseArgs } from "node:util";

import { isObject } from "../json.ts";
import { COMMON_OPTIONS, loadCliSettings, usageRows } from "./context.ts";

const SETTINGS_OPTIONS = {
	json: { type: "boolean", default: false, description: "Print as JSON" },
	...COMMON_OPTIONS,
} as const;

const SETTINGS_USAGE = `Usage: asana-gate settings [options]

Show the settings in force and where each value comes from. Layers, lowest
first: defaults, ~/.asana-gate/settings.yaml, the project's
.asana-gate/settings.yaml and settings.local.yaml, environment variables,
command-line flags, and managed settings (which nothing overrides).

Options:
${usageRows(SETTINGS_OPTIONS)}`;

/** `{ a: { b: 1 } }` as `[["a.b", 1]]`. */
function leaves(object: Record<string, unknown>, prefix = ""): [string, unknown][] {
	return Object.entries(object).flatMap(([key, value]) =>
		isObject(value) ? leaves(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]],
	);
}

/** Runs `asana-gate settings`. */
async function runSettings(argv: readonly string[]): Promise<number> {
	const { values } = parseArgs({ args: [...argv], options: SETTINGS_OPTIONS, strict: true });
	if (values.help === true) {
		console.log(SETTINGS_USAGE);
		return 0;
	}
	const loaded = await loadCliSettings(values);
	if (values.json) {
		console.log(
			JSON.stringify(
				{
					home: loaded.home,
					project: loaded.projectDir ?? null,
					settings: loaded.settings,
					origins: Object.fromEntries(loaded.origins),
				},
				null,
				2,
			),
		);
		return 0;
	}
	console.log(`home:     ${loaded.home}`);
	console.log(
		`project:  ${loaded.projectDir ?? "(none: no .asana-gate directory above the working directory)"}`,
	);
	console.log("");
	for (const [key, value] of leaves(loaded.settings)) {
		console.log(
			`${key.padEnd(20)} ${JSON.stringify(value).padEnd(28)} ${loaded.origins.get(key) ?? ""}`,
		);
	}
	return 0;
}

export { runSettings };
