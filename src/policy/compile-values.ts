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

/** The texts an `in` / `not_in` list matches: as written, and resolved to gids. */
async function referenceSet(
	values: readonly Scalar[],
	resolve: ValueResolver | undefined,
): Promise<Set<string>> {
	const resolved =
		resolve === undefined ? [] : await Promise.all(values.map((value) => resolve(value)));
	return new Set([...values, ...resolved].map(String));
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
	return {
		...(raw.present !== undefined && { present: raw.present }),
		...(raw.prefix !== undefined && { prefix: raw.prefix }),
		...(raw.suffix !== undefined && { suffix: raw.suffix }),
		...(raw.contains !== undefined && { contains: raw.contains }),
		...(raw.matches !== undefined && { matches: compileRegExp(raw.matches, `${label}.matches`) }),
		...(raw.not_matches !== undefined && {
			notMatches: compileRegExp(raw.not_matches, `${label}.not_matches`),
		}),
		...(raw.in !== undefined && { in: await referenceSet(raw.in, resolve) }),
		...(raw.not_in !== undefined && { notIn: await referenceSet(raw.not_in, resolve) }),
		...(raw.min_length !== undefined && { minLength: raw.min_length }),
		...(raw.max_length !== undefined && { maxLength: raw.max_length }),
		...(raw.min !== undefined && { min: raw.min }),
		...(raw.max !== undefined && { max: raw.max }),
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
	const one = (value: Scalar): Promise<Scalar> =>
		resolve === undefined ? Promise.resolve(value) : resolve(value);
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
