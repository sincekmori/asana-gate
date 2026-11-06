// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { isObject } from "../json.ts";
import { parseInstant, resolveDateBound } from "./durations.ts";

/**
 * The content constraints a rule may carry (require / apply / forbid /
 * redact / limit / confirm): the small evaluators that turn one requirement
 * or application into a verdict or a changed request body. They know nothing
 * about Asana; the gate feeds them request bodies and scopes.
 */

/** A scalar a policy may name as a value. */
type Scalar = string | number | boolean;

/** One requirement on a request member. Every operator present must hold. */
interface FieldRequirement {
	/** On create the member must be set and non-empty; on update it may not be cleared. */
	readonly present?: boolean;
	readonly prefix?: string;
	readonly suffix?: string;
	readonly contains?: string;
	readonly matches?: RegExp;
	readonly notMatches?: RegExp;
	readonly in?: ReadonlySet<string>;
	readonly notIn?: ReadonlySet<string>;
	readonly minLength?: number;
	readonly maxLength?: number;
	/** A number, or a date (`YYYY-MM-DD`, ISO 8601, `today`, `now`, `+7d`, `-1d`). */
	readonly min?: Scalar;
	readonly max?: Scalar;
}

/** One application to a request member. */
interface FieldApplication {
	/** Set when the member is absent or empty. */
	readonly default?: Scalar | readonly Scalar[];
	/** Always set, overriding what the request says. */
	readonly value?: Scalar | readonly Scalar[];
	/** Prepend to a string member unless it already starts with it. */
	readonly prefix?: string;
	/** Append to a string member unless it already ends with it. */
	readonly suffix?: string;
	/** Make sure a list member contains these values. */
	readonly add?: readonly Scalar[];
}

/** A rate limit: at most `max` requests per `perMs` milliseconds (`per` as written, for messages). */
interface RateLimit {
	readonly max: number;
	readonly perMs: number;
	readonly per: string;
}

/** Whether a request creates or updates the object. */
type Verb = "create" | "update";

/** The verdict of one requirement: why it does not hold. */
type Violation = string;

/** Whether a request value counts as empty (absent, null, "", []). */
function isEmpty(value: unknown): boolean {
	return (
		value === undefined ||
		value === null ||
		(typeof value === "string" && value.trim() === "") ||
		(Array.isArray(value) && value.length === 0)
	);
}

/** The text of one scalar or reference value, if it has one. */
function textOf(value: unknown): string | undefined {
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (isObject(value)) {
		return typeof value.gid === "string" ? value.gid : undefined;
	}
	return undefined;
}

/** The strings a value is compared with: the value itself, a reference's gid, or each list element. */
function textsOf(value: unknown): string[] {
	const items: unknown[] = Array.isArray(value) ? value : [value];
	return items.map((item) => textOf(item)).filter((text): text is string => text !== undefined);
}

/** Checks a string member against the text operators. */
function textViolations(text: string, requirement: FieldRequirement): Violation[] {
	const checks: [boolean, string][] = [
		[
			requirement.prefix === undefined || text.startsWith(requirement.prefix),
			`must start with "${requirement.prefix ?? ""}"`,
		],
		[
			requirement.suffix === undefined || text.endsWith(requirement.suffix),
			`must end with "${requirement.suffix ?? ""}"`,
		],
		[
			requirement.contains === undefined || text.includes(requirement.contains),
			`must contain "${requirement.contains ?? ""}"`,
		],
		[
			requirement.matches === undefined || requirement.matches.test(text),
			`must match ${String(requirement.matches)}`,
		],
		[
			requirement.notMatches === undefined || !requirement.notMatches.test(text),
			`must not match ${String(requirement.notMatches)}`,
		],
		[
			requirement.minLength === undefined || text.length >= requirement.minLength,
			`must be at least ${requirement.minLength ?? 0} characters`,
		],
		[
			requirement.maxLength === undefined || text.length <= requirement.maxLength,
			`must be at most ${requirement.maxLength ?? 0} characters`,
		],
	];
	return checks.filter(([ok]) => !ok).map(([, message]) => message);
}

/** Checks the value(s) of a member against the `in` / `not_in` sets. */
function setViolations(texts: readonly string[], requirement: FieldRequirement): Violation[] {
	const violations: Violation[] = [];
	const allowed = requirement.in;
	if (allowed !== undefined && texts.some((text) => !allowed.has(text))) {
		violations.push(`must be one of ${[...allowed].join(", ")}`);
	}
	const denied = requirement.notIn;
	if (denied !== undefined && texts.some((text) => denied.has(text))) {
		violations.push(`must not be one of ${[...denied].join(", ")}`);
	}
	return violations;
}

/** A date without a time of day (`due_on`), compared as a calendar day. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;

const DAY_MS = 86_400_000;

/** Compares a number or date member with a bound. */
function boundViolation(
	value: unknown,
	bound: { limit: Scalar; kind: "min" | "max" },
	now: Date,
): Violation | undefined {
	const atLeast = bound.kind === "min";
	if (typeof bound.limit === "number" && typeof value === "number") {
		const ok = atLeast ? value >= bound.limit : value <= bound.limit;
		return ok ? undefined : `must be ${atLeast ? "at least" : "at most"} ${bound.limit}`;
	}
	const limit = typeof bound.limit === "string" ? resolveDateBound(bound.limit, now) : undefined;
	const actual = typeof value === "string" ? parseInstant(value) : Number.NaN;
	if (limit === undefined || Number.isNaN(actual)) {
		return `must be comparable with ${String(bound.limit)}`;
	}
	// A date-only member is a whole (UTC) day: `now`, `+7d` and `-1d` stand for
	// the day they fall on, so `min: "+7d"` admits the date seven days out.
	const day = typeof value === "string" && DATE_ONLY.test(value);
	const [left, right] = day
		? [Math.floor(actual / DAY_MS), Math.floor(limit / DAY_MS)]
		: [actual, limit];
	const ok = atLeast ? left >= right : left <= right;
	return ok
		? undefined
		: `must be ${atLeast ? "on or after" : "on or before"} ${String(bound.limit)}`;
}

/**
 * Checks a request member against a requirement. `verb` decides what
 * `present` means. `value` is the member as sent (`undefined` when absent).
 */
function checkRequirement(
	value: unknown,
	requirement: FieldRequirement,
	context: { verb: Verb; now?: Date },
): Violation[] {
	const violations: Violation[] = [];
	const now = context.now ?? new Date();
	if (
		requirement.present === true &&
		isEmpty(value) &&
		(context.verb === "create" || value !== undefined)
	) {
		violations.push(context.verb === "create" ? "is required" : "cannot be cleared");
	}
	if (value === undefined || value === null) {
		return violations;
	}
	if (typeof value === "string") {
		violations.push(...textViolations(value, requirement));
	}
	violations.push(...setViolations(textsOf(value), requirement));
	for (const kind of ["min", "max"] as const) {
		const limit = requirement[kind];
		const violation = limit === undefined ? undefined : boundViolation(value, { limit, kind }, now);
		if (violation !== undefined) {
			violations.push(violation);
		}
	}
	return violations;
}

/** The value after `value` / `default`. */
function applyValue(value: unknown, application: FieldApplication, verb: Verb): unknown {
	if (application.value !== undefined) {
		return application.value;
	}
	if (
		application.default !== undefined &&
		isEmpty(value) &&
		(verb === "create" || value !== undefined)
	) {
		return application.default;
	}
	return value;
}

/** The list after `add`. */
function applyAdd(value: unknown, add: readonly Scalar[]): unknown[] {
	let list: unknown[] = [];
	if (Array.isArray(value)) {
		list = [...(value as unknown[])];
	} else if (!isEmpty(value)) {
		list = [value];
	}
	const present = new Set(textsOf(list));
	for (const item of add) {
		if (!present.has(String(item))) {
			list.push(item);
		}
	}
	return list;
}

/** The string after `prefix` / `suffix`. */
function applyAffixes(text: string, application: FieldApplication): string {
	let next = text;
	if (application.prefix !== undefined && !next.startsWith(application.prefix)) {
		next = `${application.prefix}${next}`;
	}
	if (application.suffix !== undefined && !next.endsWith(application.suffix)) {
		next = `${next}${application.suffix}`;
	}
	return next;
}

/** Applies an application to a request member; returns the new value (or the old one when nothing changes). */
function applyApplication(value: unknown, application: FieldApplication, verb: Verb): unknown {
	let next = applyValue(value, application, verb);
	if (application.add !== undefined && (verb === "create" || next !== undefined)) {
		next = applyAdd(next, application.add);
	}
	const affixes = application.prefix !== undefined || application.suffix !== undefined;
	if (affixes && (typeof next === "string" || (next === undefined && verb === "create"))) {
		next = applyAffixes(typeof next === "string" ? next : "", application);
	}
	return next;
}

export { applyApplication, checkRequirement, textsOf };
export type { FieldApplication, FieldRequirement, RateLimit, Scalar, Violation };
