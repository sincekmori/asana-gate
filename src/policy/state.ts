// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { parseInstant } from "./durations.ts";
import type { Facts, ObjectState } from "./evaluate.ts";
import type { CompiledWhere } from "./types.ts";

/** `undefined` scope key matches everything; otherwise the value must be in the set. */
function inScope(set: ReadonlySet<string> | undefined, value: string | undefined): boolean {
	return set === undefined || (value !== undefined && set.has(value));
}

function nameMatches(where: CompiledWhere, name: string | undefined): boolean {
	const predicate = where.name;
	if (predicate === undefined) {
		return true;
	}
	if (name === undefined) {
		return false;
	}
	return (
		(predicate.prefix === undefined || name.startsWith(predicate.prefix)) &&
		(predicate.suffix === undefined || name.endsWith(predicate.suffix)) &&
		(predicate.contains === undefined || name.includes(predicate.contains)) &&
		(predicate.matches === undefined || predicate.matches.test(name))
	);
}

/** Milliseconds until a due date; `undefined` when unset or unparsable. */
function untilDue(dueOn: string | null | undefined, now: number): number | undefined {
	if (dueOn === undefined || dueOn === null) {
		return undefined;
	}
	const due = parseInstant(dueOn.length === 10 ? `${dueOn}T23:59:59.999` : dueOn);
	return Number.isNaN(due) ? undefined : due - now;
}

function overdueMatches(where: CompiledWhere, remaining: number | undefined): boolean {
	if (where.overdue === undefined) {
		return true;
	}
	return remaining === undefined ? !where.overdue : remaining < 0 === where.overdue;
}

function timingMatches(where: CompiledWhere, state: ObjectState, now: number): boolean {
	if (
		where.overdue === undefined &&
		where.dueWithinMs === undefined &&
		where.createdWithinMs === undefined
	) {
		return true;
	}
	const remaining = untilDue(state.dueOn, now);
	if (!overdueMatches(where, remaining)) {
		return false;
	}
	if (
		where.dueWithinMs !== undefined &&
		(remaining === undefined || remaining < 0 || remaining > where.dueWithinMs)
	) {
		return false;
	}
	if (where.createdWithinMs !== undefined) {
		const created = state.createdAt === undefined ? Number.NaN : Date.parse(state.createdAt);
		if (Number.isNaN(created) || now - created > where.createdWithinMs) {
			return false;
		}
	}
	return true;
}

function stateMatches(where: CompiledWhere, facts: Facts, now: number = Date.now()): boolean {
	const state = facts.state ?? {};
	return (
		inScope(where.createdBy, state.createdBy) &&
		(where.completed === undefined || state.completed === where.completed) &&
		(where.hasParent === undefined || state.hasParent === where.hasParent) &&
		nameMatches(where, state.name) &&
		timingMatches(where, state, now)
	);
}

export { inScope, stateMatches };
