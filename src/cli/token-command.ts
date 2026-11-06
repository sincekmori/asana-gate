// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { parseArgs } from "node:util";

import type { LoadedSettings } from "../settings/load.ts";
import { PROJECT_DIR } from "../settings/paths.ts";
import { ensureLine, errnoOf, privateFile } from "../system.ts";
import { loadCliSettings, TOKEN_OPTIONS, UsageError, usageRows } from "./context.ts";
import { identify, readSecret } from "./identity.ts";
import { tokenFileWarning, tokenOf, tokenPlaces } from "./token.ts";

const TOKEN_COMMAND_OPTIONS = {
	user: {
		type: "boolean",
		default: false,
		description: "The token file under ~/.asana-gate instead of the one read first",
	},
	...TOKEN_OPTIONS,
} as const;

const USAGE = `Usage: asana-gate token <status|set|unset> [options]

The Asana Personal Access Token, which is never printed. It comes from the
first of: the environment variable token.env (default ASANA_ACCESS_TOKEN), the
token.command of your own or managed settings, the token.file of the settings,
the project's .asana-gate/token, and ~/.asana-gate/token.

  status   Show where the token comes from and whose it is (the default)
  set      Save a token, read from stdin or typed unseen, to the file read first
           (token.file, else the project's .asana-gate/token, ignored by git) or,
           with --user, to ~/.asana-gate/token
  unset    Delete that file

Options:
${usageRows(TOKEN_COMMAND_OPTIONS)}`;

/** The token file `set` and `unset` act on: the one read first, or the home directory's with `--user`. */
function tokenFileOf(loaded: LoadedSettings, user: boolean): string {
	const places = tokenPlaces(loaded);
	const chosen = user
		? places.find((place) => place.place === "user")
		: places.find((place) => place.place !== "user");
	if (chosen === undefined) {
		throw new UsageError(
			`no ${PROJECT_DIR} directory above the working directory and no token.file in the settings: run "asana-gate init" first, or pass --user`,
		);
	}
	return chosen.file;
}

async function showStatus(loaded: LoadedSettings): Promise<void> {
	const source = await tokenOf(loaded);
	console.log(`token:  ${await identify(source.token)}`);
	console.log(`source: ${source.source}`);
	const warning = tokenFileWarning(source);
	if (warning !== undefined) {
		console.log(`warning: ${warning}`);
	}
}

/**
 * Keeps a token file inside the project's .asana-gate out of git: its
 * .gitignore gets a line naming the file, whatever token.file calls it.
 * Resolves to whether it did; a token file anywhere else is left alone.
 */
async function ignoreByGit(loaded: LoadedSettings, file: string): Promise<boolean> {
	if (loaded.projectDir === undefined) {
		return false;
	}
	const dir = join(loaded.projectDir, PROJECT_DIR);
	const path = relative(dir, file);
	if (path === "" || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
		return false;
	}
	await ensureLine(join(dir, ".gitignore"), path.split(sep).join("/"));
	return true;
}

async function setToken(loaded: LoadedSettings, user: boolean): Promise<void> {
	const file = tokenFileOf(loaded, user);
	const token = await readSecret("Asana Personal Access Token (not shown): ");
	if (token === "") {
		throw new UsageError("no token given");
	}
	const owner = await identify(token);
	await privateFile(file, `${token}\n`);
	const ignored = await ignoreByGit(loaded, file);
	const note = ignored ? ` (ignored by git through ${PROJECT_DIR}/.gitignore)` : "";
	console.log(`saved the token of ${owner} to ${file}${note}`);
}

async function unsetToken(loaded: LoadedSettings, user: boolean): Promise<void> {
	const file = tokenFileOf(loaded, user);
	try {
		await rm(file);
	} catch (error) {
		if (errnoOf(error) === "ENOENT") {
			throw new UsageError(`no token file at ${file}`);
		}
		throw error;
	}
	console.log(`removed ${file}`);
}

/** Runs `asana-gate token [status|set|unset]`. */
async function runToken(argv: readonly string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: [...argv],
		options: TOKEN_COMMAND_OPTIONS,
		allowPositionals: true,
		strict: true,
	});
	if (values.help === true) {
		console.log(USAGE);
		return 0;
	}
	const [verb = "status"] = positionals;
	const loaded = await loadCliSettings(values);
	switch (verb) {
		case "status": {
			await showStatus(loaded);
			return 0;
		}
		case "set": {
			await setToken(loaded, values.user);
			return 0;
		}
		case "unset": {
			await unsetToken(loaded, values.user);
			return 0;
		}
		default: {
			throw new UsageError(`unknown token command "${verb}"\n\n${USAGE}`);
		}
	}
}

export { ignoreByGit, runToken };
