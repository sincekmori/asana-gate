// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import type { Resource } from "../catalog/resources.ts";
import { USER_MEMBERS } from "../policy/compile-values.ts";
import {
	applyApplication,
	checkRequirement,
	type FieldRequirement,
} from "../policy/constraints.ts";
import { constraintsFor, labelOf } from "../policy/effective.ts";
import type { Facts } from "../policy/evaluate.ts";
import type { Policy } from "../policy/types.ts";
import type { FactsLoader } from "./facts.ts";
import { isObject } from "./objects.ts";

type Body = Record<string, unknown>;

/** Reads a member by key; a dotted key (`custom_fields.<gid>`) reaches into nested objects. */
function readMember(body: Body, key: string): unknown {
	let current: unknown = body;
	for (const part of key.split(".")) {
		current = isObject(current) ? current[part] : undefined;
	}
	return current;
}

/** Returns a copy of `body` with the member set; a dotted key creates the objects it passes through. */
function writeMember(body: Body, key: string, value: unknown): Body {
	const [head, ...rest] = key.split(".");
	if (head === undefined || rest.length === 0) {
		return { ...body, [key]: value };
	}
	const nested = body[head];
	return { ...body, [head]: writeMember(isObject(nested) ? nested : {}, rest.join("."), value) };
}

/** The object a request acts on: the policy and the facts the constraints are evaluated against. */
interface Scope {
	readonly policy: Policy;
	readonly facts: Facts;
}

/** A {@link Scope} to shape a request body in, with the loader that finds the users the body names. */
interface ShapeScope extends Scope {
	readonly loader: Pick<FactsLoader, "userGid">;
}

/** A shaped request body, and the constraints it still breaks (empty when it satisfies them). */
interface Shaped {
	readonly data: Body;
	readonly problems: readonly string[];
}

/** Whether `requirements` compare a user member with sets of users, which hold gids. */
const comparesUsers = (key: string, requirements: readonly FieldRequirement[]): boolean =>
	USER_MEMBERS.has(key) && requirements.some((r) => r.in !== undefined || r.notIn !== undefined);

/** A user member's value with each user it names (`me`, an email) as their gid; one that names nobody stays. */
async function withUserGids(value: unknown, loader: ShapeScope["loader"]): Promise<unknown> {
	if (Array.isArray(value)) {
		return Promise.all(value.map((item: unknown) => withUserGids(item, loader)));
	}
	return typeof value === "string" ? ((await loader.userGid(value)) ?? value) : value;
}

/**
 * Shapes a create or update request body under the constraints in force for
 * its target: applies the `apply` rules, then lists every `forbid` or
 * `require` rule the result does not satisfy. It refuses nothing itself: the
 * gate refuses the request only after its permissions are checked, so that a
 * constraint message cannot reveal an object the policy hides.
 */
async function shapeBody(
	scope: ShapeScope,
	target: { resource: Resource; verb: "create" | "update" },
	body: Readonly<Body>,
): Promise<Shaped> {
	const effective = constraintsFor(scope.policy, scope.facts);
	let data = { ...body };
	for (const [key, application] of effective.apply.get(target.resource) ?? []) {
		const current = readMember(data, key);
		const next = applyApplication(current, application, target.verb);
		if (next !== current) {
			data = writeMember(data, key, next);
		}
	}
	const problems: string[] = [];
	for (const key of effective.forbid.get(target.resource) ?? []) {
		if (readMember(data, key) !== undefined) {
			problems.push(`${labelOf(effective, key)} may not be set`);
		}
	}
	// A request is compared by the users it names, however it names them.
	const required = [...(effective.require.get(target.resource) ?? [])];
	const violations = await Promise.all(
		required.map(async ([key, requirements]) => {
			const member = readMember(data, key);
			const value = comparesUsers(key, requirements)
				? await withUserGids(member, scope.loader)
				: member;
			return requirements.flatMap((requirement) =>
				checkRequirement(value, requirement, { verb: target.verb }).map(
					(violation) => `${labelOf(effective, key)} ${violation}`,
				),
			);
		}),
	);
	problems.push(...violations.flat());
	return { data, problems };
}

/** Removes the members the policy redacts for an object of `resource`. */
function redactObject(scope: Scope, resource: Resource, object: Body): Body {
	const redact = constraintsFor(scope.policy, scope.facts).redact.get(resource);
	if (redact === undefined || redact.size === 0) {
		return object;
	}
	return Object.fromEntries(Object.entries(object).filter(([key]) => !redact.has(key)));
}

export { redactObject, shapeBody };
export type { Scope, Shaped };
