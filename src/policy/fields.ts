// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { actionOf, type Resource } from "../catalog/resources.ts";
import { type BranchQuery, decideRules, type Facts, rulesOf } from "./evaluate.ts";
import type { CompiledRule, Policy } from "./types.ts";

/**
 * The union of the `fields` of a file's winning allow rules, or `undefined`
 * when the file leaves the update unrestricted: no rule of it decides, or a
 * winning allow declares no `fields` (it grants the whole update), or a
 * winning deny takes the action away altogether.
 */
function layerFields(
	rules: readonly CompiledRule[],
	query: BranchQuery,
	resource: Resource,
): Set<string> | undefined {
	const { winners } = decideRules(rules, query);
	if (
		winners.length === 0 ||
		winners.some((rule) => rule.effect !== "allow" || rule.fields?.has(resource) !== true)
	) {
		return undefined;
	}
	const union = new Set<string>();
	for (const rule of winners) {
		for (const field of rule.fields?.get(resource) ?? []) {
			union.add(field);
		}
	}
	return union;
}

/** The members every list names; `undefined` for no list at all. */
function intersection(lists: readonly ReadonlySet<string>[]): Set<string> | undefined {
	const [first, ...rest] = lists;
	if (first === undefined) {
		return undefined;
	}
	let result = new Set(first);
	for (const fields of rest) {
		result = new Set([...result].filter((field) => fields.has(field)));
	}
	return result;
}

/** The allowlist of one branch: every file's list intersected (a file without one restricts nothing). */
function branchFieldAllowlist(query: BranchQuery, resource: Resource): Set<string> | undefined {
	const lists = rulesOf(query.policy)
		.map((rules) => layerFields(rules, query, resource))
		.filter((fields): fields is Set<string> => fields !== undefined);
	return intersection(lists);
}

/**
 * The fields an `update` of `resource` may touch, or `undefined` when the
 * policy does not restrict them. Per branch and file, the allowlist is the
 * union of the `fields` of the winning allow rules (a file whose winner
 * declares none restricts nothing); the files' lists are intersected, and
 * so are the branches'.
 */
function fieldAllowlist(
	policy: Policy,
	facts: Facts,
	resource: Resource,
): ReadonlySet<string> | undefined {
	const action = actionOf(resource, "update");
	const lists = facts.branches
		.map((branch) => branchFieldAllowlist({ policy, branch, facts, action }, resource))
		.filter((fields): fields is Set<string> => fields !== undefined);
	return intersection(lists);
}

export { fieldAllowlist };
