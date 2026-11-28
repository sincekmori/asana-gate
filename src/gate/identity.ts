// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import type { AsanaClient } from "../asana/client.ts";
import { isAbsent } from "../asana/errors.ts";
import type { QueryValue } from "../asana/query.ts";
import { compilePolicies, governedWorkspace, type PolicySource } from "../policy/compile.ts";
import { type Me, type Policy, PolicyError } from "../policy/types.ts";
import { type AsanaObject, stringOf } from "./objects.ts";

/**
 * What a policy leaves to Asana: who the token belongs to (the `me` a rule
 * may name) and what its workspace is called. Everything else a policy
 * names, it names by gid.
 */

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

/** Who the client's token belongs to. */
async function whoAmI(client: AsanaClient): Promise<Me> {
	const user = await client.get<AsanaObject>("/users/me", { opt_fields: ["name", "email"] });
	const gid = stringOf(user.gid);
	if (gid === undefined) {
		throw new PolicyError("GET /users/me returned no gid");
	}
	const email = stringOf(user.email);
	const name = stringOf(user.name);
	return { gid, ...(email !== undefined && { email }), ...(name !== undefined && { name }) };
}

/** What the workspace a policy governs is called; one the token does not see is an error. */
async function workspaceNamed(client: AsanaClient, gid: string): Promise<string> {
	try {
		const workspace = await client.get<AsanaObject>(`/workspaces/${encodeURIComponent(gid)}`, {
			opt_fields: ["name"],
		});
		return stringOf(workspace.name) ?? gid;
	} catch (error) {
		if (isAbsent(error)) {
			throw new PolicyError(
				`workspace ${gid} was not found (deleted, or not visible to this token)`,
			);
		}
		throw error;
	}
}

/** The policy of `sources`, compiled for the client's token with what Asana tells of it. */
async function policyFor(client: AsanaClient, sources: readonly PolicySource[]): Promise<Policy> {
	const [me, workspaceName] = await Promise.all([
		whoAmI(client),
		workspaceNamed(client, governedWorkspace(sources)),
	]);
	return compilePolicies(sources, { me, workspaceName });
}

export { collect, named, policyFor, whoAmI };
export type { ListSource, Named };
