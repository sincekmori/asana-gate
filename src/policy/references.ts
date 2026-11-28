// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import type { Resource } from "../catalog/resources.ts";
import { REFERENCE_MEMBERS } from "./compile-values.ts";
import type { FieldApplication, FieldRequirement } from "./constraints.ts";
import type { CompiledConstraints, CompiledWhere, Policy } from "./types.ts";

/** One object a rule names by gid, and where. */
interface Named {
	readonly resource: Resource;
	readonly gid: string;
	/** Where the rule names it: `where.project`, `apply.task.tags`, … */
	readonly at: string;
	/** For a custom field: the values the rule expects it to hold, or sets it to. */
	readonly values?: readonly string[];
}

/** An object a policy names, and the rule that does. */
interface Reference extends Named {
	/** The rule's index in its policy file, and the file's layer. */
	readonly rule: number;
	readonly layer: number;
}

/** The `where` members that name objects, the resource each names, and how to read them. */
const MEMBERS: readonly {
	readonly member: string;
	readonly resource: Resource;
	readonly of: (where: CompiledWhere) => Iterable<string> | undefined;
}[] = [
	{ member: "team", resource: "team", of: (where) => where.teams },
	{ member: "portfolio", resource: "portfolio", of: (where) => where.portfolios },
	{ member: "project", resource: "project", of: (where) => where.projects },
	{ member: "section", resource: "section", of: (where) => where.sections },
	{ member: "task", resource: "task", of: (where) => where.tasks },
	{ member: "subtree", resource: "task", of: (where) => where.subtrees },
	{ member: "tag", resource: "tag", of: (where) => where.tags },
	{ member: "assignee", resource: "user", of: (where) => where.assignees },
	{ member: "created_by", resource: "user", of: (where) => where.createdBy },
];

/** The key of a custom field's constraints: `custom_fields.<gid>`. */
const FIELD_KEY = "custom_fields.";

/** The objects a scope names. */
function scoped(where: CompiledWhere): Named[] {
	const objects = MEMBERS.flatMap(({ member, resource, of }) =>
		[...(of(where) ?? [])].map((gid): Named => ({ resource, gid, at: `where.${member}` })),
	);
	const fields = (where.customFields ?? []).map(({ fieldGid, values }): Named => ({
		resource: "custom_field",
		gid: fieldGid,
		at: "where.custom_field",
		values: [...values],
	}));
	return [...objects, ...fields];
}

/** What a requirement or an application names values with. */
type Naming = Pick<FieldRequirement, "in" | "not_in"> &
	Pick<FieldApplication, "default" | "value" | "add">;

/** The objects one `require` or `apply` block names: custom fields with their values, and the values of the members that name objects. */
function constrained(
	clause: string,
	block: ReadonlyMap<Resource, ReadonlyMap<string, Naming>>,
): Named[] {
	return [...block].flatMap(([resource, members]) =>
		[...members].flatMap(([key, spec]): Named[] => {
			const at = `${clause}.${resource}`;
			const values = [
				...(spec.in ?? []),
				...(spec.not_in ?? []),
				spec.default,
				spec.value,
				spec.add,
			]
				.flat()
				.filter((value) => value !== undefined)
				.map(String);
			if (key.startsWith(FIELD_KEY)) {
				const gid = key.slice(FIELD_KEY.length);
				return [{ resource: "custom_field", gid, at: `${at}.custom_fields`, values }];
			}
			const named = REFERENCE_MEMBERS.get(key);
			return named === undefined
				? []
				: values.map((gid) => ({ resource: named, gid, at: `${at}.${key}` }));
		}),
	);
}

/** The objects a rule's constraints name. */
function constraining(constraints: CompiledConstraints | undefined): Named[] {
	return constraints === undefined
		? []
		: [...constrained("require", constraints.require), ...constrained("apply", constraints.apply)];
}

/** Every object the policy names, once per rule and place (a rule's statements share one scope). */
function referencesOf(policy: Policy): Reference[] {
	const references = new Map<string, Reference>();
	for (const rule of policy.rules) {
		for (const named of [...scoped(rule.where), ...constraining(rule.constraints)]) {
			references.set(`${rule.layer}:${rule.index}:${named.at}:${named.gid}`, {
				...named,
				rule: rule.index,
				layer: rule.layer,
			});
		}
	}
	return [...references.values()];
}

export { referencesOf };
export type { Reference };
