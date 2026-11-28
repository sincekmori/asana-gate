// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { requestMembers, responseMembers, updatableMembers } from "../catalog/members.ts";
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
	memberReader,
	type RawApplication,
	type ValueReader,
} from "./compile-values.ts";
import type { FieldApplication, FieldRequirement, RateLimit } from "./constraints.ts";
import { durationMs } from "./durations.ts";
import { isGid, type PolicyRequirement, type PolicyRule } from "./schema.ts";
import { type CompiledConstraints, type Me, PolicyError } from "./types.ts";

/** Context shared by the constraint compilers. */
interface ConstraintContext {
	readonly me: Me;
	readonly label: string;
}

function asResource(name: string, label: string): Resource {
	if (!isResource(name)) {
		throw new PolicyError(`${label}: unknown resource "${name}"`);
	}
	return name;
}

/** Checks that `members` of a resource, when they are known, include `member`. */
function assertMember(
	members: ReadonlySet<string> | undefined,
	at: { readonly resource: Resource; readonly member: string; readonly label: string },
): void {
	if (members !== undefined && !members.has(at.member)) {
		throw new PolicyError(
			`${at.label}: "${at.member}" is not a request member of ${at.resource} (one of: ${[...members].toSorted().join(", ")})`,
		);
	}
}

/** Checks that `member` is a request member of `resource`'s create or update operations. */
function assertRequestMember(resource: Resource, member: string, label: string): void {
	assertMember(requestMembers(resource), { resource, member, label });
}

/** Whether a `custom_fields` spec nests fields by gid, rather than constraining the member itself by operators. */
const isNested = (value: unknown): value is Record<string, unknown> =>
	isObject(value) && Object.keys(value).some((key) => isGid(key));

/** One compiled member entry of a `require` or `apply` block. */
type MemberEntry<Out> = readonly [key: string, value: Out];

/** Compiles the entries of one member spec: a direct member, or the custom fields nested under `custom_fields`. */
function compileMemberEntries<Out>(
	args: { resource: Resource; member: string; spec: unknown },
	context: ConstraintContext,
	compile: (raw: unknown, label: string, read: ValueReader) => Out,
): MemberEntry<Out>[] {
	const label = `${context.label}.${args.resource}.${args.member}`;
	assertRequestMember(args.resource, args.member, context.label);
	if (args.member !== "custom_fields" || !isNested(args.spec)) {
		const read = memberReader(args.member, { me: context.me, label });
		return [[args.member, compile(args.spec, label, read)]];
	}
	// What a custom field takes is written as Asana takes it: the gid of an option or of an object, a text, a number.
	return Object.entries(args.spec).map(([field, spec]) => [
		`custom_fields.${field}`,
		compile(spec, `${label}.${field}`, (value) => value),
	]);
}

/**
 * Compiles one `require` or `apply` block: `{ resource: { member: spec, custom_fields: { gid: spec } } }`
 * into member keys (`name`, `custom_fields.<gid>`).
 */
function compileMembers<Out>(
	block: Record<string, Record<string, unknown>>,
	context: ConstraintContext,
	compile: (raw: unknown, label: string, read: ValueReader) => Out,
): Map<Resource, Map<string, Out>> {
	return new Map(
		Object.entries(block).map(([resourceName, members]): [Resource, Map<string, Out>] => {
			const resource = asResource(resourceName, context.label);
			const entries = Object.entries(members).map(([member, spec]) =>
				compileMemberEntries({ resource, member, spec }, context, compile),
			);
			return [resource, new Map(entries.flat())];
		}),
	);
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
function compileConstraints(
	raw: PolicyRule,
	index: number,
	me: Me,
): CompiledConstraints | undefined {
	const hasAny = [raw.require, raw.apply, raw.forbid, raw.redact, raw.limit, raw.confirm].some(
		(c) => c !== undefined,
	);
	if (!hasAny) {
		return undefined;
	}
	return {
		require: compileMembers<FieldRequirement>(
			raw.require ?? {},
			{ me, label: `rules[${index}].require` },
			(spec, label, read) => compileRequirement(spec as true | PolicyRequirement, label, read),
		),
		apply: compileMembers<FieldApplication>(
			raw.apply ?? {},
			{ me, label: `rules[${index}].apply` },
			(spec, _label, read) => compileApplication(spec as RawApplication, read),
		),
		forbid: compileFieldLists(raw.forbid, `rules[${index}].forbid`, assertRequestMember),
		redact: compileFieldLists(raw.redact, `rules[${index}].redact`, assertResponseMember),
		limit: compileLimits(raw.limit),
		confirm: expandActionPatterns(raw.confirm ?? [], { grant: false }),
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
		const updatable = updatableMembers(resource);
		for (const name of names) {
			assertMember(updatable, {
				resource,
				member: name,
				label: `rules[${index}].fields`,
			});
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
