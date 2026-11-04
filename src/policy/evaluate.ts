// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import {
	type Action,
	actionOf,
	readActionOf,
	RESOURCE_VERBS,
	type Resource,
	verbOf,
} from "../catalog/resources.ts";
import { inScope, stateMatches } from "./state.ts";
import { type CompiledRule, type CompiledWhere, compareSpecificity, type Policy } from "./types.ts";

/**
 * One hierarchical placement of an object: the path from the workspace down
 * to it. A task that is multi-homed in several projects has one branch per
 * project; everything else has exactly one.
 */
interface Branch {
	readonly team?: string;
	/** Every portfolio (transitively) containing the project, or the portfolio itself. */
	readonly portfolios: ReadonlySet<string>;
	readonly project?: string;
	readonly section?: string;
	/** For task-derived objects: the task first, then its ancestors. */
	readonly taskChain: readonly string[];
	/** For task-derived objects: the task belongs to no project (nor any ancestor). */
	readonly unhomed: boolean;
}

/** The state of an object that policies can filter on. */
interface ObjectState {
	readonly name?: string;
	readonly createdBy?: string;
	readonly completed?: boolean;
	readonly hasParent?: boolean;
	/** The due date (`YYYY-MM-DD` or ISO 8601), or `null` when unset. */
	readonly dueOn?: string | null;
	/** ISO 8601 creation time. */
	readonly createdAt?: string;
}

/** Everything the policy can ask about an object. */
interface Facts {
	readonly workspace: string;
	readonly branches: readonly Branch[];
	/** Tags on the (underlying) task. */
	readonly tags?: ReadonlySet<string>;
	/** Assignee gid of the (underlying) task, or `null` when unassigned. */
	readonly assignee?: string | null;
	/** Per custom field gid, the value representations (option gid, option name, display value). */
	readonly customFields?: ReadonlyMap<string, ReadonlySet<string>>;
	/** The object's own state, for state predicates. */
	readonly state?: ObjectState;
}

const EMPTY: ReadonlySet<string> = new Set();

/** The branch of a workspace-level object. */
const WORKSPACE_BRANCH: Branch = { portfolios: EMPTY, taskChain: [], unhomed: false };

/** Facts of a workspace-level object (users, tags, custom field definitions, …). */
function workspaceFacts(workspace: string): Facts {
	return { workspace, branches: [WORKSPACE_BRANCH] };
}

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	for (const value of a) {
		if (b.has(value)) {
			return true;
		}
	}
	return false;
}

function hierarchyMatches(where: CompiledWhere, branch: Branch): boolean {
	const [self] = branch.taskChain;
	return (
		inScope(where.teams, branch.team) &&
		(where.portfolios === undefined || intersects(branch.portfolios, where.portfolios)) &&
		inScope(where.projects, branch.project) &&
		inScope(where.sections, branch.section) &&
		inScope(where.tasks, self) &&
		(where.subtrees === undefined ||
			branch.taskChain.some((gid) => where.subtrees?.has(gid) === true)) &&
		(where.unhomed === undefined || branch.unhomed)
	);
}

function crossMatches(where: CompiledWhere, facts: Facts): boolean {
	if (
		where.tags !== undefined &&
		(facts.tags === undefined || !intersects(facts.tags, where.tags))
	) {
		return false;
	}
	if (where.assignees !== undefined && !inScope(where.assignees, facts.assignee ?? undefined)) {
		return false;
	}
	return (where.customFields ?? []).every((predicate) => {
		const values = facts.customFields?.get(predicate.fieldGid);
		return values !== undefined && intersects(values, predicate.values);
	});
}

/** Whether a compiled scope covers a branch of an object with the given facts. */
function whereMatches(where: CompiledWhere, branch: Branch, facts: Facts): boolean {
	return (
		hierarchyMatches(where, branch) && crossMatches(where, facts) && stateMatches(where, facts)
	);
}

/** The outcome of evaluating one action in one branch. */
interface BranchDecision {
	readonly allowed: boolean;
	/** The most specific matching rules that mention the action; deny wins ties. */
	readonly winners: readonly CompiledRule[];
	/** Every matching rule that mentions the action. */
	readonly considered: readonly CompiledRule[];
}

/** What {@link decideInBranch} evaluates. */
interface BranchQuery {
	readonly policy: Policy;
	readonly branch: Branch;
	readonly facts: Facts;
	readonly action: Action;
}

/**
 * Whether an `allow` rule is a filter: narrowed by a tag, assignee, custom
 * field or state predicate. Filters may widen what can be done with objects
 * that are already visible, but never make an object visible, so their
 * `allow` of a `read` action is ignored.
 */
function isFilterRule(rule: CompiledRule): boolean {
	return rule.effect === "allow" && rule.specificity.cross > 0;
}

/** Whether a rule may decide an action here. */
function applies(rule: CompiledRule, action: Action): boolean {
	return rule.actions.has(action) && !(isFilterRule(rule) && verbOf(action) === "read");
}

/** Evaluates an action for one branch: most specific rule wins, deny wins ties, default deny. */
function decideInBranch({ policy, branch, facts, action }: BranchQuery): BranchDecision {
	const considered = policy.rules.filter(
		(rule) => applies(rule, action) && whereMatches(rule.where, branch, facts),
	);
	const [first] = considered;
	if (first === undefined) {
		return { allowed: false, winners: [], considered };
	}
	let best = first;
	for (const rule of considered) {
		if (compareSpecificity(rule.specificity, best.specificity) > 0) {
			best = rule;
		}
	}
	const winners = considered.filter(
		(rule) => compareSpecificity(rule.specificity, best.specificity) === 0,
	);
	return { allowed: winners.every((rule) => rule.effect === "allow"), winners, considered };
}

/** The outcome of evaluating one action for an object: AND over its branches. */
interface Decision {
	readonly action: Action;
	readonly allowed: boolean;
	readonly branches: readonly BranchDecision[];
}

/** Evaluates `action` for an object; every branch must allow it. */
function decide(policy: Policy, facts: Facts, action: Action): Decision {
	if (facts.workspace !== policy.workspace || facts.branches.length === 0) {
		return { action, allowed: false, branches: [] };
	}
	const branches = facts.branches.map((branch) =>
		decideInBranch({ policy, branch, facts, action }),
	);
	return { action, allowed: branches.every((b) => b.allowed), branches };
}

/** Whether `action` is allowed for an object. */
function isAllowed(policy: Policy, facts: Facts, action: Action): boolean {
	return decide(policy, facts, action).allowed;
}

/**
 * Whether an object of `resource` is visible: its `read` action is allowed.
 * Resources without a `read` verb are visible whenever their container is.
 */
function isVisible(policy: Policy, facts: Facts, resource: Resource): boolean {
	const read = readActionOf(resource);
	return read === undefined ? facts.workspace === policy.workspace : isAllowed(policy, facts, read);
}

/** The actions of `resource` currently allowed on an object (empty when invisible). */
function allowedActions(policy: Policy, facts: Facts, resource: Resource): Action[] {
	if (!isVisible(policy, facts, resource)) {
		return [];
	}
	return RESOURCE_VERBS[resource]
		.map((verb) => actionOf(resource, verb))
		.filter((action) => isAllowed(policy, facts, action));
}

function branchFieldAllowlist(query: BranchQuery, resource: Resource): Set<string> | undefined {
	const { winners } = decideInBranch(query);
	// A winning allow without `fields` for the resource grants the whole update.
	if (winners.length === 0 || winners.some((rule) => rule.fields?.has(resource) !== true)) {
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

/**
 * The fields an `update` of `resource` may touch, or `undefined` when the
 * policy does not restrict them. Per branch, the allowlist is the union of the
 * `fields` of the winning allow rules (unrestricted when any of them declares
 * none, since that rule grants the whole update); across branches, the
 * intersection.
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
	const [first, ...rest] = lists;
	if (first === undefined) {
		return undefined;
	}
	let intersection = first;
	for (const fields of rest) {
		intersection = new Set([...intersection].filter((field) => fields.has(field)));
	}
	return intersection;
}

/** A full account of how the policy treats one object, for `explain`. */
interface Explanation {
	readonly resource: Resource;
	readonly visible: boolean;
	readonly actions: readonly Decision[];
}

/** Evaluates every action of `resource` against an object's facts. */
function explainResource(policy: Policy, facts: Facts, resource: Resource): Explanation {
	const actions = RESOURCE_VERBS[resource].map((verb) =>
		decide(policy, facts, actionOf(resource, verb)),
	);
	return { resource, visible: isVisible(policy, facts, resource), actions };
}

/** The actions some `allow` statement grants somewhere in the policy. */
function grantedActions(policy: Policy): Set<Action> {
	return new Set(
		policy.rules.filter((rule) => rule.effect === "allow").flatMap((rule) => [...rule.actions]),
	);
}

export {
	allowedActions,
	decide,
	EMPTY,
	explainResource,
	fieldAllowlist,
	grantedActions,
	isAllowed,
	isFilterRule,
	isVisible,
	whereMatches,
	WORKSPACE_BRANCH,
	workspaceFacts,
};
export type { Branch, BranchDecision, BranchQuery, Decision, Explanation, Facts, ObjectState };
