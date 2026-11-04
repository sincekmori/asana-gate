// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import type { Action, Resource } from "../catalog/resources.ts";
import type { FieldApplication, FieldRequirement, RateLimit } from "./constraints.ts";
import type { PolicyRule } from "./schema.ts";

/** A policy file is malformed, references something unknown, or is ambiguous. */
class PolicyError extends Error {
	public override readonly name: string = "PolicyError";
}

/**
 * How specific a rule's scope is. `level` is the hierarchy level
 * (workspace 0, team/portfolio/unhomed 1, project 2, section 3, subtree 4,
 * task 5); `cross` counts the cross-cutting predicates (tag, assignee,
 * custom field) that narrow it further. Compared lexicographically.
 */
interface Specificity {
	readonly level: number;
	readonly cross: number;
}

/** Hierarchy levels of the `where` axes. */
const LEVELS = {
	workspace: 0,
	team: 1,
	portfolio: 1,
	unhomed: 1,
	project: 2,
	section: 3,
	subtree: 4,
	task: 5,
} as const;

/** `custom_field` predicate: the field (by gid) must hold one of `values`. */
interface CompiledCustomFieldPredicate {
	readonly fieldGid: string;
	/** Accepted values: enum option gids, option names and display values. */
	readonly values: ReadonlySet<string>;
	/** Values the policy wrote that match no option of an enum field: a typo, or an option since removed. */
	readonly unmatched?: readonly string[];
}

/** A compiled predicate on an object's name. */
interface CompiledNamePredicate {
	readonly prefix?: string;
	readonly suffix?: string;
	readonly contains?: string;
	readonly matches?: RegExp;
}

/** A `where` clause with every name resolved to gids. */
interface CompiledWhere {
	readonly teams?: ReadonlySet<string>;
	readonly portfolios?: ReadonlySet<string>;
	readonly projects?: ReadonlySet<string>;
	readonly sections?: ReadonlySet<string>;
	readonly tasks?: ReadonlySet<string>;
	readonly subtrees?: ReadonlySet<string>;
	readonly unhomed?: true;
	readonly tags?: ReadonlySet<string>;
	readonly assignees?: ReadonlySet<string>;
	readonly customFields?: readonly CompiledCustomFieldPredicate[];
	readonly createdBy?: ReadonlySet<string>;
	readonly completed?: boolean;
	readonly hasParent?: boolean;
	readonly name?: CompiledNamePredicate;
	readonly overdue?: boolean;
	readonly dueWithinMs?: number;
	readonly createdWithinMs?: number;
}

/** The content constraints of one rule, with names resolved. Member keys are `name` or `custom_fields.<gid>`. */
interface CompiledConstraints {
	readonly require: ReadonlyMap<Resource, ReadonlyMap<string, FieldRequirement>>;
	readonly apply: ReadonlyMap<Resource, ReadonlyMap<string, FieldApplication>>;
	readonly forbid: ReadonlyMap<Resource, ReadonlySet<string>>;
	readonly redact: ReadonlyMap<Resource, ReadonlySet<string>>;
	readonly limit: ReadonlyMap<Action, RateLimit>;
	readonly confirm: ReadonlySet<Action>;
	/** Human names for `custom_fields.<gid>` keys, for messages. */
	readonly labels: ReadonlyMap<string, string>;
}

/** Where a policy file sits: the project's (or the one pointed at), the user's own, or an administrator's. */
type LayerRole = "project" | "user" | "managed";

/** Layers from the weakest to the strongest: at equal specificity, the stronger layer's `apply` wins. */
const LAYER_RANK: Readonly<Record<LayerRole, number>> = { user: 0, project: 1, managed: 2 };

/**
 * One policy file of the policy in force. The files are peers: an action is
 * allowed only when every file in force allows it, so each one bounds the
 * others; their order matters for `apply` ties alone.
 */
interface PolicyLayer {
	/** The file, for messages. */
	readonly file: string;
	readonly role: LayerRole;
	/** The other workspace the file names, when it does: the file is then not in force here. */
	readonly otherWorkspace?: string;
}

/**
 * One statement of a rule with a resolved scope: an `allow`, a `deny`, or
 * the rule's constraints (`constrain`, which takes no part in permission
 * decisions).
 */
interface CompiledRule {
	/** Index of the rule in the policy file (one file rule may yield several statements). */
	readonly index: number;
	/** The layer (index into {@link Policy.layers}) the rule comes from. */
	readonly layer: number;
	readonly effect: "allow" | "deny" | "constrain";
	readonly where: CompiledWhere;
	readonly actions: ReadonlySet<Action>;
	/** Field allowlists for `<resource>:update`, when the rule declares any. */
	readonly fields?: ReadonlyMap<Resource, ReadonlySet<string>>;
	/** The content constraints, on `constrain` statements. */
	readonly constraints?: CompiledConstraints;
	readonly specificity: Specificity;
	/** The rule as written, for diagnostics. */
	readonly raw: PolicyRule;
}

/** The current user the token belongs to. */
interface Me {
	readonly gid: string;
	readonly email?: string;
	readonly name?: string;
}

/** A policy ready for evaluation. */
interface Policy {
	/** The gid of the governed workspace. */
	readonly workspace: string;
	readonly workspaceName: string;
	readonly me: Me;
	/** The policy files, from the weakest to the strongest ({@link LAYER_RANK}); every one of them must allow an action. */
	readonly layers: readonly PolicyLayer[];
	readonly rules: readonly CompiledRule[];
}

/** Compares specificities: positive when `a` is more specific than `b`. */
function compareSpecificity(a: Specificity, b: Specificity): number {
	return a.level - b.level || a.cross - b.cross;
}

/** How messages name a rule: `rules[2]`, or `user rules[2]` when the policy has several layers. */
function ruleLabel(policy: Policy, rule: Pick<CompiledRule, "index" | "layer">): string {
	const role = policy.layers.length > 1 ? `${policy.layers[rule.layer]?.role ?? "?"} ` : "";
	return `${role}rules[${rule.index}]`;
}

export { compareSpecificity, LAYER_RANK, LEVELS, PolicyError, ruleLabel };
export type {
	CompiledConstraints,
	CompiledCustomFieldPredicate,
	CompiledNamePredicate,
	CompiledRule,
	CompiledWhere,
	LayerRole,
	Me,
	Policy,
	PolicyLayer,
	Specificity,
};
