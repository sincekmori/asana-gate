// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import type { Action } from "../catalog/resources.ts";
import { expandActionPatterns } from "./actions.ts";
import { compileConstraints, compileFields } from "./compile-constraints.ts";
import { isGid, type PolicyFile, type PolicyRule, type PolicyWhere } from "./schema.ts";
import { compileState, specificityOf } from "./scope.ts";
import {
	type CompiledCustomFieldPredicate,
	type CompiledRule,
	type CompiledWhere,
	LAYER_RANK,
	type LayerRole,
	type Me,
	type Policy,
	PolicyError,
	type PolicyLayer,
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

function prefixed(error: unknown, prefix: string): unknown {
	return error instanceof PolicyError ? new PolicyError(`${prefix}: ${error.message}`) : error;
}

async function compileRule(
	raw: PolicyRule,
	index: number,
	context: { resolver: NameResolver; workspace: string; layer: number },
): Promise<CompiledRule[]> {
	const { layer } = context;
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
			layer,
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
			layer,
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
			layer,
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

/** One policy file to compile, and where it comes from. */
interface PolicySource {
	readonly file: PolicyFile;
	/** The file's path, for messages. */
	readonly path: string;
	readonly role: LayerRole;
}

/** A layer to compile: its source, its index, whether it names the workspace, and whether errors name its file. */
interface LayerEntry {
	readonly source: PolicySource;
	readonly layer: number;
	readonly first: boolean;
	readonly named: boolean;
}

/** A layer compiled, or kept out of force when it names another workspace. */
async function compiledLayer(
	entry: LayerEntry,
	governed: { readonly gid: string; readonly name: string },
	resolver: NameResolver,
): Promise<{ layer: PolicyLayer; rules: CompiledRule[] }> {
	const { source, layer, first, named } = entry;
	const { path: file, role } = source;
	try {
		const own =
			first || source.file.workspace === undefined
				? governed
				: await resolver.workspace(source.file.workspace);
		if (own.gid !== governed.gid) {
			return { layer: { file, role, otherWorkspace: own.name }, rules: [] };
		}
		const context = { resolver, workspace: governed.gid, layer };
		const perRule = await Promise.all(
			source.file.rules.map((raw, index) => compileRule(raw, index, context)),
		);
		return { layer: { file, role }, rules: perRule.flat() };
	} catch (error) {
		throw named ? prefixed(error, file) : error;
	}
}

/**
 * Compiles policy files into one policy, which allows an action only when
 * every file does. Names resolve in the workspace the first file names; a
 * later file that names another workspace is kept but not in force.
 */
async function compilePolicies(
	sources: readonly PolicySource[],
	resolver: NameResolver,
): Promise<Policy> {
	const [first] = sources;
	if (first === undefined) {
		throw new PolicyError("no policy to compile");
	}
	if (first.file.workspace === undefined) {
		throw new PolicyError(
			`${first.path}: this policy must name its workspace (only the files that follow it may leave it out)`,
		);
	}
	const [workspace, me] = await Promise.all([
		resolver.workspace(first.file.workspace),
		resolver.me(),
	]);
	const named = sources.length > 1;
	// From the weakest layer to the strongest, so the strongest wins ties.
	const ordered = sources
		.map((source) => ({ source, first: source === first, named }))
		.toSorted((a, b) => LAYER_RANK[a.source.role] - LAYER_RANK[b.source.role]);
	const compiled = await Promise.all(
		ordered.map((entry, layer) => compiledLayer({ ...entry, layer }, workspace, resolver)),
	);
	return {
		workspace: workspace.gid,
		workspaceName: workspace.name,
		me,
		layers: compiled.map((entry) => entry.layer),
		rules: compiled.flatMap((entry) => entry.rules),
	};
}

/** Compiles one policy file on its own. */
function compilePolicy(file: PolicyFile, resolver: NameResolver): Promise<Policy> {
	return compilePolicies([{ file, path: "policy", role: "project" }], resolver);
}

export { compilePolicies, compilePolicy };
export type { CustomFieldDefinition, NameResolver, PolicySource };
