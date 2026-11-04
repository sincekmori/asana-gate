// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { parseArgs } from "node:util";

import * as z from "zod";

import type { Gate, GateRequest } from "../gate/gate.ts";
import { type Command, commandHelp, findCommand, nounHelp } from "./commands.ts";
import { cliConfirmHandler } from "./confirm.ts";
import { type CommonOptions, GATED_OPTIONS, UsageError } from "./context.ts";
import { coerce, parseArgsOptions } from "./flags.ts";
import { renderBody, renderErrors } from "./output.ts";
import { openGate } from "./policy.ts";
import { createContext } from "./session.ts";

/** What a gated command was given on the command line. */
interface GatedOptions extends CommonOptions {
	readonly json: boolean;
	readonly yes: boolean;
}

/** Opens the gate once, sends the request `build` makes for its policy through it, prints the result and returns the exit code. */
async function runGated(
	build: (policy: Gate["policy"]) => GateRequest,
	options: GatedOptions,
): Promise<number> {
	const context = await createContext(options);
	const gate = await openGate(context);
	const confirm = cliConfirmHandler(options.yes);
	const response = await gate.execute(build(gate.policy), confirm === undefined ? {} : { confirm });
	if (options.json) {
		console.log(JSON.stringify(response.body, null, 2));
	} else if (response.status >= 400) {
		console.error(`asana-gate: ${renderErrors(response.status, response.body)}`);
	} else {
		console.log(renderBody(response.body));
	}
	if (response.status === 428) {
		console.error("asana-gate: pass --yes to confirm non-interactively");
	}
	return response.status >= 400 ? 1 : 0;
}

/** Builds the tool's input from positionals and flags, validated by the tool's schema. */
async function inputOf(
	command: Command,
	positionals: readonly string[],
	values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const positionalFlags = command.flags.filter((flag) => flag.positional);
	const unfilled = positionalFlags.find((_, index) => positionals[index] === undefined);
	if (unfilled !== undefined) {
		throw new UsageError(`missing <${unfilled.key}>\n\n${commandHelp(command)}`);
	}
	if (positionals.length > positionalFlags.length) {
		throw new UsageError(`unexpected argument "${positionals[positionalFlags.length] ?? ""}"`);
	}
	const flags = command.flags.filter((flag) => !flag.positional);
	// `@file` names a file in the -C directory, where the command runs.
	const base = typeof values.directory === "string" ? values.directory : undefined;
	const [fromPositionals, fromFlags] = await Promise.all([
		Promise.all(positionalFlags.map((flag, index) => coerce(flag, positionals[index], base))),
		Promise.all(flags.map((flag) => coerce(flag, values[flag.flag], base))),
	]);
	const input: Record<string, unknown> = {};
	for (const [index, flag] of positionalFlags.entries()) {
		input[flag.key] = fromPositionals[index];
	}
	for (const [index, flag] of flags.entries()) {
		if (fromFlags[index] !== undefined) {
			input[flag.key] = fromFlags[index];
		}
	}
	const missing = command.flags.filter(
		(flag) => flag.required && !flag.positional && input[flag.key] === undefined,
	);
	if (missing.length > 0) {
		throw new UsageError(
			`missing ${missing.map((flag) => `--${flag.flag}`).join(", ")}\n\n${commandHelp(command)}`,
		);
	}
	const parsed = command.spec.input.safeParse(input);
	if (!parsed.success) {
		throw new UsageError(z.prettifyError(parsed.error));
	}
	return parsed.data;
}

/** Runs `asana-gate <noun> [verb] …`. */
async function runCommand(noun: string, argv: readonly string[]): Promise<number> {
	const [first, ...rest] = argv;
	const verbless = findCommand(noun);
	const command = verbless ?? (first === undefined ? undefined : findCommand(noun, first));
	const args = verbless === undefined ? rest : argv;
	if (command === undefined) {
		if (first === undefined || first === "--help" || first === "-h") {
			console.log(nounHelp(noun));
			return first === undefined ? 2 : 0;
		}
		throw new UsageError(`unknown command "${noun} ${first}"\n\n${nounHelp(noun)}`);
	}
	const { values, positionals } = parseArgs({
		args: [...args],
		options: { ...GATED_OPTIONS, ...parseArgsOptions(command.flags) },
		allowPositionals: true,
		allowNegative: true,
		strict: true,
	});
	if (values.help === true) {
		console.log(commandHelp(command));
		return 0;
	}
	const input = await inputOf(command, positionals, values);
	return runGated((policy) => command.spec.request(input, policy), values);
}

export { runCommand, runGated };
export type { GatedOptions };
