// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";

import { messageOf } from "../log.ts";
import type { LoadedSettings } from "../settings/load.ts";
import { PROJECT_DIR, TOKEN_FILE } from "../settings/paths.ts";
import { envValue, exposureOf, readIfPresent, statIfPresent } from "../system.ts";
import { UsageError } from "./context.ts";

/** A file a token may be kept in: the settings' `token.file`, the project's or the home directory's `token`. */
interface TokenPlace {
	readonly file: string;
	readonly place: "settings" | "project" | "user";
}

/** Where a token came from, for people: a description, and the file with its permission bits when it was one. */
interface TokenSource {
	readonly source: string;
	readonly file?: string;
	readonly mode?: number;
}

/** A token and where it came from. */
interface Token extends TokenSource {
	readonly token: string;
}

/**
 * The token in a file, a command's output or piped input: its first line,
 * trimmed. A control character would reach the Authorization header, whose
 * errors quote it, so it is refused naming the source, never the value.
 */
function tokenText(text: string, source: string): string {
	const [first = ""] = text.split(/\r?\n/u);
	const token = first.trim();
	// oxlint-disable-next-line no-control-regex -- the control characters are what it looks for
	if (/[\u0000-\u001F\u007F]/u.test(token)) {
		throw new UsageError(`${source}: the token contains a control character`);
	}
	return token;
}

/** Runs a shell command and resolves to its standard output; its standard error stays on the terminal. */
async function run(command: string): Promise<string> {
	const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "inherit"] });
	const chunks: Buffer[] = [];
	for await (const chunk of child.stdout) {
		chunks.push(chunk as Buffer);
	}
	const [code] = (await once(child, "close")) as [number | null];
	if (code !== 0) {
		throw new UsageError(`token.command exited with status ${String(code)}`);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** The token the settings' command prints. */
async function tokenFromCommand(command: string): Promise<string> {
	try {
		const stdout = await run(command);
		const value = tokenText(stdout, "token.command");
		if (value === "") {
			throw new UsageError("token.command printed nothing");
		}
		return value;
	} catch (error) {
		throw error instanceof UsageError
			? error
			: new UsageError(`token.command failed: ${messageOf(error)}`);
	}
}

/** Where a token file may be, in the order they are read: `token.file` when set, the project's `token`, then `~/.asana-gate/token`. */
function tokenPlaces(loaded: LoadedSettings): TokenPlace[] {
	const { file } = loaded.settings.token;
	return [
		...(file === undefined ? [] : [{ file, place: "settings" as const }]),
		...(loaded.projectDir === undefined
			? []
			: [{ file: join(loaded.projectDir, PROJECT_DIR, TOKEN_FILE), place: "project" as const }]),
		{ file: join(loaded.home, TOKEN_FILE), place: "user" as const },
	];
}

/**
 * The Personal Access Token and where it came from; never printed. Sources,
 * first found wins: the environment variable `token.env`, the `token.command`
 * of your own or managed settings, then the token files.
 */
async function tokenOf(loaded: LoadedSettings): Promise<Token> {
	const { token } = loaded.settings;
	const fromEnv = envValue(process.env, token.env);
	if (fromEnv !== undefined) {
		return { token: fromEnv, source: `$${token.env}` };
	}
	if (token.command !== undefined) {
		return { token: await tokenFromCommand(token.command), source: "token.command" };
	}
	const places = tokenPlaces(loaded);
	const infos = await Promise.all(places.map((place) => statIfPresent(place.file)));
	const found = places
		.map((place, index) => ({ file: place.file, info: infos[index] }))
		.find((candidate) => candidate.info?.isFile() === true);
	if (found === undefined) {
		throw new UsageError(
			`no Asana token: set $${token.env}, run "asana-gate token set", or configure token.command / token.file in settings (looked for ${places.map((place) => place.file).join(", ")})`,
		);
	}
	const value = tokenText((await readIfPresent(found.file)) ?? "", found.file);
	if (value === "") {
		throw new UsageError(`token file ${found.file} is empty`);
	}
	return { token: value, source: found.file, file: found.file, mode: found.info?.mode };
}

/** A warning when the token file can be read by other users, or `undefined`. */
function tokenFileWarning(source: TokenSource): string | undefined {
	return source.file === undefined ? undefined : exposureOf(source.file, source.mode);
}

export { tokenFileWarning, tokenOf, tokenPlaces, tokenText };
export type { TokenPlace, TokenSource };
