// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AsanaClient } from "../src/asana/client.ts";
import { cacheEntries, clearCache, FileListingCache } from "../src/gate/listing-cache.ts";
import { AsanaNameResolver } from "../src/gate/resolver.ts";
import { silentLogger } from "../src/log.ts";

const KEY = "/workspaces/1/projects";

describe("listing cache", () => {
	it("keeps listings on disk, owner-only, and forgets them after the ttl", async () => {
		const root = await mkdtemp(join(tmpdir(), "asana-gate-cache-"));
		const dir = join(root, "cache");
		const cache = new FileListingCache({ dir, token: "t", ttlMs: 60_000 });
		await cache.set(KEY, [{ gid: "1", name: "A" }]);
		await expect(cache.get(KEY)).resolves.toStrictEqual([{ gid: "1", name: "A" }]);
		const info = await stat(dir);
		expect(info.mode % 0o1000).toBe(0o700);
		const expired = new FileListingCache({ dir, token: "t", ttlMs: -1 });
		await expect(expired.get(KEY)).resolves.toBeUndefined();
	});

	it("counts and clears the listings of every token", async () => {
		const dir = await mkdtemp(join(tmpdir(), "asana-gate-cache-"));
		const cache = new FileListingCache({ dir, token: "t", ttlMs: 60_000 });
		await cache.set(KEY, [{ gid: "1", name: "A" }]);
		await new FileListingCache({ dir, token: "u", ttlMs: 60_000 }).set(KEY, []);
		await expect(cacheEntries(dir)).resolves.toBe(2);
		await clearCache(dir);
		await expect(cache.get(KEY)).resolves.toBeUndefined();
		await expect(cacheEntries(dir)).resolves.toBe(0);
	});

	it("clears only the token directories it made, keeping other files in cache.dir", async () => {
		const dir = await mkdtemp(join(tmpdir(), "asana-gate-cache-"));
		await writeFile(join(dir, "notes.txt"), "mine");
		await mkdir(join(dir, "projects"));
		await new FileListingCache({ dir, token: "t", ttlMs: 60_000 }).set(KEY, []);
		await expect(clearCache(dir)).resolves.toBe(1);
		await expect(readdir(dir)).resolves.toStrictEqual(["notes.txt", "projects"]);
		await expect(clearCache(join(dir, "missing"))).resolves.toBe(0);
	});

	it.skipIf(process.getuid?.() === 0)(
		"stops writing after a failure, says so once, and still reads",
		async () => {
			const dir = await mkdtemp(join(tmpdir(), "asana-gate-cache-"));
			const warn = vi.fn();
			const logger = { ...silentLogger, warn };
			const cache = new FileListingCache({ dir, token: "t", ttlMs: 60_000, logger });
			await cache.set(KEY, [{ gid: "1", name: "A" }]);
			const [tokenDir = ""] = await readdir(dir);
			await chmod(join(dir, tokenDir), 0o500);
			await cache.set("/other", []);
			await cache.set("/other", []);
			expect(warn).toHaveBeenCalledOnce();
			await expect(cache.get(KEY)).resolves.toStrictEqual([{ gid: "1", name: "A" }]);
			await expect(cache.unwritable()).resolves.toMatch(/EACCES/u);
			await chmod(join(dir, tokenDir), 0o700);
		},
	);

	it("serves names from the cache and looks again live when one is missing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "asana-gate-cache-"));
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(Response.json({ data: [{ gid: "2", name: "New" }], next_page: null }));
		const cache = new FileListingCache({ dir, token: "t", ttlMs: 60_000 });
		await cache.set(KEY, [{ gid: "1", name: "Old" }]);
		const resolver = new AsanaNameResolver(new AsanaClient({ token: "t", fetch }), { cache });
		await expect(resolver.project("Old", "1")).resolves.toBe("1");
		expect(fetch).not.toHaveBeenCalled();
		await expect(resolver.project("New", "1")).resolves.toBe("2");
		expect(fetch).toHaveBeenCalledOnce();
		await expect(cache.get(KEY)).resolves.toStrictEqual([{ gid: "2", name: "New" }]);
	});
});
