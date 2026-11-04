// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { AsanaApiError, messagesOf } from "../asana/errors.ts";
import type { JsonObject } from "../json.ts";
import { LOG_LEVELS, messageOf } from "../log.ts";
import { PolicyError } from "../policy/types.ts";
import { type LoadedSettings, loadSettings, SettingsError } from "../settings/load.ts";
import { POLICY_FILE, PROJECT_DIR } from "../settings/paths.ts";
import { errnoOf } from "../system.ts";

/** A usage error: the message is printed and the process exits with 2. */
class UsageError extends Error {
	public override readonly name: string = "UsageError";
}

/** Whether a failure is the user's to fix (exit code 2) rather than Asana's or the gate's. */
function isUsageError(error: unknown): boolean {
	return (
		error instanceof UsageError ||
		error instanceof PolicyError ||
		error instanceof SettingsError ||
		// node:util parseArgs: an unknown option, a stray positional, a value where none is taken.
		(error instanceof TypeError && errnoOf(error)?.startsWith("ERR_PARSE_ARGS_") === true)
	);
}

/** What `--help` says about an option, besides how `parseArgs` reads it. */
interface OptionHelp {
	readonly short?: string;
	/** The value's name in the usage row, such as `<file>`. */
	readonly placeholder?: string;
	readonly description: string;
}

/** Options every command shares. */
interface CommonOptions {
	readonly directory?: string;
	readonly policy?: string;
	readonly "token-env"?: string;
	readonly "log-level"?: string;
}

/** The options of the commands that reach Asana without a policy (`init`). */
const TOKEN_OPTIONS = {
	directory: {
		type: "string",
		short: "C",
		placeholder: "<dir>",
		description: "Run as if started in <dir> (where the project's .asana-gate is looked for)",
	},
	"token-env": {
		type: "string",
		placeholder: "<NAME>",
		description: "Environment variable holding the Asana PAT (default: ASANA_ACCESS_TOKEN)",
	},
	"log-level": {
		type: "string",
		placeholder: "<level>",
		description: `${LOG_LEVELS.join(", ")} (default: warn)`,
	},
	help: { type: "boolean", short: "h", description: "Show this help" },
} as const;

/** The options of every command that reads the policy. */
const COMMON_OPTIONS = {
	policy: {
		type: "string",
		short: "p",
		placeholder: "<file>",
		description: `Policy file (default: the project's ${PROJECT_DIR}/${POLICY_FILE})`,
	},
	...TOKEN_OPTIONS,
} as const;

/** The options of the commands that send a request through the gate. */
const GATED_OPTIONS = {
	json: { type: "boolean", default: false, description: "Print the response body as JSON" },
	yes: {
		type: "boolean",
		short: "y",
		default: false,
		description: "Confirm actions the policy wants confirmed",
	},
	...COMMON_OPTIONS,
} as const;

/** The usage rows of an option table, one per option in its order. */
function usageRows(options: Readonly<Record<string, OptionHelp>>): string {
	return Object.entries(options)
		.map(([name, { short, placeholder, description }]) => {
			const dash = short === undefined ? "    " : `-${short}, `;
			const form = `${dash}--${name}${placeholder === undefined ? "" : ` ${placeholder}`}`;
			return form.length < 26
				? `  ${form.padEnd(27)}${description}`
				: `  ${form}\n${" ".repeat(29)}${description}`;
		})
		.join("\n");
}

/** Loads the settings with the command line as their `flags` layer (`extra` carries a command's own). */
function loadCliSettings(options: CommonOptions, extra: JsonObject = {}): Promise<LoadedSettings> {
	if (options.directory !== undefined) {
		try {
			process.chdir(options.directory);
		} catch (error) {
			throw new UsageError(`cannot run in ${options.directory}: ${messageOf(error)}`);
		}
	}
	return loadSettings({
		cwd: process.cwd(),
		env: process.env,
		flags: {
			...extra,
			...(options.policy !== undefined && { policy: options.policy }),
			...(options["token-env"] !== undefined && { token: { env: options["token-env"] } }),
			...(options["log-level"] !== undefined && { log: { level: options["log-level"] } }),
		},
	});
}

/** A failure as the command line reports it. */
function describeError(error: unknown): string {
	if (error instanceof AsanaApiError) {
		return `Asana responded ${error.status}: ${messagesOf(error.errors)}`;
	}
	return messageOf(error);
}

export {
	COMMON_OPTIONS,
	describeError,
	GATED_OPTIONS,
	isUsageError,
	loadCliSettings,
	TOKEN_OPTIONS,
	UsageError,
	usageRows,
};
export type { CommonOptions };
