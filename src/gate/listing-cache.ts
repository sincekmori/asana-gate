// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { isObject } from "../json.ts";
import { type Logger, messageOf, silentLogger } from "../log.ts";
import { privateFile, readdirIfPresent, unwritable } from "../system.ts";

/** Where listings of the workspace's structure (names and gids) are kept between runs. */
interface ListingCache {
	/** The cached items of a listing, or `undefined` when absent or too old. */
	get(key: string): Promise<unknown[] | undefined>;
	set(key: string, items: readonly unknown[]): Promise<void>;
}

/** One cached listing as written to disk. */
interface Entry {
	readonly key: string;
	readonly fetchedAt: string;
	readonly items: readonly unknown[];
}

/** Options of {@link FileListingCache}. */
interface FileListingCacheOptions {
	/** The cache directory; each token's listings go in a subdirectory of it named by a hash of the token. */
	readonly dir: string;
	/** The token the listings belong to: hashed into the directory name, never written. */
	readonly token: string;
	/** How long an entry is trusted, in milliseconds. */
	readonly ttlMs: number;
	/** Told once when the cache stops writing. */
	readonly logger?: Logger;
}

/** The first `length` hex digits of the SHA-256 of `text`. */
function digest(text: string, length: number): string {
	return createHash("sha256").update(text).digest("hex").slice(0, length);
}

/** The JSON in a file, or `undefined` when it is absent, unreadable or malformed. */
async function readJson(file: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(file, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

/** The name of a token's directory in the cache. */
const TOKEN_DIR = /^[0-9a-f]{16}$/u;

/**
 * Deletes every token's listings under `dir`: the token directories this
 * cache made, nothing else, so a `cache.dir` that holds other files keeps
 * them. Resolves to how many token directories went.
 */
async function clearCache(dir: string): Promise<number> {
	const names = await readdirIfPresent(dir);
	const owned = names.filter((name) => TOKEN_DIR.test(name));
	await Promise.all(owned.map((name) => rm(join(dir, name), { recursive: true, force: true })));
	return owned.length;
}

/** How many listings the cache under `dir` holds, over every token. */
async function cacheEntries(dir: string): Promise<number> {
	const names = await readdirIfPresent(dir, { recursive: true });
	return names.filter((name) => name.endsWith(".json")).length;
}

/**
 * A listing cache as JSON files, one per listing, each created with
 * owner-only permissions. Entries name the structure of the workspace
 * (projects, sections, tags, custom fields, …) and nothing else. A cache
 * is an optimization: when a write fails it says so once through its logger
 * and stops writing for the rest of the process, and reads go on as they can.
 */
class FileListingCache implements ListingCache {
	private readonly dir: string;
	private readonly ttlMs: number;
	private readonly logger: Logger;
	/** Set once a write failed; `set` is then a no-op. */
	private writes = true;

	public constructor(options: FileListingCacheOptions) {
		this.dir = join(options.dir, digest(options.token, 16));
		this.ttlMs = options.ttlMs;
		this.logger = options.logger ?? silentLogger;
	}

	public async get(key: string): Promise<unknown[] | undefined> {
		const entry = await readJson(this.fileOf(key));
		if (!isObject(entry) || entry.key !== key || !Array.isArray(entry.items)) {
			return undefined;
		}
		const fetchedAt = Date.parse(String(entry.fetchedAt));
		if (Number.isNaN(fetchedAt) || Date.now() - fetchedAt > this.ttlMs) {
			return undefined;
		}
		return entry.items as unknown[];
	}

	public async set(key: string, items: readonly unknown[]): Promise<void> {
		if (!this.writes) {
			return;
		}
		try {
			const entry: Entry = { key, fetchedAt: new Date().toISOString(), items };
			await privateFile(this.fileOf(key), JSON.stringify(entry));
		} catch (error) {
			this.writes = false;
			this.logger.warn(
				`cache off for this run: cannot write ${this.dir}: ${messageOf(error)}; names are read from Asana each time ("asana-gate check" reports this; cache.enabled: false makes it intended)`,
			);
		}
	}

	/** Why this token's cache directory cannot be written to, or `undefined` when it can (it is created on the way). */
	public unwritable(): Promise<string | undefined> {
		return unwritable(this.dir);
	}

	private fileOf(key: string): string {
		return join(this.dir, `${digest(key, 32)}.json`);
	}
}

export { cacheEntries, clearCache, FileListingCache };
export type { ListingCache };
