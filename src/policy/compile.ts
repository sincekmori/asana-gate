// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import type { Action } from "../catalog/resources.ts";
import { expandActionPatterns } from "./actions.ts";
import { compileConstraints, compileFields } from "./compile-constraints.ts";
import type { PolicyFile, PolicyRule, PolicyWhere } from "./schema.ts";
import { compileState, specificityOf } from "./scope.ts";
import {
	type CompiledRule,
	type CompiledWhere,
	LAYER_RANK,
	type LayerRole,
	type Me,
	type Policy,
	PolicyError,
	type PolicyLayer,
} from "./types.ts";

/**
 * Whom a policy is compiled for: the user the token belongs to, who is the
 * `me` a policy may name, and what the workspace it governs is called.
 * A policy names every other object by gid, so nothing else is asked of
 * Asana to read one.
 */
interface PolicyContext {
	readonly me: Me;
	readonly workspaceName: string;
}

function list<T>(value: T | T[] | undefined): T[] {
	if (value === undefined) {
		return [];
	}
	return Array.isArray(value) ? value : [value];
}

/** The gids a `where` key lists (`me` as the token's own user); `undefined` when it lists none. */
function gids(value: string | string[] | undefined, me?: Me): ReadonlySet<string> | undefined {
	const refs = list(value);
	return refs.length === 0
		? undefined
		: new Set(refs.map((ref) => (ref === "me" && me !== undefined ? me.gid : ref)));
}

function compileWhere(where: PolicyWhere | undefined, me: Me): CompiledWhere {
	if (where === undefined) {
		return {};
	}
	const teams = gids(where.team);
	const portfolios = gids(where.portfolio);
	const projects = gids(where.project);
	const sections = gids(where.section);
	const tasks = gids(where.task);
	const subtrees = gids(where.subtree);
	const tags = gids(where.tag);
	const assignees = gids(where.assignee, me);
	const createdBy = gids(where.created_by, me);
	const customFields = Object.entries(where.custom_field ?? {}).map(([fieldGid, value]) => ({
		fieldGid,
		values: new Set(list(value).map(String)),
	}));
	return {
		...(teams && { teams }),
		...(portfolios && { portfolios }),
		...(projects && { projects }),
		...(sections && { sections }),
		...(tasks && { tasks }),
		...(subtrees && { subtrees }),
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

function compileRule(
	raw: PolicyRule,
	index: number,
	context: { me: Me; layer: number },
): CompiledRule[] {
	const { layer } = context;
	const where = compileWhere(raw.where, context.me);
	const constraints = compileConstraints(raw, index, context.me);
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
function compiledLayer(
	entry: LayerEntry,
	context: { me: Me; workspace: string },
): { layer: PolicyLayer; rules: CompiledRule[] } {
	const { source, layer, first, named } = entry;
	const { path: file, role } = source;
	// A file that names anything but the governed workspace is not in force here.
	const { workspace } = source.file;
	if (!first && workspace !== undefined && workspace !== context.workspace) {
		return { layer: { file, role, otherWorkspace: workspace }, rules: [] };
	}
	try {
		const rules = source.file.rules.flatMap((raw, index) =>
			compileRule(raw, index, { me: context.me, layer }),
		);
		return { layer: { file, role }, rules };
	} catch (error) {
		throw named ? prefixed(error, file) : error;
	}
}

/** The workspace the first of `sources` governs, which every policy in force governs with it. */
function governedWorkspace(sources: readonly PolicySource[]): string {
	const [first] = sources;
	if (first === undefined) {
		throw new PolicyError("no policy to compile");
	}
	if (first.file.workspace === undefined) {
		throw new PolicyError(
			`${first.path}: this policy must name its workspace (only the files that follow it may leave it out)`,
		);
	}
	return first.file.workspace;
}

/**
 * Compiles policy files into one policy, which allows an action only when
 * every file does. They govern the workspace the first file names; a later
 * file that names another workspace is kept but not in force.
 */
function compilePolicies(sources: readonly PolicySource[], context: PolicyContext): Policy {
	const workspace = governedWorkspace(sources);
	const [first] = sources;
	const named = sources.length > 1;
	// From the weakest layer to the strongest, so the strongest wins ties.
	const ordered = sources
		.map((source) => ({ source, first: source === first, named }))
		.toSorted((a, b) => LAYER_RANK[a.source.role] - LAYER_RANK[b.source.role]);
	const compiled = ordered.map((entry, layer) =>
		compiledLayer({ ...entry, layer }, { me: context.me, workspace }),
	);
	return {
		workspace,
		workspaceName: context.workspaceName,
		me: context.me,
		layers: compiled.map((entry) => entry.layer),
		rules: compiled.flatMap((entry) => entry.rules),
	};
}

/** Compiles one policy file on its own. */
function compilePolicy(file: PolicyFile, context: PolicyContext): Policy {
	return compilePolicies([{ file, path: "policy", role: "project" }], context);
}

export { compilePolicies, compilePolicy, governedWorkspace };
export type { PolicyContext, PolicySource };
