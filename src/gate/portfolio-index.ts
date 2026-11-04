// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import type { AsanaClient } from "../asana/client.ts";
import { isAbsent } from "../asana/errors.ts";
import { type Logger, silentLogger } from "../log.ts";
import { EMPTY } from "../policy/evaluate.ts";
import { type AsanaObject, stringOf } from "./objects.ts";

interface Index {
	/** project gid → the policy portfolios (transitively) containing it */
	readonly projects: Map<string, Set<string>>;
	/** portfolio gid → itself and the policy portfolios (transitively) containing it */
	readonly portfolios: Map<string, Set<string>>;
}

/** Options for {@link PortfolioIndex}. */
interface PortfolioIndexOptions {
	readonly client: AsanaClient;
	/** The portfolios the policy names. */
	readonly roots: ReadonlySet<string>;
	/** How long a snapshot is reused, in milliseconds. */
	readonly ttlMs: number;
	readonly logger?: Logger;
}

/**
 * Knows which projects (and nested portfolios) the portfolios named by the
 * policy contain, so `where: { portfolio }` rules can be evaluated without
 * an Asana call per request. Rebuilt lazily once the snapshot is older than
 * the TTL.
 */
class PortfolioIndex {
	private readonly client: AsanaClient;
	private readonly roots: ReadonlySet<string>;
	private readonly ttlMs: number;
	private readonly logger: Logger;
	private index: Index | undefined = undefined;
	private builtAt = 0;
	private building: Promise<Index> | undefined = undefined;
	/** Bumped by every invalidation, so a build that saw older contents is not kept. */
	private generation = 0;

	public constructor(options: PortfolioIndexOptions) {
		this.client = options.client;
		this.roots = options.roots;
		this.ttlMs = options.ttlMs;
		this.logger = options.logger ?? silentLogger;
	}

	/** The policy portfolios containing a project. */
	public async containing(projectGid: string): Promise<ReadonlySet<string>> {
		if (this.roots.size === 0) {
			return EMPTY;
		}
		const index = await this.current();
		return index.projects.get(projectGid) ?? EMPTY;
	}

	/** A portfolio itself plus the policy portfolios containing it. */
	public async lineageOf(portfolioGid: string): Promise<ReadonlySet<string>> {
		if (this.roots.size === 0) {
			return new Set([portfolioGid]);
		}
		const index = await this.current();
		return index.portfolios.get(portfolioGid) ?? new Set([portfolioGid]);
	}

	/**
	 * Drops the snapshot after a write to `portfolioGid` when it (or one being
	 * built) may list it, so the next lookup rebuilds it; a build under way is
	 * not kept either.
	 */
	public invalidateFor(portfolioGid: string): void {
		if (this.building !== undefined || this.index?.portfolios.has(portfolioGid) === true) {
			this.index = undefined;
			this.generation += 1;
		}
	}

	private current(): Promise<Index> {
		if (this.index !== undefined && Date.now() - this.builtAt < this.ttlMs) {
			return Promise.resolve(this.index);
		}
		this.building ??= this.buildOnce();
		return this.building;
	}

	private async buildOnce(): Promise<Index> {
		try {
			return await this.build();
		} finally {
			this.building = undefined;
		}
	}

	private async build(): Promise<Index> {
		const started = this.generation;
		const index: Index = { projects: new Map(), portfolios: new Map() };
		// A failed walk fails the build: nothing is kept, and the next lookup tries again.
		await Promise.all([...this.roots].map((root) => this.walk(root, [root], index)));
		if (this.generation !== started) {
			// A portfolio changed while it was listed: list again.
			return this.build();
		}
		this.index = index;
		this.builtAt = Date.now();
		this.logger.debug(`portfolio index built: ${index.projects.size} projects`);
		return index;
	}

	private async walk(portfolio: string, lineage: readonly string[], index: Index): Promise<void> {
		const own = index.portfolios.get(portfolio) ?? new Set<string>();
		for (const gid of lineage) {
			own.add(gid);
		}
		index.portfolios.set(portfolio, own);
		const items: AsanaObject[] = [];
		try {
			for await (const item of this.client.paginate<AsanaObject>(`/portfolios/${portfolio}/items`, {
				opt_fields: ["resource_type"],
			})) {
				items.push(item);
			}
		} catch (error) {
			// Only a portfolio that is not there (or not readable) is empty; a rate
			// limit or an expired token fails the request instead of silently
			// dropping the portfolio's rules.
			if (isAbsent(error)) {
				this.logger.warn(
					`portfolio ${portfolio} is not readable (${error.status}); treating as empty`,
				);
				return;
			}
			throw error;
		}
		const nested: Promise<void>[] = [];
		for (const item of items) {
			const gid = stringOf(item.gid) ?? "";
			if (gid === "") {
				this.logger.debug(`portfolio ${portfolio}: skipping an item without a gid`);
			} else if (item.resource_type === "portfolio") {
				if (!lineage.includes(gid)) {
					nested.push(this.walk(gid, [...lineage, gid], index));
				}
			} else {
				const set = index.projects.get(gid) ?? new Set<string>();
				for (const ancestor of lineage) {
					set.add(ancestor);
				}
				index.projects.set(gid, set);
			}
		}
		await Promise.all(nested);
	}
}

export { PortfolioIndex };
export type { PortfolioIndexOptions };
