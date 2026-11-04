// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

/** Runs one command with its arguments and resolves to the exit code. */
type Runner = (argv: readonly string[], version: string) => Promise<number>;

/**
 * The commands, each loading its own modules when it runs, so a command does
 * not pay for the others (`mcp` for the MCP SDK, the resource commands for
 * the tools and the gate).
 */
const COMMANDS: Readonly<Record<string, Runner>> = {
	async mcp(argv, version) {
		const { runMcp } = await import("./mcp.ts");
		return runMcp(argv, version);
	},
	async check(argv, version) {
		const { runCheck } = await import("./check.ts");
		return runCheck(argv, version);
	},
	async explain(argv) {
		const { runExplain } = await import("./explain.ts");
		return runExplain(argv);
	},
	async init(argv, version) {
		const { runInit } = await import("./init.ts");
		return runInit(argv, version);
	},
	async token(argv) {
		const { runToken } = await import("./token-command.ts");
		return runToken(argv);
	},
	async api(argv) {
		const { runApi } = await import("./api.ts");
		return runApi(argv);
	},
	async settings(argv) {
		const { runSettings } = await import("./config.ts");
		return runSettings(argv);
	},
	async cache(argv) {
		const { runCache } = await import("./config.ts");
		return runCache(argv);
	},
};

/** The resource commands, one line per noun. */
async function resourceLines(): Promise<string> {
	const { commandsOf, nouns, usageOf } = await import("./commands.ts");
	return nouns()
		.map((noun) => {
			const verbs = commandsOf(noun).map((command) =>
				usageOf(command).replace(`${noun} `, "").replace(/ <.*$/u, ""),
			);
			return `  ${noun.padEnd(14)} ${verbs.join(", ")}`;
		})
		.join("\n");
}

/** The usage text of the command line. */
async function usage(): Promise<string> {
	return `Usage: asana-gate <command> [options]

Serve or operate the policy-gated Asana API.

Commands:
  mcp            Serve the policy-gated Asana API as an MCP server
  check          Validate the settings, the token and the policy against Asana
  explain        Show what the policy allows on one object, and why
  init           Create the project's .asana-gate directory; --agent claude-code wires Claude Code
  token          Show where the Asana token comes from, or save one (never printed)
  settings       Show the settings in force and where each value comes from
  cache          Show or clear the on-disk cache of workspace names
  api            Call any Asana REST operation through the policy

Resources (asana-gate <resource> <verb> …, all through the policy):
${await resourceLines()}

Run "asana-gate <command> --help" for the options of a command.`;
}

/** Runs a command, a resource command, or the usage text. */
async function dispatch(
	command: string | undefined,
	argv: readonly string[],
	version: string,
): Promise<number> {
	if (command === undefined || command === "--help" || command === "-h") {
		console.log(await usage());
		return command === undefined ? 2 : 0;
	}
	const runner = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
	if (runner !== undefined) {
		return runner(argv, version);
	}
	const { nouns } = await import("./commands.ts");
	if (nouns().includes(command)) {
		const { runCommand } = await import("./run.ts");
		return runCommand(command, argv);
	}
	const { UsageError } = await import("./context.ts");
	throw new UsageError(`unknown command "${command}"\n\n${await usage()}`);
}

/** Runs the CLI and resolves to the exit code. */
async function main(argv: readonly string[], version: string): Promise<number> {
	const [command, ...rest] = argv;
	if (command === "--version" || command === "-v") {
		console.log(version);
		return 0;
	}
	try {
		return await dispatch(command, rest, version);
	} catch (error) {
		const { describeError, isUsageError } = await import("./context.ts");
		console.error(`asana-gate: ${describeError(error)}`);
		return isUsageError(error) ? 2 : 1;
	}
}

export { main };
