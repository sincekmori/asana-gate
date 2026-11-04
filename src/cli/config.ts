// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { parseArgs } from "node:util";

import { cacheEntries, clearCache } from "../gate/listing-cache.ts";
import { isObject } from "../json.ts";
import { unwritable } from "../system.ts";
import { COMMON_OPTIONS, loadCliSettings, UsageError, usageRows } from "./context.ts";

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

const CACHE_USAGE = `Usage: asana-gate cache [status|clear] [options]

Show (status, the default) or delete (clear) the on-disk cache: the names and
gids of the workspace's structure that name resolution keeps between runs.

Options:
${usageRows(COMMON_OPTIONS)}`;

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

/** Runs `asana-gate cache [status|clear]`. */
async function runCache(argv: readonly string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: [...argv],
		options: COMMON_OPTIONS,
		allowPositionals: true,
		strict: true,
	});
	if (values.help === true) {
		console.log(CACHE_USAGE);
		return 0;
	}
	const [verb = "status"] = positionals;
	const { settings } = await loadCliSettings(values);
	if (verb === "clear") {
		const removed = await clearCache(settings.cache.dir);
		console.log(`removed the listings of ${removed} token(s) from ${settings.cache.dir}`);
		return 0;
	}
	if (verb !== "status") {
		throw new UsageError(`unknown cache command "${verb}"\n\n${CACHE_USAGE}`);
	}
	const [problem, entries] = await Promise.all([
		unwritable(settings.cache.dir),
		cacheEntries(settings.cache.dir),
	]);
	console.log(`enabled:  ${settings.cache.enabled ? "yes" : "no"}`);
	console.log(`dir:      ${settings.cache.dir}`);
	console.log(`writable: ${problem === undefined ? "yes" : `no (${problem})`}`);
	console.log(`ttl:      ${settings.cache.ttl}`);
	console.log(`entries:  ${entries}`);
	return 0;
}

export { runCache, runSettings };
