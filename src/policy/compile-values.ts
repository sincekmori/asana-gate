// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import type { Resource } from "../catalog/resources.ts";
import { messageOf } from "../log.ts";
import type { FieldApplication, FieldRequirement, Scalar } from "./constraints.ts";
import { isGid, type PolicyApplication, type PolicyRequirement } from "./schema.ts";
import { type Me, PolicyError } from "./types.ts";

/** Compilers of the values a rule's `require` and `apply` write: operators, regular expressions and the objects they name. */

/** Compiles a regular expression from a policy, with a readable error. */
function compileRegExp(source: string, label: string): RegExp {
	try {
		return new RegExp(source, "u");
	} catch (error) {
		const reason = messageOf(error);
		throw new PolicyError(
			`${label}: invalid regular expression ${JSON.stringify(source)}: ${reason}`,
		);
	}
}

/** One value a policy writes for a request member, as a request sends it. */
type ValueReader = (value: Scalar) => Scalar;

/**
 * The members whose values name objects, and the resource each names. A
 * policy names them by gid; a user, whom a request may name by gid, `me` or
 * email, also by `me`.
 */
const REFERENCE_MEMBERS: ReadonlyMap<string, Resource> = new Map([
	["tags", "tag"],
	["assignee", "user"],
	["owner", "user"],
	["followers", "user"],
	["projects", "project"],
	["team", "team"],
]);

/**
 * Reads the values a policy writes for `member`: as written, except where
 * the member names objects, whose values must be gids (`me`, for a user, is
 * the gid of the token's own).
 */
function memberReader(member: string, context: { me: Me; label: string }): ValueReader {
	const named = REFERENCE_MEMBERS.get(member);
	if (named === undefined) {
		return (value) => value;
	}
	const users = named === "user";
	return (value) => {
		if (users && value === "me") {
			return context.me.gid;
		}
		if (typeof value !== "string" || !isGid(value)) {
			throw new PolicyError(
				`${context.label}: ${JSON.stringify(value)} is no gid; ${member} names objects by gid${users ? ' (a user also by "me")' : ""}, in quotes`,
			);
		}
		return value;
	};
}

const isScalarList = (value: Scalar | readonly Scalar[]): value is readonly Scalar[] =>
	Array.isArray(value);

function compileRequirement(
	raw: true | PolicyRequirement,
	label: string,
	read: ValueReader,
): FieldRequirement {
	if (raw === true) {
		return { present: true };
	}
	// The patterns and the value sets are compiled; every other operator holds as written.
	const { matches, not_matches: unmatched, in: allowed, not_in: denied, ...written } = raw;
	const sent = (values: readonly Scalar[]): Set<string> =>
		new Set(values.map((value) => String(read(value))));
	return {
		...written,
		...(matches !== undefined && { matches: compileRegExp(matches, `${label}.matches`) }),
		...(unmatched !== undefined && {
			not_matches: compileRegExp(unmatched, `${label}.not_matches`),
		}),
		...(allowed !== undefined && { in: sent(allowed) }),
		...(denied !== undefined && { not_in: sent(denied) }),
	};
}

type RawApplication =
	| PolicyApplication
	| string
	| number
	| boolean
	| readonly (string | number | boolean)[];

const isApplicationObject = (raw: RawApplication): raw is PolicyApplication =>
	typeof raw === "object" && !Array.isArray(raw);

function compileApplication(raw: RawApplication, read: ValueReader): FieldApplication {
	const values = (value: Scalar | readonly Scalar[]): Scalar | Scalar[] =>
		isScalarList(value) ? value.map((item) => read(item)) : read(value);
	if (!isApplicationObject(raw)) {
		return { default: values(raw) };
	}
	return {
		...(raw.default !== undefined && { default: values(raw.default) }),
		...(raw.value !== undefined && { value: values(raw.value) }),
		...(raw.prefix !== undefined && { prefix: raw.prefix }),
		...(raw.suffix !== undefined && { suffix: raw.suffix }),
		...(raw.add !== undefined && { add: raw.add.map((item) => read(item)) }),
	};
}

export { compileApplication, compileRegExp, compileRequirement, memberReader, REFERENCE_MEMBERS };
export type { RawApplication, ValueReader };
