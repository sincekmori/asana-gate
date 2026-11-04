// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import type { Action, Resource } from "../catalog/resources.ts";
import type { FieldApplication, FieldRequirement, RateLimit } from "./constraints.ts";
import { type Facts, whereMatches } from "./evaluate.ts";
import {
	type CompiledConstraints,
	compareSpecificity,
	type CompiledRule,
	type Policy,
} from "./types.ts";

/** One rate limit in force, with the rule that set it. */
interface EffectiveLimit {
	readonly rule: CompiledRule;
	readonly action: Action;
	readonly limit: RateLimit;
}

/**
 * The constraints in force for one object: every matching rule's
 * requirements together, the most specific rule's application per member
 * (the stronger layer's at equal specificity), and the union of forbidden
 * members, redactions and confirmations, across every layer of the policy.
 */
interface EffectiveConstraints {
	readonly require: ReadonlyMap<Resource, ReadonlyMap<string, readonly FieldRequirement[]>>;
	readonly apply: ReadonlyMap<Resource, ReadonlyMap<string, FieldApplication>>;
	readonly forbid: ReadonlyMap<Resource, ReadonlySet<string>>;
	readonly redact: ReadonlyMap<Resource, ReadonlySet<string>>;
	readonly limits: ReadonlyMap<Action, readonly EffectiveLimit[]>;
	readonly confirm: ReadonlyMap<Action, readonly CompiledRule[]>;
	readonly labels: ReadonlyMap<string, string>;
	/** The rules that contributed, for diagnostics. */
	readonly rules: readonly CompiledRule[];
}

function mergeInto<V>(
	target: Map<Resource, Map<string, V[]>>,
	source: ReadonlyMap<Resource, ReadonlyMap<string, V>>,
): void {
	for (const [resource, members] of source) {
		const perResource = target.get(resource) ?? new Map<string, V[]>();
		for (const [member, value] of members) {
			const list = perResource.get(member) ?? [];
			list.push(value);
			perResource.set(member, list);
		}
		target.set(resource, perResource);
	}
}

function overrideInto<V>(
	target: Map<Resource, Map<string, V>>,
	source: ReadonlyMap<Resource, ReadonlyMap<string, V>>,
): void {
	for (const [resource, members] of source) {
		const perResource = target.get(resource) ?? new Map<string, V>();
		for (const [member, value] of members) {
			perResource.set(member, value);
		}
		target.set(resource, perResource);
	}
}

function unionInto(
	target: Map<Resource, Set<string>>,
	source: ReadonlyMap<Resource, ReadonlySet<string>>,
): void {
	for (const [resource, members] of source) {
		const set = target.get(resource) ?? new Set<string>();
		for (const member of members) {
			set.add(member);
		}
		target.set(resource, set);
	}
}

/** A compiled statement that carries constraints. */
type ConstrainRule = CompiledRule & { readonly constraints: CompiledConstraints };

/** The constraint statements whose scope covers any branch of `facts`, least specific first. */
function matchingConstraintRules(policy: Policy, facts: Facts): ConstrainRule[] {
	if (facts.workspace !== policy.workspace) {
		return [];
	}
	return policy.rules
		.filter(
			(rule): rule is ConstrainRule =>
				rule.constraints !== undefined &&
				facts.branches.some((branch) => whereMatches(rule.where, branch, facts)),
		)
		.toSorted(
			(a, b) =>
				compareSpecificity(a.specificity, b.specificity) || a.layer - b.layer || a.index - b.index,
		);
}

/** Computes the constraints in force for an object. */
function constraintsFor(policy: Policy, facts: Facts): EffectiveConstraints {
	const rules = matchingConstraintRules(policy, facts);
	const require = new Map<Resource, Map<string, FieldRequirement[]>>();
	const apply = new Map<Resource, Map<string, FieldApplication>>();
	const forbid = new Map<Resource, Set<string>>();
	const redact = new Map<Resource, Set<string>>();
	const limits = new Map<Action, EffectiveLimit[]>();
	const confirm = new Map<Action, CompiledRule[]>();
	const labels = new Map<string, string>();
	for (const rule of rules) {
		const { constraints } = rule;
		mergeInto(require, constraints.require);
		overrideInto(apply, constraints.apply);
		unionInto(forbid, constraints.forbid);
		unionInto(redact, constraints.redact);
		for (const [action, limit] of constraints.limit) {
			limits.set(action, [...(limits.get(action) ?? []), { rule, action, limit }]);
		}
		for (const action of constraints.confirm) {
			confirm.set(action, [...(confirm.get(action) ?? []), rule]);
		}
		for (const [key, label] of constraints.labels) {
			labels.set(key, label);
		}
	}
	return { require, apply, forbid, redact, limits, confirm, labels, rules };
}

/** Whether any rule of the policy carries constraints (a cheap pre-check). */
function hasConstraints(policy: Policy): boolean {
	return policy.rules.some((rule) => rule.constraints !== undefined);
}

/** The human name of a member key (a custom field by its name), for messages. */
function labelOf(effective: EffectiveConstraints, key: string): string {
	return effective.labels.get(key) ?? key;
}

export { constraintsFor, hasConstraints, labelOf };
export type { EffectiveConstraints, EffectiveLimit };
