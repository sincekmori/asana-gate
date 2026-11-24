// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { messageOf } from "../log.ts";
import type { CustomFieldDefinition, NameResolver } from "./compile.ts";
import type { FieldApplication, FieldRequirement, Scalar } from "./constraints.ts";
import { isGid, type PolicyApplication, type PolicyRequirement } from "./schema.ts";
import { PolicyError } from "./types.ts";

/** Compilers of the values a rule's `require` and `apply` write: operators, regular expressions and the names they use. */

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

/**
 * Turns one value a policy writes for a request member into the gid Asana
 * expects (a tag, user, project or team name, or an enum option name); gids
 * and values that name nothing pass through unchanged.
 */
type ValueResolver = (value: Scalar) => Promise<Scalar>;

/** Members whose values name objects of one kind, resolved like the names in `where`. */
const REFERENCE_MEMBERS: Readonly<Record<string, "tag" | "user" | "project" | "team">> = {
	tags: "tag",
	assignee: "user",
	owner: "user",
	followers: "user",
	projects: "project",
	team: "team",
};

/** Members whose values name users, which a request may name by gid, `me` or email. */
const USER_MEMBERS: ReadonlySet<string> = new Set(
	Object.entries(REFERENCE_MEMBERS)
		.filter(([, kind]) => kind === "user")
		.map(([member]) => member),
);

/** The resolver for a member's values, when they name objects. */
function memberResolver(
	member: string,
	context: { readonly resolver: NameResolver; readonly workspace: string },
): ValueResolver | undefined {
	const kind = REFERENCE_MEMBERS[member];
	if (kind === undefined) {
		return undefined;
	}
	const { resolver, workspace } = context;
	return (value) =>
		typeof value !== "string" || isGid(value)
			? Promise.resolve(value)
			: resolver[kind](value, workspace);
}

/** Enum option names of a custom field resolve to the option gids (unknown values stay as written). */
function optionResolver(definition: CustomFieldDefinition): ValueResolver | undefined {
	if (definition.enumOptions.length === 0) {
		return undefined;
	}
	return (value) => {
		const text = String(value);
		const option = definition.enumOptions.find((o) => o.gid === text || o.name === text);
		return Promise.resolve(option?.gid ?? value);
	};
}

/** A value as a request sends it: resolved when the member's values name objects, as written otherwise. */
const resolveValue = (value: Scalar, resolve: ValueResolver | undefined): Promise<Scalar> =>
	resolve === undefined ? Promise.resolve(value) : resolve(value);

/**
 * The values an `in` / `not_in` list matches, as a request carries them:
 * resolved to the gids Asana takes, which a name in a request is not (a
 * user a request names by `me` or an email is compared by gid), each with
 * how the policy wrote it.
 */
async function referenceValues(
	values: readonly Scalar[],
	resolve: ValueResolver | undefined,
): Promise<Map<string, string>> {
	const sent = await Promise.all(values.map((value) => resolveValue(value, resolve)));
	return new Map(sent.map((value, index) => [String(value), String(values[index])]));
}

const isScalarList = (value: Scalar | readonly Scalar[]): value is readonly Scalar[] =>
	Array.isArray(value);

async function compileRequirement(
	raw: true | PolicyRequirement,
	label: string,
	resolve: ValueResolver | undefined,
): Promise<FieldRequirement> {
	if (raw === true) {
		return { present: true };
	}
	// The patterns and the value sets are compiled; every other operator holds as written.
	const { matches, not_matches: unmatched, in: allowed, not_in: denied, ...written } = raw;
	return {
		...written,
		...(matches !== undefined && { matches: compileRegExp(matches, `${label}.matches`) }),
		...(unmatched !== undefined && {
			not_matches: compileRegExp(unmatched, `${label}.not_matches`),
		}),
		...(allowed !== undefined && { in: await referenceValues(allowed, resolve) }),
		...(denied !== undefined && { not_in: await referenceValues(denied, resolve) }),
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

async function compileApplication(
	raw: RawApplication,
	resolve: ValueResolver | undefined,
): Promise<FieldApplication> {
	const one = (value: Scalar): Promise<Scalar> => resolveValue(value, resolve);
	const values = (value: Scalar | readonly Scalar[]): Promise<Scalar | Scalar[]> =>
		isScalarList(value) ? Promise.all(value.map((item) => one(item))) : one(value);
	if (!isApplicationObject(raw)) {
		return { default: await values(raw) };
	}
	return {
		...(raw.default !== undefined && { default: await values(raw.default) }),
		...(raw.value !== undefined && { value: await values(raw.value) }),
		...(raw.prefix !== undefined && { prefix: raw.prefix }),
		...(raw.suffix !== undefined && { suffix: raw.suffix }),
		...(raw.add !== undefined && { add: await Promise.all(raw.add.map((item) => one(item))) }),
	};
}

export {
	compileApplication,
	compileRegExp,
	compileRequirement,
	memberResolver,
	optionResolver,
	USER_MEMBERS,
};
export type { RawApplication, ValueResolver };
