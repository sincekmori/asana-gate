// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { compileRegExp } from "./compile-values.ts";
import { durationMs } from "./durations.ts";
import type { PolicyWhere } from "./schema.ts";
import {
	type CompiledNamePredicate,
	type CompiledWhere,
	LEVELS,
	type Policy,
	type Specificity,
} from "./types.ts";

function compileName(name: NonNullable<PolicyWhere["name"]>): CompiledNamePredicate {
	return {
		...(name.prefix !== undefined && { prefix: name.prefix }),
		...(name.suffix !== undefined && { suffix: name.suffix }),
		...(name.contains !== undefined && { contains: name.contains }),
		...(name.matches !== undefined && { matches: compileRegExp(name.matches, "name.matches") }),
	};
}

/** The state predicates of a scope (none of them needs the resolver). */
function compileState(where: PolicyWhere): Partial<CompiledWhere> {
	const dueWithinMs = where.due_within === undefined ? undefined : durationMs(where.due_within);
	const createdWithinMs =
		where.created_within === undefined ? undefined : durationMs(where.created_within);
	return {
		...(where.completed !== undefined && { completed: where.completed }),
		...(where.has_parent !== undefined && { hasParent: where.has_parent }),
		...(where.name !== undefined && { name: compileName(where.name) }),
		...(where.overdue !== undefined && { overdue: where.overdue }),
		...(dueWithinMs !== undefined && { dueWithinMs }),
		...(createdWithinMs !== undefined && { createdWithinMs }),
	};
}

/** How many cross-cutting and state predicates a scope carries. */
function crossCount(where: CompiledWhere): number {
	const flags = [
		where.tags,
		where.assignees,
		where.createdBy,
		where.completed,
		where.hasParent,
		where.name,
		where.overdue,
		where.dueWithinMs,
		where.createdWithinMs,
	];
	return flags.filter((flag) => flag !== undefined).length + (where.customFields?.length ?? 0);
}

/** The specificity of a compiled scope. */
function specificityOf(where: CompiledWhere): Specificity {
	const levels = [
		LEVELS.workspace,
		where.teams ? LEVELS.team : 0,
		where.portfolios ? LEVELS.portfolio : 0,
		where.unhomed === true ? LEVELS.unhomed : 0,
		where.projects ? LEVELS.project : 0,
		where.sections ? LEVELS.section : 0,
		where.subtrees ? LEVELS.subtree : 0,
		where.tasks ? LEVELS.task : 0,
	];
	return { level: Math.max(...levels), cross: crossCount(where) };
}

/** Every portfolio gid a scope of the policy names; the gate indexes their contents. */
function portfoliosNamed(policy: Policy): ReadonlySet<string> {
	return new Set(policy.rules.flatMap((rule) => [...(rule.where.portfolios ?? [])]));
}

/** Whether a scope of the policy names a task or a subtree, so a task's ancestors must be known. */
function needsTaskChain(policy: Policy): boolean {
	return policy.rules.some(
		(rule) => rule.where.tasks !== undefined || rule.where.subtrees !== undefined,
	);
}

export { compileState, needsTaskChain, portfoliosNamed, specificityOf };
