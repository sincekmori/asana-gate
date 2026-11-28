// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import type { AsanaClient } from "../asana/client.ts";
import { isAbsent } from "../asana/errors.ts";
import { type Logger, silentLogger } from "../log.ts";
import { EMPTY } from "../policy/evaluate.ts";
import { type AsanaObject, stringOf } from "./objects.ts";

/**
 * What the portfolios a policy names hold, nested portfolios included, as
 * one listing of them found it: Asana tells what a portfolio holds, not
 * which portfolios hold a project, so `where: { portfolio }` rules are
 * evaluated against this.
 */
class PortfolioIndex {
	/** project gid → the policy portfolios (transitively) containing it */
	private readonly projects = new Map<string, Set<string>>();
	/** portfolio gid → itself and the policy portfolios (transitively) containing it */
	private readonly portfolios = new Map<string, Set<string>>();
	private readonly client: AsanaClient;
	private readonly logger: Logger;

	public constructor(client: AsanaClient, logger: Logger = silentLogger) {
		this.client = client;
		this.logger = logger;
	}

	/** Lists what `roots`, the portfolios the policy names, hold; a listing that fails fails them all. */
	public async list(roots: ReadonlySet<string>): Promise<this> {
		await Promise.all([...roots].map((root) => this.walk(root, [root])));
		this.logger.debug(`portfolios listed: ${this.projects.size} projects`);
		return this;
	}

	/** The policy portfolios containing a project. */
	public containing(projectGid: string): ReadonlySet<string> {
		return this.projects.get(projectGid) ?? EMPTY;
	}

	/** A portfolio itself plus the policy portfolios containing it. */
	public lineageOf(portfolioGid: string): ReadonlySet<string> {
		return this.portfolios.get(portfolioGid) ?? new Set([portfolioGid]);
	}

	private async walk(portfolio: string, lineage: readonly string[]): Promise<void> {
		const own = this.portfolios.get(portfolio) ?? new Set<string>();
		for (const gid of lineage) {
			own.add(gid);
		}
		this.portfolios.set(portfolio, own);
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
					nested.push(this.walk(gid, [...lineage, gid]));
				}
			} else {
				const set = this.projects.get(gid) ?? new Set<string>();
				for (const ancestor of lineage) {
					set.add(ancestor);
				}
				this.projects.set(gid, set);
			}
		}
		await Promise.all(nested);
	}
}

export { PortfolioIndex };
