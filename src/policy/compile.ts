// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import {
	type Action,
	actionOf,
	FIELD_VERBS,
	isResource,
	type Resource,
	RESOURCE_VERBS,
} from "../catalog/resources.ts";
import { expandActionPatterns } from "./actions.ts";
import { assertRequestMember, compileConstraints } from "./compile-constraints.ts";
import { isGid, type PolicyFile, type PolicyRule, type PolicyWhere } from "./schema.ts";
import { compileState, specificityOf } from "./scope.ts";
import {
	type CompiledCustomFieldPredicate,
	type CompiledRule,
	type CompiledWhere,
	type Me,
	type Policy,
	PolicyError,
} from "./types.ts";

/** A custom field definition, as far as compilation needs it. */
interface CustomFieldDefinition {
	readonly gid: string;
	readonly name: string;
	readonly enumOptions: readonly { gid: string; name: string }[];
}

/**
 * Turns names in a policy into gids. Implemented against the Asana API by the
 * gate; tests supply a fake. Every method receives the governed workspace gid.
 * Implementations throw {@link PolicyError} for unknown or ambiguous names.
 */
interface NameResolver {
	workspace(ref: string): Promise<{ gid: string; name: string }>;
	me(): Promise<Me>;
	team(ref: string, workspace: string): Promise<string>;
	portfolio(ref: string, workspace: string): Promise<string>;
	project(ref: string, workspace: string): Promise<string>;
	/** Resolves a section name inside one project. */
	section(ref: string, project: string): Promise<string>;
	tag(ref: string, workspace: string): Promise<string>;
	/** Resolves `me`, a gid or an email to a user gid. */
	user(ref: string, workspace: string): Promise<string>;
	customField(ref: string, workspace: string): Promise<CustomFieldDefinition>;
}

function list<T>(value: T | T[] | undefined): T[] {
	if (value === undefined) {
		return [];
	}
	return Array.isArray(value) ? value : [value];
}

/** Gids as written plus the names resolved (each to one gid or several). */
async function resolveAll(
	refs: readonly string[],
	resolve: (ref: string) => Promise<string | readonly string[]>,
): Promise<ReadonlySet<string> | undefined> {
	if (refs.length === 0) {
		return undefined;
	}
	const resolved = await Promise.all(refs.filter((ref) => !isGid(ref)).map((ref) => resolve(ref)));
	return new Set([...refs.filter((ref) => isGid(ref)), ...resolved.flat()]);
}

async function compileCustomFieldPredicate(
	ref: string,
	value: NonNullable<PolicyWhere["custom_field"]>[string],
	context: { resolver: NameResolver; workspace: string },
): Promise<CompiledCustomFieldPredicate> {
	const definition = await context.resolver.customField(ref, context.workspace);
	const values = new Set<string>();
	const unmatched: string[] = [];
	for (const raw of list(value)) {
		const text = String(raw);
		values.add(text);
		// An enum option named in the policy also matches by its gid, so a renamed
		// option keeps matching tasks that carry it.
		const option = definition.enumOptions.find((o) => o.name === text || o.gid === text);
		if (option) {
			values.add(option.gid);
			values.add(option.name);
		} else if (definition.enumOptions.length > 0) {
			unmatched.push(text);
		}
	}
	return { fieldGid: definition.gid, values, ...(unmatched.length > 0 && { unmatched }) };
}

async function compileWhere(
	where: PolicyWhere | undefined,
	resolver: NameResolver,
	workspace: string,
): Promise<CompiledWhere> {
	if (where === undefined) {
		return {};
	}
	const projects = await resolveAll(list(where.project), (ref) => resolver.project(ref, workspace));
	const [sections, teams, portfolios, tags, assignees, createdBy, customFields] = await Promise.all(
		[
			// A section name is resolved in every project of the rule; a project without
			// a section of that name is an error, which surfaces a typo early.
			resolveAll(list(where.section), (ref) =>
				Promise.all([...(projects ?? [])].map((project) => resolver.section(ref, project))),
			),
			resolveAll(list(where.team), (ref) => resolver.team(ref, workspace)),
			resolveAll(list(where.portfolio), (ref) => resolver.portfolio(ref, workspace)),
			resolveAll(list(where.tag), (ref) => resolver.tag(ref, workspace)),
			resolveAll(list(where.assignee), (ref) => resolver.user(ref, workspace)),
			resolveAll(list(where.created_by), (ref) => resolver.user(ref, workspace)),
			Promise.all(
				Object.entries(where.custom_field ?? {}).map(([ref, value]) =>
					compileCustomFieldPredicate(ref, value, { resolver, workspace }),
				),
			),
		],
	);
	const tasks = list(where.task);
	const subtrees = list(where.subtree);
	return {
		...(teams && { teams }),
		...(portfolios && { portfolios }),
		...(projects && { projects }),
		...(sections && { sections }),
		...(tasks.length > 0 && { tasks: new Set(tasks) }),
		...(subtrees.length > 0 && { subtrees: new Set(subtrees) }),
		...(where.unhomed === true && { unhomed: true as const }),
		...(tags && { tags }),
		...(assignees && { assignees }),
		...(customFields.length > 0 && { customFields }),
		...(createdBy && { createdBy }),
		...compileState(where),
	};
}

function compileFields(
	fields: PolicyRule["fields"],
	allowed: Set<Action>,
	index: number,
): ReadonlyMap<Resource, ReadonlySet<string>> | undefined {
	if (fields === undefined) {
		return undefined;
	}
	const map = new Map<Resource, ReadonlySet<string>>();
	for (const [resource, names] of Object.entries(fields)) {
		if (!isResource(resource)) {
			throw new PolicyError(`rules[${index}].fields: unknown resource "${resource}"`);
		}
		if (!(RESOURCE_VERBS[resource] as readonly string[]).includes("update")) {
			throw new PolicyError(`rules[${index}].fields: ${resource} has no update verb`);
		}
		allowed.add(actionOf(resource, "update"));
		for (const name of names) {
			assertRequestMember(resource, name, `rules[${index}].fields`);
			const verb = FIELD_VERBS[resource]?.[name];
			if (verb !== undefined) {
				allowed.add(actionOf(resource, verb));
			}
		}
		map.set(resource, new Set(names));
	}
	return map;
}

function prefixed(error: unknown, prefix: string): unknown {
	return error instanceof PolicyError ? new PolicyError(`${prefix}: ${error.message}`) : error;
}

async function compileRule(
	raw: PolicyRule,
	index: number,
	context: { resolver: NameResolver; workspace: string },
): Promise<CompiledRule[]> {
	const [where, constraints] = await Promise.all([
		compileWhere(raw.where, context.resolver, context.workspace).catch((error: unknown) => {
			throw prefixed(error, `rules[${index}].where`);
		}),
		compileConstraints(raw, index, context),
	]);
	const specificity = specificityOf(where);
	const compiled: CompiledRule[] = [];
	const expand = (patterns: readonly string[], kind: "allow" | "deny"): Set<Action> => {
		try {
			return expandActionPatterns(patterns, { grant: kind === "allow" });
		} catch (error) {
			throw prefixed(error, `rules[${index}].${kind}`);
		}
	};
	if (raw.allow !== undefined) {
		const actions = expand(raw.allow, "allow");
		const fields = compileFields(raw.fields, actions, index);
		compiled.push({
			index,
			effect: "allow",
			where,
			actions,
			specificity,
			raw,
			...(fields && { fields }),
		});
	}
	if (raw.deny !== undefined) {
		compiled.push({
			index,
			effect: "deny",
			where,
			actions: expand(raw.deny, "deny"),
			specificity,
			raw,
		});
	}
	if (constraints !== undefined) {
		compiled.push({
			index,
			effect: "constrain",
			where,
			actions: new Set(),
			constraints,
			specificity,
			raw,
		});
	}
	return compiled;
}

/**
 * Resolves every name in a validated policy file and prepares it for
 * evaluation. Rules that carry both `allow` and `deny` become two compiled
 * rules sharing the same index.
 */
async function compilePolicy(file: PolicyFile, resolver: NameResolver): Promise<Policy> {
	const [workspace, me] = await Promise.all([resolver.workspace(file.workspace), resolver.me()]);
	const context = { resolver, workspace: workspace.gid };
	const perRule = await Promise.all(
		file.rules.map((raw, index) => compileRule(raw, index, context)),
	);
	return { workspace: workspace.gid, workspaceName: workspace.name, me, rules: perRule.flat() };
}

export { compilePolicy };
export type { CustomFieldDefinition, NameResolver };
