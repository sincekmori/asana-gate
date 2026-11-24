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
 * An object without the members `selection` leaves out altogether; all of
 * it without a selection. What is left is what needs checking, before
 * {@link pick} cuts inside the members kept.
 */
function keep(object: AsanaObject, selection: Selection | undefined): AsanaObject {
	return selection === undefined
		? object
		: Object.fromEntries(
				Object.entries(object).filter(([name]) => name === "gid" || selection.has(name)),
			);
}

/**
 * An object cut back to the members `selection` names (and its `gid`); all
 * of it without a selection. A member selected alone is kept as it is:
 * after {@link widenSelection}, which never selects inside one, that is how
 * Asana would have answered the selection alone, and after {@link askFor}
 * it keeps what the gate selected inside it.
 */
function pick(object: AsanaObject, selection: Selection | undefined): AsanaObject {
	const picked = selection === undefined ? object : cut(object, selection);
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

/**
 * The fields a response keeps of what Asana sends: the caller's, or for a
 * list the gate must name fields for, those that stand in for Asana's
 * default; `undefined` where Asana's default stands.
 */
function keptFields(
	response: ResponsePlan,
	requested: readonly string[] | undefined,
): readonly string[] | undefined {
	if (response.kind !== "list") {
		return requested;
	}
	if (response.type === "mixed") {
		// Each item names its type: Asana names it only when it is selected, and an item of no known type is dropped.
		const fields = (response.expect ?? []).length > 0 ? (requested ?? ["name"]) : requested;
		return fields === undefined ? undefined : [...fields, "resource_type"];
	}
	if (response.facts !== undefined) {
		return requested;
	}
	return requested ?? DEFAULT_LIST_FIELDS[response.type] ?? ["name"];
}

/** How to ask for a response, and how to process it. */
interface Asked {
	/** The `opt_fields` to send; `undefined` leaves Asana's default alone. */
	readonly optFields: readonly string[] | undefined;
	/** The plan, with the selection its objects are cut back to. */
	readonly response: ResponsePlan;
}

/**
 * Asks for a response so that it carries what post-processing needs: the
 * fields kept ({@link keptFields}, from the fields the request names, if
 * any), and for objects judged by themselves, what their facts are derived
 * from. The objects are cut back to the fields kept once they are checked
 * ({@link pick}). Both are sent as one list, so a member kept alone that the
 * facts read inside comes back with what the gate selected inside it:
 * leaving it alone, as {@link widenSelection} does for one object, would
 * mean loading every object of a list beside it.
 */
function askFor(
	response: ResponsePlan,
	requested: readonly string[],
	requiredFields: RequiredFields,
): Asked {
	const kept = keptFields(response, requested.length > 0 ? requested : undefined);
	if (kept === undefined) {
		return { optFields: undefined, response };
	}
	if (response.kind === "raw" || response.kind === "custom") {
		return { optFields: withReferenceTypes(kept), response };
	}
	// A mixed list carries what the facts of any type it expects need.
	const types = response.type === "mixed" ? (response.expect ?? []) : [response.type];
	const needed = response.facts === undefined ? types.flatMap((type) => requiredFields(type)) : [];
	const selection = parseSelection(kept);
	return {
		// Every nested reference the response carries must name its type, or it could not be checked.
		optFields: withReferenceTypes([...kept, ...needed]),
		response: selection === undefined ? response : { ...response, selection },
	};
}

export {
	askFor,
	fieldsOf,
	keep,
	parseOptFields,
	parseSelection,
	pick,
	requestedFields,
	widenSelection,
	withReferenceTypes,
};
export type { RequiredFields, Selection };
