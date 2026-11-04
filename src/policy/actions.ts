// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import {
	type Action,
	actionOf,
	ALL_ACTIONS,
	EXPLICIT_ONLY_ACTIONS,
	isAction,
	isResource,
	RESOURCE_VERBS,
	type Resource,
	VERB_TIERS,
	verbOf,
} from "../catalog/resources.ts";
import { PolicyError } from "./types.ts";

/** A group name a policy may use in `allow` / `deny` lists. */
type ActionGroup = "read" | "modify" | "write" | "admin";

/**
 * The verb tiers each group stands for: `read`, `modify` (every verb but
 * read), `write` (read plus the everyday modifying verbs) and `admin`
 * (everything).
 */
const GROUP_TIERS: Record<ActionGroup, readonly (keyof typeof VERB_TIERS)[]> = {
	read: ["read"],
	modify: ["write", "admin"],
	write: ["read", "write"],
	admin: ["read", "write", "admin"],
};

/** The group names, as the documentation lists them. */
const ACTION_GROUPS = Object.keys(GROUP_TIERS) as ActionGroup[];

const isGroup = (value: string): value is ActionGroup => Object.hasOwn(GROUP_TIERS, value);

/** Options of {@link expandActionPattern}. */
interface ExpandOptions {
	/**
	 * Whether the actions are granted (`allow`, the default). Groups and
	 * wildcards never grant the explicit-only actions, but where they restrict
	 * (`deny`, `confirm`, `limit`) they cover them like any other action.
	 */
	readonly grant?: boolean;
}

/** Drops the explicit-only actions when granting. */
const forUse = (actions: Iterable<Action>, grant: boolean): Action[] =>
	[...actions].filter((action) => !grant || !EXPLICIT_ONLY_ACTIONS.has(action));

/** The concrete actions a group stands for (explicit-only actions excluded when granting). */
function expandGroup(group: ActionGroup, grant = true): Action[] {
	const verbs = new Set(GROUP_TIERS[group].flatMap((tier) => [...VERB_TIERS[tier]]));
	return forUse(
		ALL_ACTIONS.filter((action) => verbs.has(verbOf(action))),
		grant,
	);
}

function expandWildcardVerb(verb: string, pattern: string, grant: boolean): Action[] {
	const all = ALL_ACTIONS.filter((action) => verbOf(action) === verb);
	if (all.length === 0) {
		throw new PolicyError(`unknown verb "${verb}" in action "${pattern}"`);
	}
	return forUse(all, grant);
}

/** A literal `<resource>:<verb>` action, checked against the resource's verbs. */
function literalAction(resource: Resource, verb: string, pattern: string): Action[] {
	if (!isAction(pattern)) {
		throw new PolicyError(
			`unknown verb "${verb}" for resource "${resource}" (valid: ${RESOURCE_VERBS[resource].join(", ")})`,
		);
	}
	return [pattern];
}

/**
 * Expands one `allow` / `deny` entry into concrete actions.
 *
 * Accepted forms: a group (`read`, `modify`, `write`, `admin`), `*` (same as
 * `admin`), `<resource>:*`, `*:<verb>` and a literal `<resource>:<verb>`.
 * Groups and wildcards never grant the explicit-only actions; those must be
 * written literally to be allowed. With `grant: false` (deny, confirm, limit)
 * groups and wildcards cover them too.
 */
function expandActionPattern(pattern: string, options: ExpandOptions = {}): Action[] {
	const grant = options.grant ?? true;
	const trimmed = pattern.trim();
	if (isGroup(trimmed)) {
		return expandGroup(trimmed, grant);
	}
	if (trimmed === "*" || trimmed === "*:*") {
		return expandGroup("admin", grant);
	}
	const separator = trimmed.indexOf(":");
	if (separator === -1) {
		throw new PolicyError(
			`unknown action "${pattern}": expected <resource>:<verb>, <resource>:*, *:<verb> or a group (${ACTION_GROUPS.join(", ")})`,
		);
	}
	const resource = trimmed.slice(0, separator);
	const verb = trimmed.slice(separator + 1);
	if (resource === "*") {
		return expandWildcardVerb(verb, pattern, grant);
	}
	if (!isResource(resource)) {
		throw new PolicyError(`unknown resource "${resource}" in action "${pattern}"`);
	}
	if (verb === "*") {
		return forUse(
			RESOURCE_VERBS[resource].map((v) => actionOf(resource, v)),
			grant,
		);
	}
	return literalAction(resource, verb, trimmed);
}

/** Expands a whole `allow` / `deny` / `confirm` list into a set of concrete actions. */
function expandActionPatterns(
	patterns: readonly string[],
	options: ExpandOptions = {},
): Set<Action> {
	const actions = new Set<Action>();
	for (const pattern of patterns) {
		for (const action of expandActionPattern(pattern, options)) {
			actions.add(action);
		}
	}
	return actions;
}

export { expandActionPattern, expandActionPatterns, expandGroup };
export type { ActionGroup, ExpandOptions };
