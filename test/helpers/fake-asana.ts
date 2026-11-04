// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { ASANA_API_BASE_URL } from "../../src/asana/client.ts";
import { splitList } from "../../src/asana/query.ts";
import type { OperationSpec } from "../../src/catalog/operation-spec.ts";
import { type OperationId, OPERATIONS } from "../../src/catalog/operations.gen.ts";
import { RESPONSE_SCHEMAS, SCHEMAS, type SchemaShape } from "../../src/catalog/schemas.gen.ts";
import { isHttpMethod, matchRoute } from "../../src/gate/router.ts";
import { isObject } from "../../src/json.ts";

/**
 * An in-memory stand-in for the Asana REST API. Requests are routed with the
 * gate's own router over the operations of the OpenAPI snapshot and served
 * from one object store keyed by resource type and gid. Answers copy Asana:
 * `{ data }` envelopes, `next_page`, error bodies, and objects projected
 * through `opt_fields` (the `gid` and the members asked for; a reference is
 * compact unless its own members are asked for) or, without them, through the
 * operation's response schema (so lists answer compact objects).
 *
 * Most operations are served by their shape: `GET` / `PUT` / `DELETE
 * /<objects>/{gid}`, `POST /<objects>` and `POST /<parent>/{gid}/<objects>`,
 * lists under a parent or filtered by the query, and adding or removing
 * followers, members, dependencies and tags. Operations with semantics of
 * their own have handlers: placing and ordering tasks and sections, subtasks,
 * portfolio items, team members, search, typeahead, the events handshake and
 * the Batch API. Any other operation answers 501, so a test that reaches one
 * fails instead of passing against a fake that does nothing.
 *
 * The world: workspaces 1 (Acme, governed) and 2; users 51 (Me, the token's
 * user) and 52 (Bob); teams 11 (Platform) and 12 (Design); projects 21
 * (Backend, sections 31 Backlog and 32 Done) and 22 (Design System, section
 * 33) of team 11, and 23 (Secret, section 34) of team 12; tags 41 (ai-ok) and
 * 42 (frozen); the enum custom field 61 (Owner: options 71 AI and 72 Human);
 * portfolio 81 (Roadmap) holding project 22; and tasks 101 (in 31), 102 (in
 * 34), 103 (in 31, listed above 101, and in 34), 104 (a subtask of 101), 105
 * (completed, in 32), 106 (in no project) and 107 (in 33, tagged 41, assigned
 * to 51, created by 52), with a comment on 101.
 */

type Json = Record<string, unknown>;

/** A reference to an object, as Asana embeds it and as the store keeps it. */
interface Ref {
	readonly gid: string;
	readonly resource_type: string;
}

/** A request the fake received. */
interface Call {
	method: string;
	url: URL;
	body?: unknown;
	/** The text members of a multipart body (a file shows as its name). */
	form?: Record<string, string>;
}

interface Reply {
	status: number;
	body: Json;
}

/** What to show of a value: everything (references compact) when `undefined`, else the members named. */
type Selection = ReadonlyMap<string, Selection | undefined>;

/** A selection being built from `opt_fields`. */
type SelectionTree = Map<string, SelectionTree>;

/** Every object of the fake, by resource type and gid, each as Asana shows it in full with references compact. */
interface ObjectStore {
	/** The object of `type` with `gid`. */
	get(type: string, gid: string): Json | undefined;
	/** The object with `gid`, whatever its type (Asana's gids are unique across types). */
	byGid(gid: string): Json | undefined;
	/** Every object of `type`, in the order they were stored. */
	all(type: string): Json[];
	/** Stores `object` under its own `resource_type` and `gid`. */
	put(object: Json): Json;
	/** Removes an object; whether there was one. */
	delete(type: string, gid: string): boolean;
}

/** A request handed to the fake: the `data` of its body and the `options.fields` it carries. */
interface Sent {
	readonly method: string;
	readonly url: URL;
	readonly data: Json;
	readonly fields?: readonly string[];
}

/** One request, as a route sees it. */
interface Incoming {
	readonly params: Readonly<Record<string, string>>;
	readonly query: URLSearchParams;
	readonly data: Json;
}

/**
 * What a route found, still to be projected: one object, or a list (paged
 * unless said otherwise, with `extra` members beside its `data`); or a reply
 * of its own.
 */
type Answer =
	| { readonly one: Json; readonly status?: number }
	| { readonly many: readonly Json[]; readonly paged?: false; readonly extra?: Json }
	| Reply;

type Handler = (request: Incoming) => Answer;

/** Where `insert_before` / `insert_after` put an object among its siblings. */
type Position = "top" | "bottom" | { readonly before: string } | { readonly after: string };

/** A route under a parent: the parent's path parameter, the last path segment, and the type of the objects there. */
interface Nested {
	readonly param: string;
	readonly segment: string;
	readonly type: string | undefined;
}

/** The objects, state and shared operations of one fake. */
interface World {
	readonly store: ObjectStore;
	/**
	 * Ordered gids per container: `project:<gid>` its sections, `section:<gid>`
	 * its tasks, `task:<gid>` its subtasks, `<objects>:<gid>` the objects listed
	 * under a parent (`custom_field_settings:<project gid>`), and
	 * `portfolio:<gid>` its items. The objects' own members say what is where
	 * and a list only orders them, except a portfolio's items, which are the
	 * list itself (Asana's portfolio object does not name them).
	 */
	readonly lists: Map<string, string[]>;
	newGid(): string;
	/** The order list of a container. */
	listAt(key: string): string[];
	/** The order list of a container, rebuilt to hold exactly `objects` in their current order. */
	synced(key: string, objects: readonly Json[]): string[];
	/** The object of `type` a path names; Asana's 404 when there is none. */
	lookup(type: string, gid?: string): Json;
	/** The object a request member names; a gid nothing has is refused. */
	named(member: string, value: unknown): Ref | null;
	/** Writes a request body's members into `object`. */
	write(object: Json, data: Json): Json;
	/** A new object of `type`: what its schema and template start with, then the request body. */
	fresh(type: string, data: Json): Json;
	/** Stores a new object once it belongs to a workspace, if its type belongs to one. */
	settle(object: Json): Json;
	/** Whether `object` names `gid` in `member` (or its singular or plural), or in its memberships. */
	names(object: Json, member: string, gid: string): boolean;
	/** Whether `object` is a child a list under `parent` shows. */
	isChildOf(object: Json, parent: Json): boolean;
	/** A member, stored or derived. */
	valueOf(object: Json, member: string): unknown;
	/** The objects a query's filters keep. */
	filtered(objects: readonly Json[], query: URLSearchParams): Json[];
	/** The workspace an object belongs to, directly or through what it belongs to. */
	workspaceOf(object: Json | undefined): Ref | undefined;
	/** A top-level object through a selection, or with every member it holds. */
	show(object: Json, selection: Selection | undefined): Json;
	sectionsOf(project: string): Json[];
	tasksOfSection(section: string): Json[];
	/** A project's tasks in Asana's order: section by section, each in its own order. */
	tasksOfProject(project: string): Json[];
	subtasksOf(parent: string): Json[];
	/** Puts `task` into `section`, replacing its other section in that project. */
	moveToSection(task: Json, section: Json, position: Position): void;
	/** Puts `task` into `project` as `addProject` does: into a section, next to a sibling, or at an end. */
	addToProject(task: Json, project: Json, data: Json): void;
	/** Makes `task` a subtask of `parent`, or a top-level task when `parent` is `null`. */
	setParent(task: Json, parent: Ref | null, position: Position): void;
	/** Creates a task as `POST /tasks` does: placed in its projects or memberships, under its parent. */
	createTask(data: Json): Json;
}

const HELP =
	"For more information on API status codes and how to handle them, read the docs on errors: https://developers.asana.com/docs/errors";

const BASE_URL = ASANA_API_BASE_URL;

/** The user the token belongs to. */
const ME = "51";

const SEEDED_AT = "2026-11-01T00:00:00.000Z";

const RESPONSES: Readonly<Record<OperationId, string | null>> = RESPONSE_SCHEMAS;
const SCHEMA_SHAPES: Readonly<Record<string, SchemaShape | undefined>> = SCHEMAS;

const ref = (type: string, gid: string): Ref => ({ gid, resource_type: type });

const ok = (body: Json): Reply => ({ status: 200, body });

function error(status: number, message: string, extra: Json = {}): Reply {
	return { status, body: { errors: [{ message, help: HELP }], ...extra } };
}

/** Asana's answer for a gid it does not know (or the token cannot see). */
const notFound = (type: string, gid: string): Reply =>
	error(404, `${type}: Not a recognized ID: ${gid}`);

/** Thrown by a route to answer with an error. */
class RefusalError extends Error {
	public readonly reply: Reply;

	public constructor(reply: Reply) {
		super(JSON.stringify(reply.body));
		this.name = "RefusalError";
		this.reply = reply;
	}
}

function refuse(reply: Reply): never {
	throw new RefusalError(reply);
}

/** A request member Asana requires; its 400 when the member is missing. */
const required = (data: Json, member: string): unknown =>
	data[member] ?? refuse(error(400, `${member}: Missing input`));

const isReply = (answer: Answer): answer is Reply => "body" in answer;

const isRef = (value: unknown): value is Json & Ref =>
	isObject(value) && typeof value.gid === "string" && typeof value.resource_type === "string";

const refTo = (object: Json): Ref => ref(String(object.resource_type), String(object.gid));

const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

/** The gid of a reference, or of a bare gid. */
function gidOf(value: unknown): string | undefined {
	if (typeof value === "string") {
		return value;
	}
	return isObject(value) && typeof value.gid === "string" ? value.gid : undefined;
}

/** The gids a member names: one reference, a bare gid, or a list of either. */
function gidsIn(value: unknown): string[] {
	const values: unknown[] = Array.isArray(value) ? value : [value];
	return values.map((item) => gidOf(item)).filter((gid) => gid !== undefined);
}

const membershipsOf = (object: Json): Json[] =>
	Array.isArray(object.memberships) ? object.memberships.filter((m) => isObject(m)) : [];

/** The section a task sits in within `project`. */
function sectionIn(task: Json, project: string): string | undefined {
	const membership = membershipsOf(task).find((m) => gidOf(m.project) === project);
	return gidOf(membership?.section);
}

/** A comma-separated list, as Asana reads `opt_fields` and search filters. */
const commaList = (text: string | null): string[] => splitList(text ?? "");

/** Pages `items` the way Asana does when `limit` is given; otherwise returns them all. */
function page(items: readonly Json[], url: URL): Json {
	const limit = Number(url.searchParams.get("limit"));
	if (!limit) {
		return { data: items };
	}
	const offset = Number(url.searchParams.get("offset") ?? "0");
	const slice = items.slice(offset, offset + limit);
	const more = offset + limit < items.length;
	return {
		data: slice,
		next_page: more ? { offset: String(offset + limit), path: url.pathname, uri: url.href } : null,
	};
}

/** The members of a multipart body, a file by its name. */
function formOf(form: FormData): Record<string, string> {
	return Object.fromEntries(
		[...form].map(([key, value]) => [key, typeof value === "string" ? value : value.name]),
	);
}

function urlOf(input: string | URL | Request): string {
	if (typeof input === "string") {
		return input;
	}
	return input instanceof URL ? input.href : input.url;
}

/** The `data` of a JSON body, and the `options.fields` Asana reads like `opt_fields`. */
function envelopeOf(init: RequestInit | undefined): { data: Json; fields: string[] } {
	if (typeof init?.body !== "string") {
		return { data: {}, fields: [] };
	}
	const parsed = JSON.parse(init.body) as Json;
	const options = isObject(parsed.options) ? parsed.options : {};
	const fields = Array.isArray(options.fields) ? options.fields.map(String) : [];
	return { data: isObject(parsed.data) ? parsed.data : parsed, fields };
}

/** The selection `opt_fields` names: `parent.memberships.project` selects `project` in `memberships` in `parent`. */
function selectionOf(fields: readonly string[]): Selection {
	const root: SelectionTree = new Map();
	for (const field of fields) {
		let node = root;
		for (const name of field.replace(/^this\./u, "").split(".")) {
			const child: SelectionTree = node.get(name) ?? new Map();
			node.set(name, child);
			node = child;
		}
	}
	return root;
}

/** The selection a response schema stands for: its members, and the members of its nested objects. */
function schemaSelection(schema: string | null): Selection | undefined {
	const shape = schema === null ? undefined : SCHEMA_SHAPES[schema];
	if (shape === undefined) {
		return undefined;
	}
	return new Map(
		Object.entries(shape).map(([member, nested]) => [
			member,
			nested === null ? undefined : new Map(Object.keys(nested).map((name) => [name, undefined])),
		]),
	);
}

/** The full schema of a resource type's objects (`task` → `TaskResponse`). */
function schemaOfType(type: string): SchemaShape {
	const pascal = type
		.split("_")
		.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
		.join("");
	return SCHEMA_SHAPES[`${pascal}Response`] ?? SCHEMA_SHAPES[pascal] ?? {};
}

/** The resource type a response schema describes (`TaskCompact` → `task`); `undefined` for mixed and empty ones. */
function typeOfSchema(schema: string | null): string | undefined {
	const base = schema?.replace(/(?:Response|Compact)$/u, "");
	if (base === undefined || base === "Empty" || base === "AsanaNamedResource") {
		return undefined;
	}
	return base.replaceAll(/(?<=[a-z])(?=[A-Z])/gu, "_").toLowerCase();
}

/** The segments of a path template, a parameter as its name in braces. */
const segmentsOf = (spec: OperationSpec): string[] =>
	spec.path.split("/").filter((segment) => segment !== "");

/** The parameter a path segment stands for, if it is one. */
const paramOf = (segment: string | undefined): string | undefined =>
	segment === undefined ? undefined : /^\{(?<name>[^}]+)\}$/u.exec(segment)?.groups?.name;

/** Types Asana also serves under a deprecated name: `/project_statuses` holds status updates. */
const STORED_AS: Readonly<Record<string, string>> = { project_status: "status_update" };

/** The resource type a `<type>_gid` parameter names, as the store keeps it. */
const typeOfParam = (param: string | undefined): string | undefined => {
	const type = param?.endsWith("_gid") === true ? param.slice(0, -"_gid".length) : undefined;
	return type === undefined ? undefined : (STORED_AS[type] ?? type);
};

/** An object as an operation of a deprecated name answers it (`resource_type: project_status`). */
function asNamed(object: unknown, schema: string | null): unknown {
	const named = typeOfSchema(schema);
	const stored = named === undefined ? undefined : STORED_AS[named];
	return isObject(object) && stored !== undefined && object.resource_type === stored
		? { ...object, resource_type: named }
		: object;
}

/** Per path segment of a collection (`tasks`), the type of its objects (`task`), from the `/<objects>/{<type>_gid}` paths. */
const TYPES: ReadonlyMap<string, string> = new Map(
	Object.values(OPERATIONS).flatMap((spec): [string, string][] => {
		const [plural, param] = segmentsOf(spec);
		const type = typeOfParam(paramOf(param));
		return plural === undefined || type === undefined || paramOf(plural) !== undefined
			? []
			: [[plural, type]];
	}),
);

/** Request members that name objects, with the type they name (`undefined`: any type). */
const REFERENCE_MEMBERS: Readonly<Record<string, string | undefined>> = {
	assignee: "user",
	assigned_by: "user",
	completed_by: "user",
	created_by: "user",
	followers: "user",
	members: "user",
	owner: "user",
	people_value: "user",
	requester: "user",
	user: "user",
	dependencies: "task",
	task: "task",
	workspace: "workspace",
	organization: "workspace",
	team: "team",
	project: "project",
	section: "section",
	assignee_section: "section",
	tag: "tag",
	tags: "tag",
	portfolio: "portfolio",
	custom_field: "custom_field",
	custom_type: "custom_type",
	enum_option: "enum_option",
	supported_goal: "goal",
	time_period: "time_period",
	parent: undefined,
	target: undefined,
	resource: undefined,
	item: undefined,
	supporting_resource: undefined,
};

/** Members a write never stores: they say where an object goes. */
const UNSTORED: ReadonlySet<string> = new Set([
	"gid",
	"resource_type",
	"insert_before",
	"insert_after",
]);

/** Task members the placement routes write, or that Asana derives from other objects. */
const TASK_PLACEMENT: ReadonlySet<string> = new Set([
	"projects",
	"memberships",
	"dependents",
	"num_subtasks",
]);

/** Members of a child that name the object it was created under or is listed under. */
const RELATIONS = ["target", "parent"];

/** Query parameters that do not filter a list. */
const NOT_FILTERS: ReadonlySet<string> = new Set([
	"limit",
	"offset",
	"opt_fields",
	"opt_pretty",
	"modified_since",
	"include_inherited_projects",
	"sort_by",
	"sort_ascending",
]);

/** The `add<Member>` / `remove<Member>` routes that change a member with no semantics of their own. */
const LIST_ACTIONS = /^(?:add|remove)(?:Followers|Members|Dependencies|Tag)$/u;

/** The member values each new object of a type starts with, besides what its schema implies. */
const TEMPLATES: Readonly<Record<string, () => Json>> = {
	task: () => ({
		resource_subtype: "default_task",
		name: "",
		notes: "",
		completed: false,
		completed_at: null,
		due_on: null,
		due_at: null,
		start_on: null,
		assignee: null,
		parent: null,
		workspace: null,
		memberships: [],
		tags: [],
		followers: [ref("user", ME)],
		dependencies: [],
		custom_fields: [],
	}),
	project: () => ({
		name: "",
		notes: "",
		archived: false,
		completed: false,
		color: null,
		public: false,
		due_on: null,
		start_on: null,
		team: null,
		workspace: null,
		members: [ref("user", ME)],
		followers: [ref("user", ME)],
		custom_fields: [],
	}),
	section: () => ({ name: "" }),
	tag: () => ({ name: "", color: null, notes: "", followers: [], workspace: null }),
	portfolio: () => ({
		name: "",
		color: null,
		public: false,
		workspace: null,
		members: [ref("user", ME)],
		custom_fields: [],
	}),
	custom_field: () => ({
		name: "",
		resource_subtype: "text",
		description: "",
		enabled: true,
		enum_options: [],
		workspace: null,
	}),
	enum_option: () => ({ name: "", enabled: true, color: "none" }),
	team: () => ({ name: "", description: "", organization: null }),
	story: () => ({ type: "comment", resource_subtype: "comment_added", text: "" }),
	attachment: () => ({ name: "", resource_subtype: "asana", parent: null }),
	goal: () => ({ name: "", notes: "", status: null, team: null, workspace: null, followers: [] }),
	access_request: () => ({ approval_status: "pending", message: "" }),
};

const now = (): string => new Date().toISOString();

function createStore(): ObjectStore {
	const types = new Map<string, Map<string, Json>>();
	return {
		get: (type, gid) => types.get(type)?.get(gid),
		byGid: (gid) =>
			[...types.values()].map((objects) => objects.get(gid)).find((object) => object !== undefined),
		all: (type) => [...(types.get(type)?.values() ?? [])],
		put: (object) => {
			const type = String(object.resource_type);
			const objects = types.get(type) ?? new Map<string, Json>();
			types.set(type, objects);
			objects.set(String(object.gid), object);
			return object;
		},
		delete: (type, gid) => types.get(type)?.delete(gid) ?? false,
	};
}

/** Moves `gid` to `position` in `list`; a sibling the list does not hold is refused. */
function place(list: string[], gid: string, position: Position): void {
	const at = list.indexOf(gid);
	if (at !== -1) {
		list.splice(at, 1);
	}
	if (position === "top" || position === "bottom") {
		list.splice(position === "top" ? 0 : list.length, 0, gid);
		return;
	}
	const [key, sibling] =
		"before" in position ? ["insert_before", position.before] : ["insert_after", position.after];
	const index = list.indexOf(sibling);
	if (index === -1) {
		refuse(error(400, `${key}: ${sibling} is not among the siblings`));
	}
	list.splice("before" in position ? index : index + 1, 0, gid);
}

/** Where a request's `insert_before` / `insert_after` put an object: next to a sibling, or with `null` at an end. */
function positionOf(data: Json, otherwise: Position): Position {
	if (typeof data.insert_before === "string") {
		return { before: data.insert_before };
	}
	if (typeof data.insert_after === "string") {
		return { after: data.insert_after };
	}
	if (data.insert_after === null) {
		return "top";
	}
	return data.insert_before === null ? "bottom" : otherwise;
}

/** `objects` in the order of a list, those it does not hold last in their own order. */
function ordered(list: readonly string[], objects: readonly Json[]): Json[] {
	const rank = (object: Json): number => {
		const at = list.indexOf(String(object.gid));
		return at === -1 ? list.length : at;
	};
	return objects.toSorted((a, b) => rank(a) - rank(b));
}

/** Members Asana derives from other objects. */
function derived(store: ObjectStore, object: Json, member: string): unknown {
	if (object.resource_type !== "task") {
		return undefined;
	}
	const gid = String(object.gid);
	switch (member) {
		case "projects": {
			return membershipsOf(object).map((membership) => membership.project);
		}
		case "dependents": {
			const dependents = store
				.all("task")
				.filter((task) => gidsIn(task.dependencies).includes(gid));
			return dependents.map((task) => refTo(task));
		}
		case "num_subtasks": {
			return store.all("task").filter((task) => gidOf(task.parent) === gid).length;
		}
		default: {
			return undefined;
		}
	}
}

/** The value a custom field takes from a request value: an enum option, a number or a text. */
function fieldValue(store: ObjectStore, field: Json, value: unknown): Json {
	const option = (gid: unknown): Json => {
		const key = gidOf(gid) ?? "";
		const found = gidsIn(field.enum_options).includes(key)
			? store.get("enum_option", key)
			: undefined;
		return (
			found ?? refuse(error(400, `custom_fields: ${key} is not an option of ${textOf(field.name)}`))
		);
	};
	switch (field.resource_subtype) {
		case "enum": {
			const chosen = value === null ? undefined : option(value);
			return {
				enum_value: chosen === undefined ? null : refTo(chosen),
				display_value: chosen?.name ?? null,
			};
		}
		case "multi_enum": {
			const chosen = (Array.isArray(value) ? value : []).map((gid: unknown) => option(gid));
			return {
				multi_enum_values: chosen.map((choice) => refTo(choice)),
				display_value: chosen.map((choice) => textOf(choice.name)).join(", "),
			};
		}
		case "number": {
			return {
				number_value: value,
				display_value: typeof value === "number" ? String(value) : null,
			};
		}
		default: {
			return { text_value: value, display_value: value };
		}
	}
}

/** Creates the world's state and the operations its routes share. */
function createWorld(): World {
	const store = createStore();
	const lists = new Map<string, string[]>();
	let lastGid = 1000;

	const listAt = (key: string): string[] => {
		const list = lists.get(key) ?? [];
		lists.set(key, list);
		return list;
	};

	const synced = (key: string, objects: readonly Json[]): string[] => {
		const list = objects.map((object) => String(object.gid));
		lists.set(key, list);
		return list;
	};

	/** The user a reference names: a gid, an email, or `me`. */
	const user = (key: string): Json | undefined =>
		store.get("user", key === "me" ? ME : key) ??
		store.all("user").find((candidate) => candidate.email === key);

	/** The gid a filter value names, with users also by email or `me`. */
	const gidNamed = (value: string): string => gidOf(user(value)) ?? value;

	const lookup = (type: string, gid = ""): Json =>
		(type === "user" ? user(gid) : store.get(type, gid)) ?? refuse(notFound(type, gid));

	const valueOf = (object: Json, member: string): unknown =>
		Object.hasOwn(object, member) ? object[member] : derived(store, object, member);

	const names = (object: Json, member: string, gid: string): boolean => {
		const forms = [member, member.replace(/s$/u, ""), `${member}s`];
		const holds = (read: (form: string) => unknown): boolean =>
			forms.some((form) => gidsIn(read(form)).includes(gid));
		return (
			holds((form) => valueOf(object, form)) ||
			membershipsOf(object).some((membership) => holds((form) => membership[form]))
		);
	};

	const isChildOf = (object: Json, parent: Json): boolean => {
		const type = String(parent.resource_type);
		const members = [...RELATIONS, type, ...(type === "workspace" ? ["organization"] : [])];
		return members.some((member) => names(object, member, String(parent.gid)));
	};

	const workspaceOf = (object: Json | undefined, depth = 0): Ref | undefined => {
		if (object === undefined || depth > 6) {
			return undefined;
		}
		if (object.resource_type === "workspace") {
			return refTo(object);
		}
		const direct = [object.workspace, object.organization].find((value) => isRef(value));
		if (direct !== undefined) {
			return refTo(direct);
		}
		const owners = [
			object.team,
			object.project,
			object.parent,
			object.target,
			...membershipsOf(object).map((membership) => membership.project),
		].filter((owner) => isRef(owner));
		return owners
			.map((owner) => workspaceOf(store.get(owner.resource_type, owner.gid), depth + 1))
			.find((workspace) => workspace !== undefined);
	};

	/** The object a reference member names: users also by email or `me`, untyped members by gid alone. */
	const referenced = (member: string, gid: string): Json | undefined => {
		const type = REFERENCE_MEMBERS[member];
		if (type === "user") {
			return user(gid);
		}
		return type === undefined ? store.byGid(gid) : store.get(type, gid);
	};

	const named = (member: string, value: unknown): Ref | null => {
		if (value === null) {
			return null;
		}
		const gid = gidOf(value) ?? "";
		const object =
			referenced(member, gid) ?? refuse(error(400, `${member}: Not a recognized ID: ${gid}`));
		return refTo(object);
	};

	/** An object's custom field values with `values` (`{ <field gid>: <value> }`) written over them. */
	const customFieldValues = (current: unknown, values: unknown): Json[] => {
		const entries = Array.isArray(current) ? current.filter((entry) => isObject(entry)) : [];
		for (const [gid, value] of Object.entries(isObject(values) ? values : {})) {
			const field =
				store.get("custom_field", gid) ??
				refuse(error(400, `custom_fields: Not a recognized ID: ${gid}`));
			const entry = { ...refTo(field), ...fieldValue(store, field, value) };
			const at = entries.findIndex((existing) => existing.gid === gid);
			entries.splice(at === -1 ? entries.length : at, at === -1 ? 0 : 1, entry);
		}
		return entries;
	};

	const newGid = (): string => {
		lastGid += 1;
		return String(lastGid);
	};

	/** A request member as the store keeps it: references compact, custom field values resolved. */
	const stored = (object: Json, member: string, value: unknown): unknown => {
		if (member === "custom_fields") {
			return customFieldValues(object.custom_fields, value);
		}
		if (member === "enum_options" && Array.isArray(value)) {
			const options = value.map((option: unknown) =>
				store.put({
					gid: newGid(),
					resource_type: "enum_option",
					...TEMPLATES.enum_option?.(),
					...(isObject(option) ? option : { name: textOf(option) }),
				}),
			);
			return options.map((option) => refTo(option));
		}
		if (!Object.hasOwn(REFERENCE_MEMBERS, member)) {
			return value;
		}
		return Array.isArray(value)
			? value.map((item: unknown) => named(member, item))
			: named(member, value);
	};

	const write = (object: Json, data: Json): Json => {
		const writable = Object.entries(data).filter(
			([member]) =>
				!UNSTORED.has(member) && !(object.resource_type === "task" && TASK_PLACEMENT.has(member)),
		);
		for (const [member, value] of writable) {
			object[member] = stored(object, member, value);
		}
		if ("completed" in data) {
			object.completed_at = data.completed === true ? now() : null;
		}
		if ("modified_at" in object) {
			object.modified_at = now();
		}
		return object;
	};

	const fresh = (type: string, data: Json): Json => {
		const schema = schemaOfType(type);
		const at = now();
		const object: Json = {
			gid: newGid(),
			resource_type: type,
			...("created_at" in schema && { created_at: at }),
			...("modified_at" in schema && { modified_at: at }),
			...("created_by" in schema && { created_by: ref("user", ME) }),
			...("owner" in schema && { owner: ref("user", ME) }),
			...("requester" in schema && { requester: ref("user", ME) }),
			...TEMPLATES[type]?.(),
		};
		return write(object, data);
	};

	const settle = (object: Json): Json => {
		if ("workspace" in object && object.workspace === null) {
			object.workspace = workspaceOf(object) ?? null;
		}
		if ("workspace" in object && object.workspace === null) {
			refuse(error(400, "workspace: Missing input"));
		}
		return store.put(object);
	};

	const sectionsOf = (project: string): Json[] => {
		const sections = store.all("section").filter((section) => gidOf(section.project) === project);
		return ordered(listAt(`project:${project}`), sections);
	};

	const tasksOfSection = (section: string): Json[] => {
		const tasks = store
			.all("task")
			.filter((task) => membershipsOf(task).some((m) => gidOf(m.section) === section));
		return ordered(listAt(`section:${section}`), tasks);
	};

	const tasksOfProject = (project: string): Json[] => {
		const bySection = sectionsOf(project).flatMap((section) =>
			tasksOfSection(String(section.gid)).filter(
				(task) => sectionIn(task, project) === section.gid,
			),
		);
		const rest = store
			.all("task")
			.filter(
				(task) =>
					membershipsOf(task).some((m) => gidOf(m.project) === project) &&
					!bySection.includes(task),
			);
		return [...bySection, ...rest];
	};

	const subtasksOf = (parent: string): Json[] => {
		const subtasks = store.all("task").filter((task) => gidOf(task.parent) === parent);
		return ordered(listAt(`task:${parent}`), subtasks);
	};

	const moveToSection = (task: Json, section: Json, position: Position): void => {
		const project = gidOf(section.project) ?? "";
		const others = membershipsOf(task).filter((m) => gidOf(m.project) !== project);
		task.memberships = [...others, { project: ref("project", project), section: refTo(section) }];
		const key = `section:${String(section.gid)}`;
		const list = synced(key, tasksOfSection(String(section.gid)));
		place(list, String(task.gid), position);
	};

	const addToProject = (task: Json, project: Json, data: Json): void => {
		const gid = String(project.gid);
		const position = positionOf(data, "bottom");
		const sections = sectionsOf(gid);
		let section = typeof data.section === "string" ? lookup("section", data.section) : undefined;
		if (section === undefined && typeof position === "object") {
			const sibling = lookup("task", "before" in position ? position.before : position.after);
			section = store.get("section", sectionIn(sibling, gid) ?? "");
		}
		section ??= position === "top" ? sections[0] : sections.at(-1);
		if (section === undefined || gidOf(section.project) !== gid) {
			refuse(error(400, `section: not a section of project ${gid}`));
		}
		moveToSection(task, section, position);
	};

	const setParent = (task: Json, parent: Ref | null, position: Position): void => {
		const ancestors = (gid: string | undefined, depth = 0): string[] =>
			gid === undefined || depth > 10
				? []
				: [gid, ...ancestors(gidOf(store.get("task", gid)?.parent), depth + 1)];
		if (parent !== null && ancestors(parent.gid).includes(String(task.gid))) {
			refuse(error(400, "parent: a task cannot be its own ancestor"));
		}
		task.parent = parent;
		if (parent !== null) {
			const list = synced(`task:${parent.gid}`, subtasksOf(parent.gid));
			place(list, String(task.gid), position);
		}
	};

	const createTask = (data: Json): Json => {
		// `memberships` alone does not place a task (verified live, see the README).
		const placed = [data.workspace, data.projects, data.parent];
		if (placed.every((member) => member === undefined || member === null)) {
			refuse(error(400, "You should specify one of workspace, parent, projects"));
		}
		const task = fresh("task", data);
		const memberships = Array.isArray(data.memberships)
			? data.memberships.filter((m) => isObject(m))
			: [];
		const projects: unknown[] = Array.isArray(data.projects) ? data.projects : [];
		const placements = [
			...memberships.map((m) => ({ project: m.project, section: m.section })),
			...projects
				.filter((project) => !memberships.some((m) => gidOf(m.project) === gidOf(project)))
				.map((project) => ({ project, section: undefined })),
		];
		for (const placement of placements) {
			const project = String(named("project", placement.project)?.gid);
			const first = gidOf(sectionsOf(project)[0]);
			const section = lookup("section", gidOf(placement.section) ?? first);
			if (gidOf(section.project) !== project) {
				refuse(error(400, `memberships: section ${String(section.gid)} is not in ${project}`));
			}
			moveToSection(task, section, "bottom");
		}
		if (data.parent !== undefined && data.parent !== null) {
			setParent(task, named("parent", data.parent), "bottom");
		}
		return settle(task);
	};

	/** Whether `object` passes one list or search filter: `projects.any`, `completed`, `due_on.before`, `text`, … */
	const passes = (object: Json, key: string, value: string): boolean => {
		const [member = key, operator] = key.split(".");
		const gids = commaList(value).map((gid) => gidNamed(gid));
		const own = valueOf(object, member);
		if (operator === "any" || operator === "not" || operator === "all") {
			const hits = gids.filter((gid) => names(object, member, gid)).length;
			const wanted = { any: hits > 0, not: hits === 0, all: hits === gids.length };
			return wanted[operator];
		}
		if (operator === "before" || operator === "after") {
			return typeof own === "string" && (operator === "before" ? own < value : own > value);
		}
		switch (key) {
			case "text": {
				const texts = [textOf(object.name), textOf(object.notes)];
				return texts.some((text) => text.toLowerCase().includes(value.toLowerCase()));
			}
			case "is_subtask": {
				return (gidOf(object.parent) !== undefined) === (value === "true");
			}
			case "completed_since": {
				return (
					object.completed !== true || (value !== "now" && textOf(object.completed_at) >= value)
				);
			}
			default: {
				break;
			}
		}
		if (value === "true" || value === "false") {
			return (own ?? false) === (value === "true");
		}
		return typeof own === "string" ? own === value : names(object, member, gidNamed(value));
	};

	const filtered = (objects: readonly Json[], query: URLSearchParams): Json[] => {
		const filters = [...query].filter(([key]) => !NOT_FILTERS.has(key));
		return objects.filter((object) => filters.every(([key, value]) => passes(object, key, value)));
	};

	/**
	 * Shows a value: without a selection all of it, a reference compact; with
	 * one the `gid` (Asana always includes it) and the members selected, a
	 * reference with no members selected compact and a nested object `{}`.
	 */
	const render = (value: unknown, selection?: Selection): unknown => {
		if (Array.isArray(value)) {
			return value.map((item: unknown) => render(item, selection));
		}
		if (!isObject(value)) {
			return value;
		}
		const live = isRef(value) ? store.get(value.resource_type, value.gid) : undefined;
		// A reference shows the live object, with what it carries itself (a custom field's value).
		const object = live === undefined ? value : { ...live, ...value };
		// Asana shows only the members its schema names, and ignores other selections.
		const schema = isRef(value) ? schemaOfType(value.resource_type) : {};
		const known = (member: string): boolean =>
			Object.keys(schema).length === 0 || Object.hasOwn(schema, member);
		if (isRef(value) && selection === undefined) {
			const name = typeof object.name === "string" ? { name: object.name } : {};
			return { ...refTo(object), ...name };
		}
		// A reference selected alone is answered `{ gid, resource_type }` (observed live).
		if (isRef(value) && selection?.size === 0) {
			return refTo(object);
		}
		if (selection === undefined) {
			const members = Object.entries(object).filter(([member]) => known(member));
			return Object.fromEntries(members.map(([member, item]) => [member, render(item)]));
		}
		const shown: Json = typeof object.gid === "string" ? { gid: object.gid } : {};
		for (const [member, nested] of selection) {
			const item = known(member) ? valueOf(object, member) : undefined;
			if (item !== undefined) {
				shown[member] = render(item, nested);
			}
		}
		return shown;
	};

	const show = (object: Json, selection: Selection | undefined): Json => {
		const all = new Map(Object.keys(object).map((member) => [member, undefined]));
		return render(object, selection ?? all) as Json;
	};

	return {
		store,
		lists,
		newGid,
		listAt,
		synced,
		lookup,
		named,
		write,
		fresh,
		settle,
		names,
		isChildOf,
		valueOf,
		filtered,
		workspaceOf,
		show,
		sectionsOf,
		tasksOfSection,
		tasksOfProject,
		subtasksOf,
		moveToSection,
		addToProject,
		setParent,
		createTask,
	};
}

/** The objects a reference list holds, as stored. */
const objectsIn = (world: World, value: unknown): Json[] =>
	gidsIn(value)
		.map((gid) => world.store.byGid(gid))
		.filter((object) => object !== undefined);

/** The object a required request member names. */
const bodyObject = (world: World, data: Json, member: string): Json => {
	const named = world.named(member, required(data, member));
	return world.lookup(named?.resource_type ?? member, named?.gid);
};

/** `GET` / `PUT` / `DELETE /<objects>/{gid}`. */
function objectRoute(world: World, spec: OperationSpec, param: string): Handler | undefined {
	const type = typeOfParam(param);
	if (type === undefined) {
		return undefined;
	}
	switch (spec.method) {
		case "GET": {
			return ({ params }) => ({ one: world.lookup(type, params[param]) });
		}
		case "PUT": {
			return ({ params, data }) => ({ one: world.write(world.lookup(type, params[param]), data) });
		}
		case "DELETE": {
			return ({ params }) => {
				world.store.delete(type, String(world.lookup(type, params[param]).gid));
				return { one: {} };
			};
		}
		default: {
			return undefined;
		}
	}
}

/** `POST /<parent>/{gid}/<objects>`: an object created in its parent's list of them, or naming its parent. */
function createUnderRoute(world: World, { param, segment, type = "" }: Nested): Handler {
	const parentType = typeOfParam(param) ?? "";
	const schema = schemaOfType(type);
	const candidates = [
		...RELATIONS,
		parentType,
		...(parentType === "workspace" ? ["organization"] : []),
	];
	const relation = candidates.find((candidate) => candidate in schema) ?? parentType;
	return ({ params, data }) => {
		const parent = world.lookup(parentType, params[param]);
		const object = world.fresh(type, data);
		if (!Array.isArray(parent[segment])) {
			object[relation] = refTo(parent);
			return { one: world.settle(object), status: 201 };
		}
		const list = gidsIn(parent[segment]);
		place(list, String(object.gid), positionOf(data, "bottom"));
		world.store.put(object);
		parent[segment] = objectsIn(world, list).map((sibling) => refTo(sibling));
		return { one: object, status: 201 };
	};
}

/** `GET /<parent>/{gid}/<objects>`: the parent's own list of them, or the objects naming the parent. */
function listUnderRoute(world: World, { param, segment, type }: Nested): Handler {
	const parentType = typeOfParam(param) ?? "";
	return ({ params, query }) => {
		const parent = world.lookup(parentType, params[param]);
		const own = world.valueOf(parent, segment);
		if (Array.isArray(own)) {
			return { many: objectsIn(world, own) };
		}
		const children = type === undefined ? [] : world.store.all(type);
		const under = children.filter((child) => world.isChildOf(child, parent));
		const order = world.listAt(`${segment}:${String(parent.gid)}`);
		return { many: world.filtered(ordered(order, under), query) };
	};
}

/** `POST /<objects>/{gid}/add<Member>` / `remove<Member>`: followers, members, dependencies, tags. */
function listActionRoute(world: World, spec: OperationSpec, { param, segment }: Nested): Handler {
	const type = typeOfParam(param) ?? "";
	const adding = segment.startsWith("add");
	const [given = ""] = spec.bodyParams;
	return ({ params, data }) => {
		const object = world.lookup(type, params[param]);
		const member = Array.isArray(object[given]) ? given : `${given}s`;
		const current = gidsIn(object[member]);
		const changed = gidsIn(data[given]).map((gid) => world.named(given, gid)?.gid ?? gid);
		const next = adding
			? [...current, ...changed.filter((gid) => !current.includes(gid))]
			: current.filter((gid) => !changed.includes(gid));
		object[member] = next.map((gid) => world.named(given, gid));
		return { one: object };
	};
}

/** `addCustomFieldSetting` / `removeCustomFieldSetting`: a custom field put on (or taken off) a project, portfolio, goal or table. */
function settingRoute(world: World, parentType: string, adding: boolean): Handler {
	return ({ params, data }) => {
		const parent = world.lookup(parentType, params[`${parentType}_gid`]);
		const field = refTo(bodyObject(world, data, "custom_field"));
		const settings = world.store
			.all("custom_field_setting")
			.filter((setting) => gidOf(setting.parent) === parent.gid);
		const existing = settings.find((setting) => gidOf(setting.custom_field) === field.gid);
		// The parent's custom field values, when its objects carry them, without this field's.
		const current: unknown = parent.custom_fields;
		const values: unknown[] | undefined = Array.isArray(current)
			? current.filter((value: unknown) => gidOf(value) !== field.gid)
			: undefined;
		if (!adding) {
			world.store.delete("custom_field_setting", String(existing?.gid));
			if (values !== undefined) {
				parent.custom_fields = values;
			}
			return { one: {} };
		}
		const setting = existing ?? {
			gid: world.newGid(),
			resource_type: "custom_field_setting",
			custom_field: field,
			parent: refTo(parent),
			...(parentType === "project" && { project: refTo(parent) }),
			is_important: data.is_important === true,
		};
		const order = world.synced(`custom_field_settings:${String(parent.gid)}`, settings);
		place(order, String(setting.gid), positionOf(data, "bottom"));
		if (values !== undefined) {
			parent.custom_fields = [...values, field];
		}
		return { one: world.store.put(setting) };
	};
}

/** The route of `/<objects>`: a create, or a list filtered by the query. */
function topLevelRoute(world: World, spec: OperationSpec): Handler | undefined {
	const [segment = ""] = segmentsOf(spec);
	const type = TYPES.get(segment);
	if (type === undefined) {
		return undefined;
	}
	if (spec.method === "POST") {
		return ({ data }) => ({ one: world.settle(world.fresh(type, data)), status: 201 });
	}
	return spec.method === "GET"
		? ({ query }) => ({ many: world.filtered(world.store.all(type), query) })
		: undefined;
}

/** The route of `/<parent>/{gid}/<segment>`: a create, a list, or a change of a list member. */
function nestedRoute(world: World, spec: OperationSpec, nested: Nested): Handler | undefined {
	const isList = spec.queryParams.includes("limit") || spec.queryParams.includes("offset");
	if (spec.method === "POST" && TYPES.has(nested.segment)) {
		return createUnderRoute(world, nested);
	}
	if (spec.method === "GET" && isList) {
		return listUnderRoute(world, nested);
	}
	return spec.method === "POST" && LIST_ACTIONS.test(nested.segment)
		? listActionRoute(world, spec, nested)
		: undefined;
}

/** The route an operation's shape implies, if it has one. */
function shapeRoute(world: World, id: OperationId): Handler | undefined {
	const spec: OperationSpec = OPERATIONS[id];
	const segments = segmentsOf(spec);
	const lastParam = paramOf(segments.at(-1));
	if (lastParam !== undefined) {
		return objectRoute(world, spec, lastParam);
	}
	if (segments.length === 1) {
		return topLevelRoute(world, spec);
	}
	const [, second, segment] = segments;
	const param = paramOf(second);
	// The objects under a parent are named by the segment (`stories`), else by the response schema (`subtasks`).
	const type =
		segment === undefined ? undefined : (TYPES.get(segment) ?? typeOfSchema(RESPONSES[id]));
	return segments.length === 3 && param !== undefined && segment !== undefined
		? nestedRoute(world, spec, { param, segment, type })
		: undefined;
}

const taskRef = (gid: string, name?: string): Json => ({
	...ref("task", gid),
	...(name !== undefined && { name }),
});

/** The events handshake: a 412 with a fresh sync token, then the changes since. */
function eventsRoute({ query }: Incoming): Answer {
	if (query.get("sync") === null) {
		return error(412, "Sync token invalid or too old.", { sync: "token-1" });
	}
	const events: Json[] = [
		{ resource: taskRef("101"), action: "changed" },
		{ resource: taskRef("102"), action: "changed" },
	];
	if (query.get("sync") === "token-more") {
		// A deleted task of a visible project, and a change naming a task of project 23.
		events.push(
			{ resource: taskRef("199"), parent: ref("project", "21"), action: "deleted" },
			{
				resource: taskRef("101"),
				action: "changed",
				change: { field: "dependencies", action: "added", added_value: taskRef("102", "T2") },
			},
		);
	}
	return { many: events, paged: false, extra: { sync: "token-2", has_more: false } };
}

/** `GET /workspaces/{gid}/<objects>/search`: the workspace's objects the filters keep, up to `limit` (no pages). */
function search(world: World, type: string, { params, query }: Incoming): Answer {
	const workspace = String(world.lookup("workspace", params.workspace_gid).gid);
	const inWorkspace = world.store
		.all(type)
		.filter((object) => world.workspaceOf(object)?.gid === workspace);
	const found = world.filtered(inWorkspace, query);
	return { many: found.slice(0, Number(query.get("limit") ?? "100")), paged: false };
}

/** `GET /workspaces/{gid}/typeahead`: the workspace's objects of a type with a word starting with the query. */
function typeahead(world: World, { params, query }: Incoming): Answer {
	const workspace = String(world.lookup("workspace", params.workspace_gid).gid);
	const type = query.get("resource_type") ?? query.get("type") ?? "user";
	const text = (query.get("query") ?? "").toLowerCase();
	const found = world.store
		.all(type)
		.filter(
			(object) =>
				world.workspaceOf(object)?.gid === workspace || world.names(object, "workspace", workspace),
		)
		.filter((object) =>
			textOf(object.name)
				.toLowerCase()
				.split(/\s+/u)
				.some((word) => word.startsWith(text)),
		);
	return { many: found.slice(0, Number(query.get("count") ?? "20")), paged: false };
}

/** The task, section, project and dependency routes. */
function taskHandlers(world: World): Partial<Record<OperationId, Handler>> {
	const task = (params: Incoming["params"]): Json => world.lookup("task", params.task_gid);
	const gidIn = (type: string, gid: string | undefined): string =>
		String(world.lookup(type, gid).gid);
	return {
		createTask: ({ data }) => ({ one: world.createTask(data), status: 201 }),
		updateTask: ({ params, data }) => {
			// A task's parent changes only through setParent (verified live, see the README).
			if ("parent" in data) {
				refuse(error(400, "parent: cannot be changed with PUT /tasks/{task_gid}; use setParent"));
			}
			return { one: world.write(task(params), data) };
		},
		createSubtaskForTask: ({ params, data }) => ({
			one: world.createTask({ ...data, parent: task(params).gid }),
			status: 201,
		}),
		getTasks: ({ query }) => {
			const project = query.get("project");
			const tasks =
				project === null
					? world.store.all("task")
					: world.tasksOfProject(gidIn("project", project));
			return { many: world.filtered(tasks, query) };
		},
		getTasksForProject: ({ params, query }) => {
			const tasks = world.tasksOfProject(gidIn("project", params.project_gid));
			return { many: world.filtered(tasks, query) };
		},
		getTasksForSection: ({ params, query }) => {
			const tasks = world.tasksOfSection(gidIn("section", params.section_gid));
			return { many: world.filtered(tasks, query) };
		},
		getSubtasksForTask: ({ params }) => ({ many: world.subtasksOf(String(task(params).gid)) }),
		addProjectForTask: ({ params, data }) => {
			const moved = task(params);
			world.addToProject(moved, bodyObject(world, data, "project"), data);
			return { one: moved };
		},
		removeProjectForTask: ({ params, data }) => {
			const moved = task(params);
			const project = String(bodyObject(world, data, "project").gid);
			moved.memberships = membershipsOf(moved).filter((m) => gidOf(m.project) !== project);
			return { one: moved };
		},
		addTaskForSection: ({ params, data }) => {
			const section = world.lookup("section", params.section_gid);
			world.moveToSection(bodyObject(world, data, "task"), section, positionOf(data, "top"));
			return { one: section };
		},
		setParentForTask: ({ params, data }) => {
			const moved = task(params);
			if (!("parent" in data)) {
				refuse(error(400, "parent: Missing input"));
			}
			const parent = data.parent === null ? null : refTo(bodyObject(world, data, "parent"));
			world.setParent(moved, parent, positionOf(data, "bottom"));
			return { one: moved };
		},
		addDependentsForTask: ({ params, data }) => {
			const blocker = refTo(task(params));
			for (const dependent of objectsIn(world, data.dependents)) {
				const others = gidsIn(dependent.dependencies).filter((gid) => gid !== blocker.gid);
				dependent.dependencies = [...others.map((gid) => ref("task", gid)), blocker];
			}
			return { one: task(params) };
		},
		removeDependentsForTask: ({ params, data }) => {
			const blocker = String(task(params).gid);
			for (const dependent of objectsIn(world, data.dependents)) {
				const others = gidsIn(dependent.dependencies).filter((gid) => gid !== blocker);
				dependent.dependencies = others.map((gid) => ref("task", gid));
			}
			return { one: task(params) };
		},
		getTaskForCustomID: ({ params }) => {
			const found = world.store.all("task").find((t) => t.custom_id === params.custom_id);
			return { one: found ?? refuse(notFound("task", params.custom_id ?? "")) };
		},
		getTaskCountsForProject: ({ params }) => {
			const tasks = world.tasksOfProject(gidIn("project", params.project_gid));
			const completed = tasks.filter((t) => t.completed === true).length;
			const counts = {
				num_tasks: tasks.length,
				num_completed_tasks: completed,
				num_incomplete_tasks: tasks.length - completed,
				num_milestones: 0,
				num_completed_milestones: 0,
				num_incomplete_milestones: 0,
			};
			return { one: counts };
		},
		getSectionsForProject: ({ params }) => ({
			many: world.sectionsOf(gidIn("project", params.project_gid)),
		}),
		createSectionForProject: ({ params, data }) => {
			const project = gidIn("project", params.project_gid);
			const section = world.fresh("section", { ...data, project });
			const order = world.synced(`project:${project}`, world.sectionsOf(project));
			place(order, String(section.gid), positionOf(data, "bottom"));
			return { one: world.store.put(section), status: 201 };
		},
		updateSection: ({ params, data }) => {
			const section = world.write(world.lookup("section", params.section_gid), data);
			const project = gidOf(section.project) ?? "";
			if ("insert_before" in data || "insert_after" in data) {
				const order = world.synced(`project:${project}`, world.sectionsOf(project));
				place(order, String(section.gid), positionOf(data, "bottom"));
			}
			return { one: section };
		},
		insertSectionForProject: ({ params, data }) => {
			const project = gidIn("project", params.project_gid);
			const section = bodyObject(world, data, "section");
			const sibling = { insert_before: data.before_section, insert_after: data.after_section };
			const order = world.synced(`project:${project}`, world.sectionsOf(project));
			place(order, String(section.gid), positionOf(sibling, "bottom"));
			return { one: section };
		},
	};
}

/** The portfolio item, team member, search, typeahead and events routes. */
function otherHandlers(world: World): Partial<Record<OperationId, Handler>> {
	const { store } = world;
	const items = (params: Incoming["params"]): string[] =>
		world.listAt(`portfolio:${String(world.lookup("portfolio", params.portfolio_gid).gid)}`);
	const membershipsOfTeam = (params: Incoming["params"]): Json[] => {
		const team = String(world.lookup("team", params.team_gid).gid);
		return store.all("team_membership").filter((m) => gidOf(m.team) === team);
	};
	const decide =
		(status: string): Handler =>
		({ params }) => {
			const request = world.lookup("access_request", params.access_request_gid);
			request.approval_status = status;
			return { one: request };
		};
	return {
		getEvents: eventsRoute,
		getWorkspaceEvents: (request) => {
			world.lookup("workspace", request.params.workspace_gid);
			return eventsRoute(request);
		},
		approveAccessRequest: decide("approved"),
		addCustomFieldSettingForProject: settingRoute(world, "project", true),
		removeCustomFieldSettingForProject: settingRoute(world, "project", false),
		addCustomFieldSettingForPortfolio: settingRoute(world, "portfolio", true),
		removeCustomFieldSettingForPortfolio: settingRoute(world, "portfolio", false),
		addCustomFieldSettingForGoal: settingRoute(world, "goal", true),
		removeCustomFieldSettingForGoal: settingRoute(world, "goal", false),
		addCustomFieldSettingForTable: settingRoute(world, "table", true),
		removeCustomFieldSettingForTable: settingRoute(world, "table", false),
		getCustomFieldSettingsForTeam: listUnderRoute(world, {
			param: "team_gid",
			segment: "custom_field_settings",
			type: "custom_field_setting",
		}),
		addUserForWorkspace: ({ params, data }) => {
			const workspace = refTo(world.lookup("workspace", params.workspace_gid));
			const user = bodyObject(world, data, "user");
			const others = gidsIn(user.workspaces).filter((gid) => gid !== workspace.gid);
			user.workspaces = [...others.map((gid) => ref("workspace", gid)), workspace];
			return { one: user };
		},
		removeUserForWorkspace: ({ params, data }) => {
			const workspace = String(world.lookup("workspace", params.workspace_gid).gid);
			const user = bodyObject(world, data, "user");
			const others = gidsIn(user.workspaces).filter((gid) => gid !== workspace);
			user.workspaces = others.map((gid) => ref("workspace", gid));
			return { one: {} };
		},
		rejectAccessRequest: decide("rejected"),
		insertEnumOptionForCustomField: ({ params, data }) => {
			const field = world.lookup("custom_field", params.custom_field_gid);
			const option = bodyObject(world, data, "enum_option");
			const sibling = {
				insert_before: data.before_enum_option,
				insert_after: data.after_enum_option,
			};
			const list = gidsIn(field.enum_options);
			place(list, String(option.gid), positionOf(sibling, "bottom"));
			field.enum_options = objectsIn(world, list).map((choice) => refTo(choice));
			return { one: option };
		},
		searchTasksForWorkspace: (request) => search(world, "task", request),
		searchProjectsForWorkspace: (request) => search(world, "project", request),
		typeaheadForWorkspace: (request) => typeahead(world, request),
		getItemsForPortfolio: ({ params }) => ({ many: objectsIn(world, items(params)) }),
		// The user's favorites of the type the query names (Asana requires one).
		getFavoritesForUser: ({ params, query }) => {
			const owner = String(world.lookup("user", params.user_gid).gid);
			const type = query.get("resource_type");
			const favorites = objectsIn(world, world.listAt(`favorites:${owner}`));
			return { many: favorites.filter((object) => object.resource_type === type) };
		},
		addItemForPortfolio: ({ params, data }) => {
			const item = bodyObject(world, data, "item");
			if (item.resource_type !== "project" && item.resource_type !== "portfolio") {
				refuse(error(400, "item: must be a project or a portfolio"));
			}
			place(items(params), String(item.gid), positionOf(data, "bottom"));
			return { one: item };
		},
		removeItemForPortfolio: ({ params, data }) => {
			const list = items(params);
			const at = list.indexOf(String(bodyObject(world, data, "item").gid));
			list.splice(at, at === -1 ? 0 : 1);
			return { one: {} };
		},
		addUserForTeam: ({ params, data }) => {
			const user = String(bodyObject(world, data, "user").gid);
			const existing = membershipsOfTeam(params).find((m) => gidOf(m.user) === user);
			const membership = existing ?? {
				gid: world.newGid(),
				resource_type: "team_membership",
				team: refTo(world.lookup("team", params.team_gid)),
				user: ref("user", user),
				is_admin: false,
				is_guest: false,
				is_limited_access: false,
			};
			return { one: store.put(membership) };
		},
		removeUserForTeam: ({ params, data }) => {
			const user = String(bodyObject(world, data, "user").gid);
			const leaving = membershipsOfTeam(params).filter((m) => gidOf(m.user) === user);
			for (const membership of leaving) {
				store.delete("team_membership", String(membership.gid));
			}
			return { one: {} };
		},
		getUsersForTeam: ({ params }) => ({
			many: objectsIn(
				world,
				membershipsOfTeam(params).map((m) => m.user),
			),
		}),
		getTeamsForUser: ({ params, query }) => {
			const user = String(world.lookup("user", params.user_gid).gid);
			const memberships = store.all("team_membership").filter((m) => gidOf(m.user) === user);
			const teams = objectsIn(
				world,
				memberships.map((m) => m.team),
			);
			return { many: world.filtered(teams, query) };
		},
	};
}

/** The `POST /batch` actions, each served like a request of its own. */
function batch(data: Json, serve: (sent: Sent) => Reply): Reply {
	const actions = Array.isArray(data.actions)
		? data.actions.filter((action) => isObject(action))
		: [];
	const results = actions.map((action) => {
		const method = (typeof action.method === "string" ? action.method : "get").toUpperCase();
		const url = new URL(`${BASE_URL}${textOf(action.relative_path)}`);
		const given = isObject(action.data) ? action.data : {};
		const options = isObject(action.options) ? action.options : {};
		// GET and DELETE actions carry their query in `data`; `options` carries fields and paging.
		const reads = method === "GET" || method === "DELETE";
		const query = { ...(reads ? given : {}), limit: options.limit, offset: options.offset };
		for (const [key, value] of Object.entries(query)) {
			if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
				url.searchParams.set(key, String(value));
			}
		}
		const fields = Array.isArray(options.fields) ? options.fields.map(String) : [];
		const result = serve({ method, url, data: reads ? {} : given, fields });
		return { status_code: result.status, headers: {}, body: result.body };
	});
	return ok({ data: results });
}

/** Projects what a route found through `opt_fields`, or through the operation's response schema. */
function respond(
	world: World,
	outcome: { id: OperationId; answer: Answer; fields: readonly string[]; url: URL },
): Reply {
	const { answer } = outcome;
	if (isReply(answer)) {
		return answer;
	}
	const schema = RESPONSES[outcome.id];
	const status = "one" in answer ? (answer.status ?? 200) : 200;
	if (schema === "EmptyResponse") {
		return { status, body: { data: {} } };
	}
	const selection =
		outcome.fields.length > 0 ? selectionOf(outcome.fields) : schemaSelection(schema);
	if ("many" in answer) {
		const shown = answer.many.map(
			(object) => asNamed(world.show(object, selection), schema) as Json,
		);
		return ok({
			...(answer.paged === false ? { data: shown } : page(shown, outcome.url)),
			...answer.extra,
		});
	}
	return { status, body: { data: asNamed(world.show(answer.one, selection), schema) } };
}

const userSeed = (gid: string, name: string, email: string): Json => ({
	gid,
	resource_type: "user",
	name,
	email,
	workspaces: [ref("workspace", "1")],
});

const teamSeed = (gid: string, name: string): Json => ({
	gid,
	resource_type: "team",
	name,
	description: "",
	organization: ref("workspace", "1"),
});

const teamMemberSeed = (gid: string, team: string, user: string): Json => ({
	gid,
	resource_type: "team_membership",
	team: ref("team", team),
	user: ref("user", user),
	is_admin: false,
	is_guest: false,
	is_limited_access: false,
});

const projectSeed = (gid: string, name: string, team: string): Json => ({
	gid,
	resource_type: "project",
	...TEMPLATES.project?.(),
	name,
	created_at: SEEDED_AT,
	modified_at: SEEDED_AT,
	owner: ref("user", ME),
	team: ref("team", team),
	workspace: ref("workspace", "1"),
});

const sectionSeed = (gid: string, name: string, project: string): Json => ({
	gid,
	resource_type: "section",
	name,
	created_at: SEEDED_AT,
	project: ref("project", project),
});

const tagSeed = (gid: string, name: string): Json => ({
	gid,
	resource_type: "tag",
	...TEMPLATES.tag?.(),
	name,
	created_at: SEEDED_AT,
	workspace: ref("workspace", "1"),
});

const membership = (project: string, section: string): Json => ({
	project: ref("project", project),
	section: ref("section", section),
});

const taskSeed = (gid: string, name: string, extra: Json = {}): Json => ({
	gid,
	resource_type: "task",
	...TEMPLATES.task?.(),
	name,
	created_at: SEEDED_AT,
	modified_at: SEEDED_AT,
	created_by: ref("user", ME),
	workspace: ref("workspace", "1"),
	followers: [],
	...extra,
});

/** The objects every fake starts with (see the module comment), and their order. */
function seed(world: World): void {
	const objects: Json[] = [
		{ gid: "1", resource_type: "workspace", name: "Acme", is_organization: true },
		{ gid: "2", resource_type: "workspace", name: "Other", is_organization: false },
		userSeed("51", "Me", "me@acme.test"),
		userSeed("52", "Bob", "bob@acme.test"),
		teamSeed("11", "Platform"),
		teamSeed("12", "Design"),
		teamMemberSeed("151", "11", "51"),
		teamMemberSeed("152", "12", "51"),
		teamMemberSeed("153", "11", "52"),
		projectSeed("21", "Backend", "11"),
		projectSeed("22", "Design System", "11"),
		projectSeed("23", "Secret", "12"),
		sectionSeed("31", "Backlog", "21"),
		sectionSeed("32", "Done", "21"),
		sectionSeed("33", "Inbox", "22"),
		sectionSeed("34", "Vault", "23"),
		tagSeed("41", "ai-ok"),
		tagSeed("42", "frozen"),
		{ gid: "71", resource_type: "enum_option", name: "AI", enabled: true, color: "green" },
		{ gid: "72", resource_type: "enum_option", name: "Human", enabled: true, color: "blue" },
		{
			gid: "61",
			resource_type: "custom_field",
			...TEMPLATES.custom_field?.(),
			resource_subtype: "enum",
			name: "Owner",
			enum_options: [ref("enum_option", "71"), ref("enum_option", "72")],
			workspace: ref("workspace", "1"),
		},
		{
			gid: "81",
			resource_type: "portfolio",
			...TEMPLATES.portfolio?.(),
			name: "Roadmap",
			created_at: SEEDED_AT,
			owner: ref("user", ME),
			workspace: ref("workspace", "1"),
		},
		taskSeed("101", "T1", { memberships: [membership("21", "31")] }),
		taskSeed("102", "T2 secret", { memberships: [membership("23", "34")] }),
		taskSeed("103", "T3 multi", { memberships: [membership("21", "31"), membership("23", "34")] }),
		taskSeed("104", "S1 subtask", { parent: ref("task", "101") }),
		taskSeed("105", "T5 done", {
			completed: true,
			completed_at: SEEDED_AT,
			memberships: [membership("21", "32")],
		}),
		taskSeed("106", "U1 unhomed"),
		taskSeed("107", "T7 design", {
			memberships: [membership("22", "33")],
			tags: [ref("tag", "41")],
			assignee: ref("user", ME),
			created_by: ref("user", "52"),
		}),
		{
			gid: "91",
			resource_type: "status_update",
			...TEMPLATES.status_update?.(),
			title: "On track",
			status_type: "on_track",
			created_at: SEEDED_AT,
			parent: ref("project", "21"),
		},
		{
			gid: "501",
			resource_type: "story",
			...TEMPLATES.story?.(),
			text: "hello",
			created_at: SEEDED_AT,
			created_by: ref("user", ME),
			target: ref("task", "101"),
		},
	];
	for (const object of objects) {
		world.store.put(object);
	}
	// Section 31 lists 103 above 101, so a page of project 21 can start with a hidden task.
	world.lists.set("section:31", ["103", "101"]);
	world.lists.set("portfolio:81", ["22"]);
	world.lists.set(`favorites:${ME}`, ["21", "23", "101", "102", "107"]);
}

/** Options of {@link createFakeAsana}. */
interface FakeOptions {
	/** `opt_fields` the fake ignores, as Asana would one it does not honor on that path. */
	readonly unhonoured?: (path: string, field: string) => boolean;
}

/** Builds a fresh world and a `fetch` that serves it. */
function createFakeAsana(options: FakeOptions = {}): {
	/** A `fetch` that records each request in `calls` and serves it. */
	fetch: typeof globalThis.fetch;
	calls: Call[];
	store: ObjectStore;
	/** Serves a request without recording it: how a test changes Asana behind the gate's back. */
	api: (method: string, path: string, data?: Json) => Reply;
	/** The operations the fake serves; any other answers 501. */
	served: ReadonlySet<OperationId>;
} {
	const world = createWorld();
	seed(world);
	const calls: Call[] = [];
	const routes = new Map<OperationId, Handler>();

	const serve = (sent: Sent): Reply => {
		const match = isHttpMethod(sent.method)
			? matchRoute(sent.method, sent.url.pathname)
			: undefined;
		if (match === undefined) {
			return error(404, "No matching route for request");
		}
		const handler = routes.get(match.operationId);
		if (handler === undefined) {
			return error(501, `The fake Asana does not serve ${match.operationId}`);
		}
		const path = sent.url.pathname.replace(/^\/api\/1\.0/u, "");
		const fields = [
			...commaList(sent.url.searchParams.get("opt_fields")),
			...(sent.fields ?? []),
		].filter((field) => options.unhonoured?.(path, field) !== true);
		try {
			const answer = handler({
				params: match.params,
				query: sent.url.searchParams,
				data: sent.data,
			});
			return respond(world, { id: match.operationId, answer, fields, url: sent.url });
		} catch (error_) {
			if (error_ instanceof RefusalError) {
				return error_.reply;
			}
			throw error_;
		}
	};

	const special: Partial<Record<OperationId, Handler>> = {
		...taskHandlers(world),
		...otherHandlers(world),
		createBatchRequest: ({ data }) => batch(data, serve),
	};
	for (const id of Object.keys(OPERATIONS) as OperationId[]) {
		const handler = special[id] ?? shapeRoute(world, id);
		if (handler !== undefined) {
			routes.set(id, handler);
		}
	}

	const fetchImpl: typeof globalThis.fetch = (input, init) => {
		const url = new URL(urlOf(input));
		const method = init?.method ?? "GET";
		const form = init?.body instanceof FormData ? formOf(init.body) : undefined;
		const { data, fields } = form === undefined ? envelopeOf(init) : { data: form, fields: [] };
		calls.push({ method, url, body: data, ...(form && { form }) });
		const result = serve({ method, url, data, fields });
		return Promise.resolve(Response.json(result.body, { status: result.status }));
	};
	return {
		fetch: fetchImpl,
		calls,
		store: world.store,
		api: (method, path, data = {}) => serve({ method, url: new URL(`${BASE_URL}${path}`), data }),
		served: new Set(routes.keys()),
	};
}

export { createFakeAsana };
export type { Call, FakeOptions, ObjectStore, Reply };
