// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { splitList } from "../asana/query.ts";
import type { Resource } from "../catalog/resources.ts";
import { type AsanaObject, isObject } from "./objects.ts";
import type { ResponsePlan } from "./plan.ts";

/**
 * Parsed `opt_fields`: per member, what is selected inside it; none when the
 * member is selected alone. A member named both alone and with a selection
 * inside it counts as the latter, as Asana answers it.
 */
type Selection = ReadonlyMap<string, Selection>;

/** A plain `opt_fields` path (`name`, `memberships.project.team`). */
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u;

/**
 * Parses `opt_fields`; `undefined` when one is not a plain path (or starts
 * with the legacy `this.`), so what Asana answers for it is not known.
 */
function parseSelection(fields: readonly string[]): Selection | undefined {
	if (!fields.every((field) => PATH.test(field) && field.split(".")[0] !== "this")) {
		return undefined;
	}
	const root = new Map<string, Map<string, unknown>>();
	for (const field of fields) {
		let node = root;
		for (const name of field.split(".")) {
			let next = node.get(name) as Map<string, Map<string, unknown>> | undefined;
			if (next === undefined) {
				next = new Map();
				node.set(name, next);
			}
			node = next;
		}
	}
	return root as Selection;
}

/**
 * The fields a request asks for: its comma-separated `opt_fields` and the
 * `options.fields` of an enveloped body (or of a batch action), trimmed,
 * with empty and repeated ones dropped.
 */
function requestedFields(optFields: unknown, optionFields: readonly unknown[] = []): string[] {
	const named = optionFields.filter((field): field is string => typeof field === "string");
	return [
		...new Set(splitList([typeof optFields === "string" ? optFields : "", ...named].join(","))),
	];
}

/** A request's comma-separated `opt_fields`, and their selection when every one is a plain path. */
function parseOptFields(text: string | undefined): {
	readonly fields: readonly string[];
	readonly selection: Selection | undefined;
} {
	const fields = splitList(text ?? "");
	return { fields, selection: fields.length === 0 ? undefined : parseSelection(fields) };
}

/** The `opt_fields` of a selection. */
function fieldsOf(selection: Selection, prefix = ""): string[] {
	return [...selection].flatMap(([name, inner]) =>
		inner.size === 0 ? [`${prefix}${name}`] : fieldsOf(inner, `${prefix}${name}.`),
	);
}

/**
 * The caller's selection together with what the gate needs, for a response
 * that {@link pick} then cuts back to the caller's. A member the caller
 * selects alone is left alone: selecting inside it would change what Asana
 * answers for it (`{ gid, resource_type }`), which no cut could restore, so
 * what the gate needed there is missing and `complete` is false.
 */
function widenSelection(
	caller: Selection,
	needed: Selection,
): { readonly sent: Selection; readonly complete: boolean } {
	const sent = new Map(caller);
	let complete = true;
	for (const [name, inner] of needed) {
		const own = caller.get(name);
		if (own === undefined) {
			sent.set(name, inner);
		} else if (own.size === 0) {
			complete &&= inner.size === 0;
		} else {
			const widened = widenSelection(own, inner);
			sent.set(name, widened.sent);
			complete &&= widened.complete;
		}
	}
	return { sent, complete };
}

/** {@link pick} on any value: lists item by item, objects member by member. */
function cut(value: unknown, selection: Selection): unknown {
	if (Array.isArray(value)) {
		return value.map((item: unknown) => cut(item, selection));
	}
	if (!isObject(value)) {
		return value;
	}
	const picked: AsanaObject = "gid" in value ? { gid: value.gid } : {};
	for (const [name, inner] of selection) {
		if (name in value) {
			picked[name] = inner.size === 0 ? value[name] : cut(value[name], inner);
		}
	}
	return picked;
}

/**
 * An object cut back to the members `selection` names (and its `gid`), the
 * way Asana would have answered that selection alone: members selected
 * alone are kept as they are, since {@link widenSelection} never selects
 * inside them.
 */
function pick(object: AsanaObject, selection: Selection): AsanaObject {
	const picked = cut(object, selection);
	return isObject(picked) ? picked : {};
}

/**
 * `opt_fields` with `resource_type` selected inside every member they reach
 * into. Asana answers a member with a selection inside it with only its
 * `gid` and that selection (`parent.name` gives `{ gid, name }`, and
 * `parent` next to `parent.memberships.project` gives `{ gid, memberships }`;
 * observed live), so without it a nested reference cannot be told from any
 * other object, and the gate could not check it. Inside a non-resource
 * object (a membership) the member is unknown, and Asana ignores it.
 */
function withReferenceTypes(fields: readonly string[]): string[] {
	const types = fields.flatMap((field) => {
		const names = field.split(".");
		return names.slice(1).map((_, depth) => `${names.slice(0, depth + 1).join(".")}.resource_type`);
	});
	return [...new Set([...fields, ...types])];
}

/** Per resource, the fields a list item carries when the caller asks for none. */
const DEFAULT_LIST_FIELDS: Partial<Record<Resource, readonly string[]>> = {
	story: ["text", "resource_subtype", "created_at", "created_by", "type"],
	status_update: ["title", "status_type", "resource_subtype", "created_at"],
	attachment: ["name", "resource_subtype", "created_at"],
	time_tracking_entry: ["duration_minutes", "entered_on", "created_by"],
	membership: ["member", "parent", "access_level", "resource_subtype"],
	project_membership: ["member", "parent", "access_level"],
	portfolio_membership: ["user", "portfolio", "access_level"],
	team_membership: ["user", "team", "is_admin", "is_guest"],
	workspace_membership: ["user", "workspace", "is_active"],
	custom_field_setting: ["custom_field", "is_important", "parent"],
	webhook: ["resource", "target", "active"],
	allocation: ["assignee", "parent", "start_date", "end_date"],
	budget: ["budget_type", "parent"],
	rate: ["rate", "parent", "resource"],
	goal_relationship: ["supporting_resource", "supported_goal", "resource_subtype"],
	project_portfolio_setting: ["project", "portfolio", "is_access_control_inherited"],
	ooo_entry: ["user", "start_date", "end_date"],
	timesheet_approval_status: ["user", "start_date", "end_date", "approval_status"],
	time_period: ["display_name", "period", "start_on", "end_on"],
	notification: ["story", "work_objects", "is_read", "created_at"],
	access_request: ["requester", "target", "approval_status"],
};

/** Per resource, the `opt_fields` the loader needs to derive an object's facts. */
type RequiredFields = (type: Resource) => readonly string[];

/** What post-processing needs the response to carry, as `opt_fields`. */
function neededFields(
	response: ResponsePlan,
	requested: readonly string[] | undefined,
	requiredFields: RequiredFields,
): readonly string[] | undefined {
	if (response.kind === "raw" || response.kind === "custom") {
		return requested;
	}
	if (response.type === "mixed") {
		// Each item names its type, and carries what the facts of any expected type need.
		const expected = response.expect ?? [];
		if (expected.length === 0) {
			// Asana names an item's type only when it is selected, and an item of no known type is dropped.
			return requested === undefined ? undefined : [...new Set([...requested, "resource_type"])];
		}
		return [
			...new Set([
				...(requested ?? ["name"]),
				"resource_type",
				...expected.flatMap((type) => requiredFields(type)),
			]),
		];
	}
	if (response.facts !== undefined) {
		return requested;
	}
	const required = requiredFields(response.type);
	if (response.kind === "item") {
		// Without `opt_fields` Asana returns the full object, which carries every required field.
		return requested === undefined ? undefined : [...new Set([...requested, ...required])];
	}
	const base = requested ?? DEFAULT_LIST_FIELDS[response.type] ?? ["name"];
	return [...new Set([...base, ...required])];
}

/**
 * The `opt_fields` to send so the response carries what post-processing
 * needs; `undefined` leaves the caller's choice (or Asana's default) alone.
 */
function augmentOptFields(
	response: ResponsePlan,
	requested: readonly string[] | undefined,
	requiredFields: RequiredFields,
): readonly string[] | undefined {
	const fields = neededFields(response, requested, requiredFields);
	// Every nested reference the response carries must name its type, or it could not be checked.
	return fields === undefined ? undefined : withReferenceTypes(fields);
}

export {
	augmentOptFields,
	fieldsOf,
	parseOptFields,
	parseSelection,
	pick,
	requestedFields,
	widenSelection,
	withReferenceTypes,
};
export type { RequiredFields, Selection };
