// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { requestMembers, responseMembers } from "../catalog/members.ts";
import {
	type Action,
	actionOf,
	FIELD_VERBS,
	isResource,
	type Resource,
	RESOURCE_VERBS,
} from "../catalog/resources.ts";
import { isObject } from "../json.ts";
import { expandActionPatterns } from "./actions.ts";
import {
	compileApplication,
	compileRequirement,
	memberResolver,
	optionResolver,
	type RawApplication,
	type ValueResolver,
} from "./compile-values.ts";
import type { NameResolver } from "./compile.ts";
import type { FieldApplication, FieldRequirement, RateLimit } from "./constraints.ts";
import { durationMs } from "./durations.ts";
import { OPERATOR_KEYS, type PolicyRequirement, type PolicyRule } from "./schema.ts";
import { type CompiledConstraints, PolicyError } from "./types.ts";

/** Context shared by the constraint compilers. */
interface ConstraintContext {
	readonly resolver: NameResolver;
	readonly workspace: string;
	readonly label: string;
	readonly labels: Map<string, string>;
}

function asResource(name: string, label: string): Resource {
	if (!isResource(name)) {
		throw new PolicyError(`${label}: unknown resource "${name}"`);
	}
	return name;
}

/** Checks that `member` is a request member of `resource`'s create or update operations. */
function assertRequestMember(resource: Resource, member: string, label: string): void {
	const members = requestMembers(resource);
	if (members !== undefined && !members.has(member)) {
		throw new PolicyError(
			`${label}: "${member}" is not a request member of ${resource} (one of: ${[...members].toSorted().join(", ")})`,
		);
	}
}

/** Whether a `custom_fields` spec nests field names, rather than constraining the member itself. */
const isNested = (value: unknown): value is Record<string, unknown> =>
	isObject(value) && !Object.keys(value).some((key) => OPERATOR_KEYS.has(key));

/** One compiled member entry of a `require` or `apply` block. */
type MemberEntry<Out> = readonly [key: string, value: Out];

/** Compiles the entries of one member spec: a direct member, or the custom fields nested under `custom_fields`. */
async function compileMemberEntries<Out>(
	args: { resource: Resource; member: string; spec: unknown },
	context: ConstraintContext,
	compile: (raw: unknown, label: string, resolve: ValueResolver | undefined) => Promise<Out>,
): Promise<MemberEntry<Out>[]> {
	const label = `${context.label}.${args.resource}.${args.member}`;
	assertRequestMember(args.resource, args.member, context.label);
	if (args.member !== "custom_fields" || !isNested(args.spec)) {
		return [[args.member, await compile(args.spec, label, memberResolver(args.member, context))]];
	}
	const nested = await Promise.all(
		Object.entries(args.spec).map(async ([fieldRef, fieldSpec]): Promise<MemberEntry<Out>> => {
			const definition = await context.resolver.customField(fieldRef, context.workspace);
			const key = `custom_fields.${definition.gid}`;
			context.labels.set(key, `custom field "${definition.name}"`);
			return [key, await compile(fieldSpec, `${label}.${fieldRef}`, optionResolver(definition))];
		}),
	);
	return nested;
}

/**
 * Compiles one `require` or `apply` block: `{ resource: { member: spec, custom_fields: { name: spec } } }`
 * into member keys (`name`, `custom_fields.<gid>`).
 */
async function compileMembers<Out>(
	block: Record<string, Record<string, unknown>>,
	context: ConstraintContext,
	compile: (raw: unknown, label: string, resolve: ValueResolver | undefined) => Promise<Out>,
): Promise<Map<Resource, Map<string, Out>>> {
	const perResource = await Promise.all(
		Object.entries(block).map(
			async ([resourceName, members]): Promise<[Resource, Map<string, Out>]> => {
				const resource = asResource(resourceName, context.label);
				const entries = await Promise.all(
					Object.entries(members).map(([member, spec]) =>
						compileMemberEntries({ resource, member, spec }, context, compile),
					),
				);
				return [resource, new Map(entries.flat())];
			},
		),
	);
	return new Map(perResource);
}

function compileFieldLists(
	block: Record<string, readonly string[]> | undefined,
	label: string,
	validate: (resource: Resource, member: string, label: string) => void,
): Map<Resource, Set<string>> {
	const result = new Map<Resource, Set<string>>();
	for (const [resourceName, members] of Object.entries(block ?? {})) {
		const resource = asResource(resourceName, label);
		for (const member of members) {
			validate(resource, member, label);
		}
		result.set(resource, new Set(members));
	}
	return result;
}

function assertResponseMember(resource: Resource, member: string, label: string): void {
	const members = responseMembers(resource);
	if (members !== undefined && !members.has(member)) {
		throw new PolicyError(`${label}: "${member}" is not a response member of ${resource}`);
	}
}

function compileLimits(block: PolicyRule["limit"]): Map<Action, RateLimit> {
	const limits = new Map<Action, RateLimit>();
	for (const [pattern, { max, per }] of Object.entries(block ?? {})) {
		for (const action of expandActionPatterns([pattern], { grant: false })) {
			limits.set(action, { max, perMs: durationMs(per), per });
		}
	}
	return limits;
}

/** Compiles a rule's constraint clauses, or `undefined` when it has none. */
async function compileConstraints(
	raw: PolicyRule,
	index: number,
	context: { resolver: NameResolver; workspace: string },
): Promise<CompiledConstraints | undefined> {
	const hasAny = [raw.require, raw.apply, raw.forbid, raw.redact, raw.limit, raw.confirm].some(
		(c) => c !== undefined,
	);
	if (!hasAny) {
		return undefined;
	}
	const labels = new Map<string, string>();
	const base = { resolver: context.resolver, workspace: context.workspace, labels };
	const [require, apply] = await Promise.all([
		compileMembers<FieldRequirement>(
			raw.require ?? {},
			{ ...base, label: `rules[${index}].require` },
			(spec, label, resolve) =>
				compileRequirement(spec as true | PolicyRequirement, label, resolve),
		),
		compileMembers<FieldApplication>(
			raw.apply ?? {},
			{ ...base, label: `rules[${index}].apply` },
			(spec, _label, resolve) => compileApplication(spec as RawApplication, resolve),
		),
	]);
	return {
		require,
		apply,
		forbid: compileFieldLists(raw.forbid, `rules[${index}].forbid`, assertRequestMember),
		redact: compileFieldLists(raw.redact, `rules[${index}].redact`, assertResponseMember),
		limit: compileLimits(raw.limit),
		confirm: expandActionPatterns(raw.confirm ?? [], { grant: false }),
		labels,
	};
}

/** The `fields` allowlist of an allow rule, which also grants the update verbs the members stand for. */
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

export { assertRequestMember, compileConstraints, compileFields };
