// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { isObject, type JsonObject, objectIn } from "../json.ts";
import { PROJECT_DIR, TOKEN_FILE } from "../settings/paths.ts";

/**
 * What keeps the token from the coding agent a project is wired for: the
 * rules Claude Code honors, and what a person is told where no rule can.
 */

/** The token files as Claude Code's rules name them: the project's, and the one in the home directory. */
const TOKEN_DENY = [`Read(./${PROJECT_DIR}/${TOKEN_FILE})`, `Read(~/${PROJECT_DIR}/${TOKEN_FILE})`];

/**
 * Adds to Claude Code's settings what keeps the token from the agent: the
 * token files are denied to its reads, and the variable `tokenEnv` is taken
 * out of the environment of the commands its sandbox runs. The MCP server is
 * no such command, so it still reads either.
 */
function guardToken(document: JsonObject, tokenEnv: string): void {
	const permissions = objectIn(document, "permissions");
	const deny = Array.isArray(permissions.deny) ? (permissions.deny as unknown[]) : [];
	permissions.deny = [...deny, ...TOKEN_DENY.filter((rule) => !deny.includes(rule))];
	const credentials = objectIn(objectIn(document, "sandbox"), "credentials");
	const envVars = Array.isArray(credentials.envVars) ? (credentials.envVars as unknown[]) : [];
	// Only a `deny` entry counts: Claude Code ignores a `mask` entry in a project's settings.
	const denied = envVars.some(
		(entry) => isObject(entry) && entry.name === tokenEnv && entry.mode === "deny",
	);
	credentials.envVars = denied ? envVars : [...envVars, { name: tokenEnv, mode: "deny" }];
}

/**
 * What `init --agent` says of the token: where the rules were written, what
 * turns them on and what they leave the agent with; of the `unguarded`
 * agents, that nothing keeps them from the project's files.
 */
function tokenNotes(tokenEnv: string, guarded: boolean, unguarded: readonly string[]): string[] {
	return [
		guarded &&
			`the token rules keep the token files and $${tokenEnv} from every command Claude Code runs once its sandbox is on (/sandbox), asana-gate in its shell included: the agent then works through the MCP server.`,
		unguarded.length > 0 &&
			`${unguarded.join(" and ")} cannot be kept from reading files in the project, so keep the token out of it: "asana-gate token set --user" or $${tokenEnv}.`,
	].filter((note) => note !== false);
}

export { guardToken, tokenNotes };
