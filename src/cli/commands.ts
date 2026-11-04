// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { type AnyToolSpec, type CliShape, TOOLS } from "../mcp/tools.ts";
import { GATED_OPTIONS, usageRows } from "./context.ts";
import { flagForm, flagNotes, type FlagSpec, flagsOf } from "./flags.ts";

/** One `asana-gate <noun> <verb>` command, derived from a tool. */
interface Command {
	readonly noun: string;
	readonly verb: string;
	readonly spec: AnyToolSpec;
	/** Its flags, converted from the tool's schema when first read (a run needs one command's). */
	readonly flags: readonly FlagSpec[];
}

function commandOf(spec: AnyToolSpec, cli: CliShape): Command {
	const memo: { flags?: readonly FlagSpec[] } = {};
	return {
		noun: cli.noun,
		verb: cli.verb,
		spec,
		get flags(): readonly FlagSpec[] {
			memo.flags ??= flagsOf(spec);
			return memo.flags;
		},
	};
}

/** Every command, in tool order. */
const COMMANDS: readonly Command[] = TOOLS.flatMap((spec) =>
	spec.cli === false ? [] : [commandOf(spec, spec.cli)],
);

/** The nouns commands are grouped under, in first-seen order. */
function nouns(): string[] {
	return [...new Set(COMMANDS.map((command) => command.noun))];
}

/** The commands of one noun. */
function commandsOf(noun: string): Command[] {
	return COMMANDS.filter((command) => command.noun === noun);
}

/** Finds a command; a noun with a single verb-less command (`find`) needs no verb. */
function findCommand(noun: string, verb?: string): Command | undefined {
	const candidates = commandsOf(noun);
	if (candidates.length === 1 && candidates[0]?.verb === "") {
		return candidates[0];
	}
	return candidates.find((command) => command.verb === verb);
}

/** `<noun> <verb> <positionals>` as shown in usage lines. */
function usageOf(command: Command): string {
	const positionals = command.flags
		.filter((flag) => flag.positional)
		.map((flag) => `<${flag.key}>`);
	return [command.noun, command.verb, ...positionals].filter((part) => part !== "").join(" ");
}

/** The help text of a noun: its verbs. */
function nounHelp(noun: string): string {
	const lines = commandsOf(noun).map(
		(command) => `  ${usageOf(command).padEnd(44)} ${command.spec.title}`,
	);
	return `Usage: asana-gate ${noun} <verb> [options]\n\n${lines.join("\n")}\n\nRun "asana-gate ${noun} <verb> --help" for the options of a verb.`;
}

/** The help text of a command: its flags. */
function commandHelp(command: Command): string {
	const rows = command.flags
		.filter((flag) => !flag.positional)
		.map((flag) => {
			const notes = [flag.required ? "required" : "", ...flagNotes(flag)].filter((n) => n !== "");
			const text = [flag.description, notes.length === 0 ? "" : `(${notes.join("; ")})`]
				.filter((part) => part !== "")
				.join(" ");
			return `  ${flagForm(flag).padEnd(27)}${text}`.trimEnd();
		});
	return [
		`Usage: asana-gate ${usageOf(command)} [options]`,
		"",
		command.spec.description,
		"",
		...(rows.length > 0 ? ["Options:", ...rows, ""] : []),
		"Global options:",
		usageRows(GATED_OPTIONS),
	].join("\n");
}

export { COMMANDS, commandHelp, commandsOf, findCommand, nounHelp, nouns, usageOf };
export type { Command };
