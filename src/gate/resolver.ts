// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import type { AsanaClient } from "../asana/client.ts";
import { isAbsent } from "../asana/errors.ts";
import type { QueryValue } from "../asana/query.ts";
import type { CustomFieldDefinition, NameResolver } from "../policy/compile.ts";
import { isGid, matches } from "../policy/schema.ts";
import { type Me, PolicyError } from "../policy/types.ts";
import type { ListingCache } from "./listing-cache.ts";
import { type AsanaObject, refsOf, stringOf } from "./objects.ts";

interface Named {
	readonly gid: string;
	readonly name: string;
}

/** Where a listing comes from, and how much of it to read. */
interface ListSource {
	readonly path: string;
	readonly query?: Record<string, QueryValue>;
	/** Stop after this many picked items. */
	readonly max?: number;
}

/** Reads a paginated listing, keeping what `pick` returns for each item. */
async function collect<T>(
	client: AsanaClient,
	source: ListSource,
	pick: (item: AsanaObject) => T | undefined,
): Promise<T[]> {
	const items: T[] = [];
	const max = source.max ?? Number.POSITIVE_INFINITY;
	for await (const item of client.paginate<AsanaObject>(source.path, source.query)) {
		const picked = pick(item);
		if (picked !== undefined) {
			items.push(picked);
		}
		if (items.length >= max) {
			break;
		}
	}
	return items;
}

/** Picks `{ gid, name }` from an item that carries both. */
function named(item: AsanaObject): Named | undefined {
	const gid = stringOf(item.gid);
	const name = stringOf(item.name);
	return gid === undefined || name === undefined ? undefined : { gid, name };
}

/** The key a listing is cached under: its path and query. */
function keyOf(listing: ListSource): string {
	const query = new URLSearchParams(listing.query as Record<string, string>).toString();
	return query === "" ? listing.path : `${listing.path}?${query}`;
}

/** A listing the resolver reads, and how its items are picked. */
interface Listing<T> extends ListSource {
	readonly pick: (item: AsanaObject) => T | undefined;
}

/** A listing's items, and whether they came from the cache rather than Asana. */
interface Read<T> {
	readonly items: readonly T[];
	readonly cached: boolean;
}

function pickUnique<T extends Named>(kind: string, ref: string, found: readonly T[]): T {
	const [first, second] = found;
	if (first === undefined) {
		throw new PolicyError(`${kind} "${ref}" was not found`);
	}
	if (second !== undefined) {
		throw new PolicyError(
			`${kind} "${ref}" is ambiguous (${found.map((m) => m.gid).join(", ")}); use the gid instead`,
		);
	}
	return first;
}

/** Options of {@link AsanaNameResolver}. */
interface ResolverOptions {
	/** Keeps listings between runs; without it, each resolver reads every listing it needs once. */
	readonly cache?: ListingCache;
}

/** A custom field definition from a listing item or the field itself. */
function fieldDefinition(item: AsanaObject): CustomFieldDefinition | undefined {
	const base = named(item);
	const options = refsOf(item.enum_options).map((o) => ({ gid: o.gid, name: o.name ?? "" }));
	return base === undefined ? undefined : { ...base, enumOptions: options };
}

/**
 * Resolves names in a policy against Asana. Listings are read once per
 * resolver, and kept between runs when a cache is given. A name missing from
 * a cached listing is looked up live before it counts as unknown, so a
 * project created yesterday resolves even though the listing is older.
 */
class AsanaNameResolver implements NameResolver {
	private readonly client: AsanaClient;
	private readonly cache: ListingCache | undefined;
	private readonly listings = new Map<string, Promise<Read<unknown>>>();
	/** The listings read live again after a cached copy lacked a name, so that happens once each. */
	private readonly refreshed = new Set<string>();
	private meOnce: Promise<Me> | undefined = undefined;
	/** Users looked up by email, per workspace: a policy names the same people many times. */
	private readonly users = new Map<string, Promise<string>>();
	/** Custom fields looked up, per workspace and reference. */
	private readonly fields = new Map<string, Promise<CustomFieldDefinition>>();

	public constructor(client: AsanaClient, options: ResolverOptions = {}) {
		this.client = client;
		this.cache = options.cache;
	}

	public async workspace(ref: string): Promise<Named> {
		const match = await this.select({ path: "/workspaces", pick: named }, matches(ref));
		return pickUnique("workspace", ref, match);
	}

	public me(): Promise<Me> {
		this.meOnce ??= this.fetchMe();
		return this.meOnce;
	}

	private async fetchMe(): Promise<Me> {
		const user = await this.client.get<AsanaObject>("/users/me", { opt_fields: ["name", "email"] });
		const gid = stringOf(user.gid);
		if (gid === undefined) {
			throw new PolicyError("GET /users/me returned no gid");
		}
		const email = stringOf(user.email);
		const name = stringOf(user.name);
		return { gid, ...(email !== undefined && { email }), ...(name !== undefined && { name }) };
	}

	public team(ref: string, workspace: string): Promise<string> {
		return this.byName("team", ref, { path: `/workspaces/${workspace}/teams` });
	}

	public portfolio(ref: string, workspace: string): Promise<string> {
		// Only the token owner's portfolios are listable; use the gid for others.
		return this.byName("portfolio", ref, {
			path: "/portfolios",
			query: { workspace, owner: "me" },
		});
	}

	public project(ref: string, workspace: string): Promise<string> {
		return this.byName("project", ref, { path: `/workspaces/${workspace}/projects` });
	}

	public section(ref: string, project: string): Promise<string> {
		return this.byName("section", ref, { path: `/projects/${project}/sections` });
	}

	public tag(ref: string, workspace: string): Promise<string> {
		return this.byName("tag", ref, { path: `/workspaces/${workspace}/tags` });
	}

	public async user(ref: string, workspace: string): Promise<string> {
		if (isGid(ref)) {
			return ref;
		}
		if (ref === "me") {
			const me = await this.me();
			return me.gid;
		}
		const key = `${workspace}\0${ref}`;
		let pending = this.users.get(key);
		if (pending === undefined) {
			pending = this.fetchUser(ref, workspace);
			this.users.set(key, pending);
		}
		return pending;
	}

	private async fetchUser(ref: string, workspace: string): Promise<string> {
		try {
			const user = await this.client.get<AsanaObject>(`/users/${encodeURIComponent(ref)}`, {
				workspace,
				opt_fields: ["name"],
			});
			const gid = stringOf(user.gid);
			if (gid !== undefined) {
				return gid;
			}
		} catch (error) {
			if (!isAbsent(error)) {
				throw error;
			}
		}
		throw new PolicyError(`user "${ref}" was not found (use "me", a gid or an email)`);
	}

	/** A custom field the policy names; one it names several times is looked up once. */
	public customField(ref: string, workspace: string): Promise<CustomFieldDefinition> {
		const key = `${workspace}\0${ref}`;
		let found = this.fields.get(key);
		if (found === undefined) {
			found = this.lookUpField(ref, workspace);
			this.fields.set(key, found);
		}
		return found;
	}

	private async lookUpField(ref: string, workspace: string): Promise<CustomFieldDefinition> {
		// A gid names the field itself, which a project-local field needs: the
		// workspace listing may not carry it.
		const direct = isGid(ref) ? await this.fieldByGid(ref) : undefined;
		if (direct !== undefined) {
			return direct;
		}
		const fields = await this.select(
			{
				path: `/workspaces/${workspace}/custom_fields`,
				query: { opt_fields: ["name", "enum_options.name"] },
				pick: fieldDefinition,
			},
			matches(ref),
		);
		return pickUnique("custom field", ref, fields);
	}

	private async fieldByGid(gid: string): Promise<CustomFieldDefinition | undefined> {
		try {
			const field = await this.client.get<AsanaObject>(`/custom_fields/${gid}`, {
				opt_fields: ["name", "enum_options.name"],
			});
			return fieldDefinition(field);
		} catch (error) {
			if (isAbsent(error)) {
				return undefined;
			}
			throw error;
		}
	}

	private async byName(kind: string, ref: string, source: ListSource): Promise<string> {
		if (isGid(ref)) {
			return ref;
		}
		const found = await this.select({ ...source, pick: named }, (item) => item.name === ref);
		return pickUnique(kind, ref, found).gid;
	}

	/** The items of a listing that pass `keep`; a cached listing where none does is read again live first. */
	private async select<T>(listing: Listing<T>, keep: (item: T) => boolean): Promise<T[]> {
		const first = await this.read(listing, false);
		const chosen = first.items.filter((item) => keep(item));
		if (chosen.length > 0 || !first.cached) {
			return chosen;
		}
		const fresh = await this.read(listing, true);
		return fresh.items.filter((item) => keep(item));
	}

	/** The listing, shared by everyone asking for it; `refresh` replaces a cached one with a live read, once. */
	private read<T>(listing: Listing<T>, refresh: boolean): Promise<Read<T>> {
		const key = keyOf(listing);
		const stale = refresh && !this.refreshed.has(key);
		const pending = stale ? undefined : this.listings.get(key);
		if (pending !== undefined) {
			return pending as Promise<Read<T>>;
		}
		if (refresh) {
			this.refreshed.add(key);
		}
		const fetched = this.fetch(key, listing, refresh);
		this.listings.set(key, fetched);
		return fetched;
	}

	private async fetch<T>(key: string, listing: Listing<T>, refresh: boolean): Promise<Read<T>> {
		const cached = refresh ? undefined : await this.cache?.get(key);
		if (cached !== undefined) {
			return { items: cached as T[], cached: true };
		}
		const query = { ...listing.query, opt_fields: listing.query?.opt_fields ?? ["name"] };
		const items = await collect(this.client, { ...listing, query }, listing.pick);
		await this.cache?.set(key, items);
		return { items, cached: false };
	}
}

export { AsanaNameResolver, collect, named };
export { matches } from "../policy/schema.ts";
export type { ListSource, Named, ResolverOptions };
