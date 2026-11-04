// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import type { Resource } from "../catalog/resources.ts";
import type { CompiledWhere, Policy } from "./types.ts";

/** One object a policy's scope names by gid (after names were resolved), and where. */
interface Reference {
	readonly resource: Resource;
	readonly gid: string;
	/** The rule's index in the policy file. */
	readonly rule: number;
	/** The `where` member that names it (`project`, `subtree`, …). */
	readonly member: string;
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
	{
		member: "custom_field",
		resource: "custom_field",
		of: (where) => where.customFields?.map((predicate) => predicate.fieldGid),
	},
];

/** Every object the policy's scopes name, once per rule and member (a rule's statements share one scope). */
function referencesOf(policy: Policy): Reference[] {
	const references = new Map<string, Reference>();
	for (const rule of policy.rules) {
		for (const { member, resource, of } of MEMBERS) {
			for (const gid of of(rule.where) ?? []) {
				references.set(`${rule.index}:${member}:${gid}`, {
					resource,
					gid,
					rule: rule.index,
					member,
				});
			}
		}
	}
	return [...references.values()];
}

export { referencesOf };
export type { Reference };
