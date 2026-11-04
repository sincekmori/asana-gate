// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { text as readStream } from "node:stream/consumers";
import type { ParseArgsOptionsConfig } from "node:util";

import * as z from "zod";

import { splitList } from "../asana/query.ts";
import { isObject, parseJson } from "../json.ts";
import { messageOf } from "../log.ts";
import type { AnyToolSpec } from "../mcp/tools.ts";
import { UsageError } from "./context.ts";

/** What one input member looks like on the command line. */
interface FlagSpec {
	/** The input member this flag sets. */
	readonly key: string;
	/** The flag name without dashes (`due-on`). */
	readonly flag: string;
	readonly kind: "string" | "number" | "boolean" | "list" | "json";
	readonly required: boolean;
	readonly positional: boolean;
	readonly description: string;
	readonly choices?: readonly string[];
	readonly nullable: boolean;
}

type JsonSchema = Record<string, unknown>;

const kebab = (key: string): string => key.replaceAll("_", "-");

function kindOf(property: JsonSchema): FlagSpec["kind"] {
	const { type } = property;
	const types = Array.isArray(type) ? type : [type];
	if (types.includes("boolean")) {
		return "boolean";
	}
	if (types.includes("number") || types.includes("integer")) {
		return "number";
	}
	if (types.includes("array")) {
		return isObject(property.items) && property.items.type === "object" ? "json" : "list";
	}
	if (types.includes("object")) {
		return "json";
	}
	return "string";
}

/** Unwraps a nullable member (`type: ["string", "null"]` or `anyOf` with a null variant) into its real schema plus a mark. */
function unwrapNullable(property: JsonSchema): { property: JsonSchema; nullable: boolean } {
	const types: unknown[] = Array.isArray(property.type) ? (property.type as unknown[]) : [];
	if (types.includes("null")) {
		const real = types.filter((type) => type !== "null");
		return { property: { ...property, type: real.length === 1 ? real[0] : real }, nullable: true };
	}
	const variants: unknown[] = Array.isArray(property.anyOf) ? (property.anyOf as unknown[]) : [];
	const real = variants.filter((v): v is JsonSchema => isObject(v) && v.type !== "null");
	const [first] = real;
	if (variants.length === 0 || first === undefined) {
		return { property, nullable: false };
	}
	return { property: first, nullable: real.length !== variants.length };
}

/** The flags of a tool, derived from its input schema; its command-line shape, when it has one, names the positionals and renames flags. */
function flagsOf(spec: AnyToolSpec): FlagSpec[] {
	const shape = spec.cli === false ? undefined : spec.cli;
	const schema = z.toJSONSchema(spec.input, { io: "input" }) as JsonSchema;
	const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
	const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
	const positional = new Set(shape?.positional);
	return Object.entries(properties).map(([key, raw]) => {
		const { property, nullable } = unwrapNullable(raw);
		const choices = Array.isArray(property.enum) ? (property.enum as string[]) : undefined;
		return {
			key,
			flag: shape?.flags?.[key] ?? kebab(key),
			kind: kindOf(property),
			required: required.has(key),
			positional: positional.has(key),
			description: typeof property.description === "string" ? property.description : "",
			...(choices && { choices }),
			nullable,
		};
	});
}

/** A flag as help shows it: `--flag <kind>`, a switch as `--flag`, a positional as `<key>`. */
function flagForm(flag: FlagSpec): string {
	if (flag.positional) {
		return `<${flag.key}>`;
	}
	if (flag.kind === "boolean") {
		return `--${flag.flag}`;
	}
	return `--${flag.flag} <${flag.kind === "list" ? "value,..." : flag.kind}>`;
}

/** What help notes about a flag besides its description: its choices, and whether `null` clears the member. */
function flagNotes(flag: FlagSpec): string[] {
	return [
		flag.choices === undefined ? "" : `one of ${flag.choices.join(", ")}`,
		flag.nullable ? "null clears it" : "",
	].filter((note) => note !== "");
}

/** The `parseArgs` option config for a tool's flags. */
function parseArgsOptions(flags: readonly FlagSpec[]): ParseArgsOptionsConfig {
	const options: ParseArgsOptionsConfig = {};
	for (const flag of flags.filter((f) => !f.positional)) {
		options[flag.flag] =
			flag.kind === "boolean"
				? { type: "boolean" }
				: { type: "string", multiple: flag.kind === "list" };
	}
	return options;
}

const usage = (message: string): Error => new UsageError(message);

/**
 * JSON given on the command line: inline, from a file (`@file`, relative to
 * `base`, the `-C` directory) or from standard input (`-`).
 */
async function readData(data: string, base?: string): Promise<unknown> {
	if (data === "-") {
		return parseJson(await readStream(process.stdin), "stdin", usage);
	}
	if (data.startsWith("@")) {
		const file = resolve(base ?? ".", data.slice(1));
		const text = await readFile(file, "utf8").catch((error: unknown) => {
			throw usage(`cannot read ${data}: ${messageOf(error)}`);
		});
		return parseJson(text, file, usage);
	}
	return parseJson(data, "argument", usage);
}

/** Turns a parsed command-line value into what the tool's input schema expects; JSON may also name a file or stdin. */
async function coerce(flag: FlagSpec, value: unknown, base?: string): Promise<unknown> {
	if (value === undefined) {
		return undefined;
	}
	if (flag.nullable && value === "null") {
		return null;
	}
	switch (flag.kind) {
		case "number": {
			return Number(value);
		}
		case "boolean": {
			return value === true || value === "true";
		}
		case "list": {
			const items = Array.isArray(value) ? value : [value];
			return items.flatMap((item) => splitList(String(item)));
		}
		case "json": {
			if (typeof value !== "string") {
				return value;
			}
			const parsed = await readData(value, base);
			return parsed;
		}
		default: {
			return typeof value === "string" ? value : JSON.stringify(value);
		}
	}
}

export { coerce, flagForm, flagNotes, flagsOf, parseArgsOptions, readData };
export type { FlagSpec };
