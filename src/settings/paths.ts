// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { envValue, firstWhere, isDirectory, realOf } from "../system.ts";

/** The directory name a project's asana-gate files live in. */
const PROJECT_DIR = ".asana-gate";

/** The policy file of a project (or of the home directory), inside its `.asana-gate`. */
const POLICY_FILE = "policy.yaml";

/** The file a Personal Access Token may be kept in, inside a project's or the home directory's `.asana-gate`. */
const TOKEN_FILE = "token";

/** An administrator's policy, inside the managed directory: every policy in force is bounded by it. */
const MANAGED_POLICY_FILE = "managed-policy.yaml";

/** Where asana-gate keeps its own files: `~/.asana-gate`, unless `ASANA_GATE_HOME` says otherwise. */
function homeDir(env: NodeJS.ProcessEnv): string {
	return envValue(env, "ASANA_GATE_HOME") ?? join(homedir(), PROJECT_DIR);
}

/** Where an administrator's managed settings live on this platform. */
function managedDir(env: NodeJS.ProcessEnv): string {
	switch (process.platform) {
		case "darwin": {
			return "/Library/Application Support/asana-gate";
		}
		case "win32": {
			return join(envValue(env, "ProgramData") ?? String.raw`C:\ProgramData`, "asana-gate");
		}
		default: {
			return "/etc/asana-gate";
		}
	}
}

/** `~` and `~/…` expanded to the home directory; other paths unchanged. */
function expandHome(path: string): string {
	if (path === "~") {
		return homedir();
	}
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** `path` made absolute against `base`, with `~` expanded. */
function resolveFrom(base: string, path: string): string {
	return resolve(base, expandHome(path));
}

/**
 * The nearest directory, from `cwd` upwards, that holds a `.asana-gate`
 * directory: the project. The user's own asana-gate home (`~/.asana-gate`,
 * or `home`) is not a project's, so the home directory never is one, also
 * when a symbolic link leads to it (a linked `$HOME` against a working
 * directory whose links are resolved).
 */
async function findProjectDir(cwd: string, home?: string): Promise<string | undefined> {
	const homes = [join(homedir(), PROJECT_DIR), ...(home === undefined ? [] : [resolve(home)])];
	const own = new Set(await Promise.all(homes.map((dir) => realOf(dir))));
	const ancestors: string[] = [];
	for (let dir = resolve(cwd); ; dir = dirname(dir)) {
		ancestors.push(dir);
		if (dirname(dir) === dir) {
			break;
		}
	}
	return firstWhere(ancestors, async (dir) => {
		const candidate = join(dir, PROJECT_DIR);
		return (await isDirectory(candidate)) && !own.has(await realOf(candidate));
	});
}

export {
	findProjectDir,
	homeDir,
	MANAGED_POLICY_FILE,
	managedDir,
	POLICY_FILE,
	PROJECT_DIR,
	resolveFrom,
	TOKEN_FILE,
};
