// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
	access,
	constants,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { applyEdits, type JSONPath, modify } from "jsonc-parser";

import { isObject, type JsonObject, parseJsonc } from "./json.ts";
import { messageOf } from "./message.ts";

/** Helpers over the file system and the environment, as settings and the command line read them. */

/** The value of an environment variable, or `undefined` when it is unset or empty. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const value = env[name];
	return value === undefined || value === "" ? undefined : value;
}

/** The `code` of a file-system error (`ENOENT`, `EEXIST`, …), when it carries one. */
function errnoOf(error: unknown): string | undefined {
	return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}

/** Whether a file-system failure means there is nothing at the path (or a file where a directory is named). */
function isMissing(error: unknown): boolean {
	const code = errnoOf(error);
	return code === "ENOENT" || code === "ENOTDIR";
}

/** The text of a file, or `undefined` when there is no such file; other failures propagate. */
async function readIfPresent(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if (isMissing(error)) {
			return undefined;
		}
		throw error;
	}
}

/** The names in a directory, or none when it cannot be listed. */
function readdirIfPresent(dir: string, options?: { recursive?: boolean }): Promise<string[]> {
	return readdir(dir, options).catch(() => [] as string[]);
}

/** `path` with its symbolic links resolved, or as it is when it cannot be (nothing is there). */
function realOf(path: string): Promise<string> {
	return realpath(path).catch(() => path);
}

/** The `stat` of a path, or `undefined` when nothing readable is there. */
async function statIfPresent(path: string): Promise<Stats | undefined> {
	try {
		return await stat(path);
	} catch {
		return undefined;
	}
}

/** Whether a directory is at `path`. */
async function isDirectory(path: string): Promise<boolean> {
	const info = await statIfPresent(path);
	return info?.isDirectory() ?? false;
}

/** Whether a regular file is at `path`. */
async function isFile(path: string): Promise<boolean> {
	const info = await statIfPresent(path);
	return info?.isFile() ?? false;
}

/** The first of `candidates` that passes `test`, probing them all at once. */
async function firstWhere<T>(
	candidates: readonly T[],
	test: (candidate: T) => Promise<boolean>,
): Promise<T | undefined> {
	const results = await Promise.all(candidates.map((candidate) => test(candidate)));
	return candidates.find((_, index) => results[index]);
}

/** Creates `dir` and its parents, readable by the owner alone, where they are missing. */
async function privateDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
}

/**
 * Writes `text` to `file`, readable by the owner alone (its directory is
 * created owner-only on the way): through a 0600 temporary file renamed over
 * it, so a reader never sees half of it, the text never lands in a file
 * others may already have open, and the file ends 0600 whatever its mode
 * was. A symbolic link at `file` is written through, as a plain write would.
 */
async function privateFile(file: string, text: string): Promise<void> {
	await privateDir(dirname(file));
	const target = await realOf(file);
	const temporary = `${target}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, text, { mode: 0o600 });
		await rename(temporary, target);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

/**
 * Why the file at `file` is not its owner's alone (its `mode` lets others in),
 * or `undefined`; modes mean nothing on Windows.
 */
function exposureOf(file: string, mode: number | undefined): string | undefined {
	if (mode === undefined || process.platform === "win32" || mode % 0o100 === 0) {
		return undefined;
	}
	return `${file} is readable by other users (mode ${(mode % 0o1000).toString(8)}); run chmod 600 on it`;
}

/** Why `dir` cannot be written to (it is created, owner-only, on the way), or `undefined` when it can. */
async function unwritable(dir: string): Promise<string | undefined> {
	try {
		await privateDir(dir);
		await access(dir, constants.W_OK);
		return undefined;
	} catch (error) {
		return messageOf(error);
	}
}

/** Why the file at `file` cannot be appended to (its directory is created on the way), or `undefined` when it can. */
async function unwritableFile(file: string): Promise<string | undefined> {
	const info = await statIfPresent(file);
	if (info === undefined) {
		return unwritable(dirname(file));
	}
	if (!info.isFile()) {
		return "not a file";
	}
	try {
		await access(file, constants.W_OK);
		return undefined;
	} catch (error) {
		return messageOf(error);
	}
}

/** Appends `line` to a text file unless it is already one of its lines; the file is created when missing. */
async function ensureLine(file: string, line: string): Promise<void> {
	const text = (await readIfPresent(file)) ?? "";
	if (text.split(/\r?\n/u).includes(line)) {
		return;
	}
	const separator = text === "" || text.endsWith("\n") ? "" : "\n";
	await writeFile(file, `${text}${separator}${line}\n`);
}

/**
 * `text` with the members that differ between the values `before` and
 * `after` rewritten in place, deepest first, so the comments and layout
 * around them stay; items appended to a list are inserted after the others.
 */
function edited(text: string, values: { before: unknown; after: unknown }, path: JSONPath): string {
	const { before, after } = values;
	if (isDeepStrictEqual(before, after)) {
		return text;
	}
	let next = text;
	if (isObject(before) && isObject(after)) {
		for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
			next = edited(next, { before: before[key], after: after[key] }, [...path, key]);
		}
		return next;
	}
	const formattingOptions = {
		insertSpaces: true,
		tabSize: 2,
		eol: text.includes("\r\n") ? "\r\n" : "\n",
	};
	const appended =
		Array.isArray(before) &&
		Array.isArray(after) &&
		before.every((item: unknown, at) => isDeepStrictEqual(item, after[at]));
	if (!appended) {
		return applyEdits(text, modify(text, path, after, { formattingOptions }));
	}
	for (let index = before.length; index < after.length; index += 1) {
		const options = { formattingOptions, isArrayInsertion: true };
		next = applyEdits(next, modify(next, [...path, index], after[index], options));
	}
	return next;
}

/**
 * Reads a JSON object file (comments and trailing commas allowed; an absent
 * file is empty) and lets `patch` change it; resolves to the write, which
 * changes only the members `patch` changed, keeping the file's comments, and
 * leaves a file that already says what `patch` wants untouched.
 */
async function patchedJson(
	file: string,
	fail: (message: string) => Error,
	patch: (document: JsonObject) => void,
): Promise<() => Promise<void>> {
	const text = await readIfPresent(file);
	const document = text === undefined ? {} : parseJsonc(text, file, fail);
	if (!isObject(document)) {
		throw fail(`${file} is not a JSON object`);
	}
	const before = structuredClone(document);
	patch(document);
	if (text !== undefined && isDeepStrictEqual(document, before)) {
		return () => Promise.resolve();
	}
	const updated =
		text === undefined
			? `${JSON.stringify(document, null, 2)}\n`
			: edited(text, { before, after: document }, []);
	return async () => {
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, updated);
	};
}

export {
	ensureLine,
	envValue,
	errnoOf,
	exposureOf,
	firstWhere,
	isDirectory,
	isFile,
	isMissing,
	patchedJson,
	privateDir,
	privateFile,
	readdirIfPresent,
	readIfPresent,
	realOf,
	statIfPresent,
	unwritable,
	unwritableFile,
};
