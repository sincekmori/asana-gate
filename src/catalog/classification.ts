// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { BATCH_LIMIT } from "../asana/client.ts";
import { splitList } from "../asana/query.ts";
import { badRequest, inAction, noRoute, notFound } from "../gate/errors.ts";
import { type Membership, membershipsOf, PARENT_TYPES, taskState } from "../gate/facts.ts";
import { gidsOf, isObject, type Ref, refOf, resourceOfType, stringOf } from "../gate/objects.ts";
import {
	type Check,
	dataOf,
	type Plan,
	type PlanContext,
	type ResponsePlan,
	type Target,
} from "../gate/plan.ts";
import { isHttpMethod, matchRoute } from "../gate/router.ts";
import { augmentOptFields, requestedFields } from "../gate/selection.ts";
import { textsOf } from "../policy/constraints.ts";
import { type Facts, isVisible, type ObjectState, WORKSPACE_BRANCH } from "../policy/evaluate.ts";
import { isGid } from "../policy/schema.ts";
import { type ObjectOperationId, objectOperationOf } from "./object-operations.ts";
import type { OperationSpec } from "./operation-spec.ts";
import { type OperationId, OPERATIONS } from "./operations.gen.ts";
import { type Action, actionOf, FIELD_VERBS, type Resource, type Verb } from "./resources.ts";

/** How an operation's scope is found, for documentation. */
type ScopeKind = "path" | "body" | "query" | "workspace" | "filter" | "batch";

/** A planning function for one operation. */
type Planner = (ctx: PlanContext) => Promise<Plan>;

/** The classification of one operation: its action and how it is scoped. */
interface OperationRule {
	/** The resource the operation acts on (absent for the Batch API, which has none of its own). */
	readonly resource?: Resource;
	readonly verb?: Verb;
	/** `<resource>:<verb>`, when the operation has one action of its own. */
	readonly action?: Action;
	readonly scope: ScopeKind;
	readonly plan: Planner;
}

/** The static part of a rule. */
interface RuleSpec {
	readonly resource?: Resource;
	readonly verb?: Verb;
	readonly scope: ScopeKind;
}

const RAW: ResponsePlan = { kind: "raw" };

type ResponseKind = "item" | "raw" | "list";

function responseOf(kind: ResponseKind | undefined, type: Resource, facts?: Facts): ResponsePlan {
	switch (kind) {
		case "raw": {
			return RAW;
		}
		case "list": {
			return { kind: "list", type, ...(facts && { facts }) };
		}
		default: {
			return { kind: "item", type, ...(facts && { facts }) };
		}
	}
}

function make(spec: RuleSpec, plan: Planner): OperationRule {
	const action =
		spec.resource === undefined || spec.verb === undefined
			? undefined
			: actionOf(spec.resource, spec.verb);
	return { ...spec, ...(action !== undefined && { action }), plan };
}

function sharedFacts(shared: boolean | undefined, target: Target): Facts | undefined {
	if (shared === true) {
		return target.facts;
	}
	return undefined;
}

/** Awaits two independent lookups together; when either fails, the first's refusal comes first. */
async function both<A, B>(first: Promise<A>, second: Promise<B>): Promise<[A, B]> {
	const settled = await Promise.allSettled([first, second]);
	if (settled.some((result) => result.status === "rejected")) {
		await first;
		await second;
	}
	return Promise.all([first, second]);
}

/** The check an update body implies: special verbs for mapped members, `update` for the rest. */
function updateCheck(
	target: Target,
	resource: Resource,
	body: Readonly<Record<string, unknown>>,
): Check {
	const verbs = FIELD_VERBS[resource] ?? {};
	const special = new Set<Action>();
	const plain: string[] = [];
	for (const key of Object.keys(body)) {
		const verb = verbs[key];
		if (verb === undefined) {
			plain.push(key);
		} else {
			special.add(actionOf(resource, verb));
		}
	}
	const actions = [...special];
	if (plain.length > 0 || actions.length === 0) {
		actions.push(actionOf(resource, "update"));
	}
	return { target, actions, fields: { resource, keys: plain } };
}

/**
 * How an operation's body relates to the resource it acts on. `shaped`: the
 * resource's own create or update body, completed and checked by the
 * policy's constraints. `checked`: members of the resource that are not
 * shaped but still pass the update field allowlist (followers,
 * dependencies). `opaque`: the body describes something else (a duplicate,
 * an instantiation, an enum option, a metric, a portfolio item); only the
 * action is checked and the body is sent as written.
 */
type Shaping = "shaped" | "checked" | "opaque";

/** What a request must pass to act on `target`; creates and updates come with their body shaped by the policy. */
async function writeCheck(
	ctx: PlanContext,
	target: Target,
	action: { resource: Resource; verb: Verb; shaping?: Shaping | undefined },
): Promise<{ check: Check; data?: Record<string, unknown> }> {
	const { resource, verb, shaping = "shaped" } = action;
	const plain: Check = { target, actions: [actionOf(resource, verb)] };
	if (shaping === "opaque" || (verb !== "update" && verb !== "create")) {
		return { check: plain };
	}
	if (shaping === "checked") {
		return { check: verb === "update" ? updateCheck(target, resource, ctx.body) : plain };
	}
	const data = await ctx.shape(target.facts, { resource, verb });
	return { check: verb === "update" ? updateCheck(target, resource, data) : plain, data };
}

/** Verbs after which the path object's cached facts are still right. */
const KEEPS_FACTS: ReadonlySet<Verb> = new Set(["read", "create", "manage_members", "reorder"]);

const EVENT_TYPES: readonly Resource[] = ["project", "task", "goal", "portfolio", "section"];
const WEBHOOK_TYPES: readonly Resource[] = [
	"project",
	"task",
	"portfolio",
	"goal",
	"team",
	"workspace",
];

/** Loads a target when the request names one. */
async function anchorIfGiven(
	ctx: PlanContext,
	type: Resource,
	gid: string | undefined,
): Promise<Target | undefined> {
	const target = gid === undefined ? undefined : await ctx.anchor(type, gid);
	return target;
}

/**
 * The gid the operation's path names first (`/tasks/{task_gid}/…`), read
 * through the catalog so a renamed path parameter cannot go unnoticed.
 */
function pathGid(ctx: PlanContext): string | undefined {
	const [param] = ctx.spec.pathParams;
	return param === undefined ? undefined : ctx.params[param];
}

/**
 * `GET /<type>s/{gid}`: read one object addressed by a path parameter. The
 * object that is checked is the one answered, read once (afresh), so the
 * request is not sent again; `limit` and `confirm` still apply before it is.
 */
function getOne(type: Resource): OperationRule {
	return make({ resource: type, verb: "read", scope: "path" }, async (ctx) => {
		const { target, answer } = await ctx.read(type, pathGid(ctx));
		return {
			checks: [{ target, actions: [actionOf(type, "read")] }],
			response: {
				kind: "item",
				type,
				facts: target.facts,
				...((answer?.placement ?? target.object) && {
					loaded: answer?.placement ?? target.object,
				}),
				...(answer?.selection && { selection: answer.selection }),
			},
			...(answer && { answer: answer.body }),
		};
	});
}

/** `PUT /<type>s/{gid}`: update one object; the body decides the verbs. */
function updateOne(type: Resource): OperationRule {
	return make({ resource: type, verb: "update", scope: "path" }, async (ctx) => {
		const target = await ctx.anchor(type, pathGid(ctx));
		const { check, data } = await writeCheck(ctx, target, { resource: type, verb: "update" });
		return {
			checks: [check],
			data,
			response: { kind: "item", type },
			invalidate: [{ type, gid: target.gid }],
		};
	});
}

/** `DELETE /<type>s/{gid}`. */
function deleteOne(type: Resource): OperationRule {
	return make({ resource: type, verb: "delete", scope: "path" }, async (ctx) => {
		const target = await ctx.anchor(type, pathGid(ctx));
		return {
			checks: [{ target, actions: [actionOf(type, "delete")] }],
			response: RAW,
			invalidate: [{ type, gid: target.gid }],
		};
	});
}

/**
 * A body member naming an object (or, with `many`, objects) that must be
 * visible, and on which `actions` must be allowed when it is changed too.
 */
interface BodyRef {
	readonly field: string;
	readonly types: readonly Resource[];
	readonly many?: boolean;
	readonly actions?: readonly Action[];
}

function bodyRefs(ctx: PlanContext, refs: readonly BodyRef[]): Promise<Check[]> {
	return Promise.all(
		refs.flatMap((ref) =>
			(ref.many === true ? ctx.bodyGids(ref.field) : [ctx.bodyGid(ref.field)]).map(async (gid) => ({
				target: await ctx.probe(gid, ref.types),
				actions: ref.actions ?? [],
			})),
		),
	);
}

/** Options of {@link actOn}. */
interface ActOnOptions {
	/** The path object's type. */
	readonly on: Resource;
	readonly verb: Verb;
	/** The action's resource when it differs from the path object's type. */
	readonly resource?: Resource;
	readonly response?: ResponseKind;
	/** Objects the body names that must be visible. */
	readonly also?: readonly BodyRef[];
	/** How the body relates to the action's resource (default `shaped`). */
	readonly shaping?: Shaping;
}

/**
 * `POST /<type>s/{gid}/<action>`: an action on the path object (optionally of
 * another resource living in it). Creates and updates are shaped by the
 * policy's constraints, and the path object's cached facts are dropped unless
 * the verb leaves them untouched.
 */
function actOn(options: ActOnOptions): OperationRule {
	const resource = options.resource ?? options.on;
	return make({ resource, verb: options.verb, scope: "path" }, async (ctx) => {
		const [target, refs] = await both(
			ctx.anchor(options.on, pathGid(ctx)),
			bodyRefs(ctx, options.also ?? []),
		);
		const { check, data } = await writeCheck(ctx, target, {
			resource,
			verb: options.verb,
			shaping: options.shaping,
		});
		return {
			checks: [check, ...refs],
			...(data && { data }),
			response: responseOf(options.response ?? "raw", resource, target.facts),
			...(!KEEPS_FACTS.has(options.verb) && {
				invalidate: [{ type: options.on, gid: target.gid }],
			}),
		};
	});
}

/**
 * The check of a list read anchored on `target`: with `shared` the items take
 * the target's facts, so its read decides them all; otherwise each item is
 * decided by itself, and the read only counts for `limit` and `confirm`.
 */
function listCheck(target: Target, read: Action, shared: boolean): Check {
	return shared ? { target, actions: [read] } : { target, actions: [], counted: [read] };
}

/** Options of {@link listUnder}. */
interface ListUnderOptions {
	readonly under: Resource;
	readonly items: Resource | "mixed";
	/** For mixed items, the types they are expected to be of. */
	readonly expect?: readonly Resource[];
	/** Items take the anchor's facts (stories of a task) instead of their own. */
	readonly shared?: boolean;
}

/** `GET /<anchor>s/{gid}/<items>`: a list under the path object. */
function listUnder(options: ListUnderOptions): OperationRule {
	const resource = options.items === "mixed" ? options.under : options.items;
	return make({ resource, verb: "read", scope: "filter" }, async (ctx) => {
		const target = await ctx.anchor(options.under, pathGid(ctx));
		const shared = options.shared === true && options.items !== "mixed";
		const read = actionOf(resource, "read");
		return {
			checks: [
				options.items === "mixed" ? { target, actions: [] } : listCheck(target, read, shared),
			],
			response: {
				kind: "list",
				type: options.items,
				...(shared && { facts: target.facts }),
				...(options.expect && { expect: options.expect }),
			},
		};
	});
}

/** Options of {@link createUnder}. */
interface CreateUnderOptions {
	readonly under: Resource;
	readonly item: Resource;
	readonly shared?: boolean;
	readonly response?: ResponseKind;
}

/** `POST /<anchor>s/{gid}/<items>`: create an item under the path object. */
function createUnder(options: CreateUnderOptions): OperationRule {
	return make({ resource: options.item, verb: "create", scope: "path" }, async (ctx) => {
		const target = await ctx.anchor(options.under, pathGid(ctx));
		const { check, data } = await writeCheck(ctx, target, {
			resource: options.item,
			verb: "create",
		});
		return {
			checks: [check],
			data,
			response: responseOf(options.response, options.item, sharedFacts(options.shared, target)),
		};
	});
}

/** Options of {@link onWorkspace}. */
interface WorkspaceOptions {
	/** The workspace is the one the path names (`/workspaces/{workspace_gid}/…`). */
	readonly path?: true;
	readonly query?: string;
	readonly body?: string;
	readonly response?: ResponseKind;
	readonly scope?: ScopeKind;
	/** How the request body relates to the resource (default `shaped`). */
	readonly shaping?: Shaping;
}

function workspaceGidOf(ctx: PlanContext, options: WorkspaceOptions): string | undefined {
	if (options.path === true) {
		return pathGid(ctx);
	}
	if (options.query !== undefined) {
		return ctx.query[options.query];
	}
	if (options.body !== undefined) {
		return ctx.bodyGid(options.body);
	}
	return undefined;
}

/** A workspace-level operation; the workspace named by the request must be the governed one. */
function onWorkspace(
	resource: Resource,
	verb: Verb,
	options: WorkspaceOptions = {},
): OperationRule {
	return make({ resource, verb, scope: options.scope ?? "workspace" }, async (ctx) => {
		const target = ctx.workspace(workspaceGidOf(ctx, options));
		if (verb === "read" && options.response === "list") {
			// Filtered item by item, like every other list anchored on the workspace.
			return {
				checks: [listCheck(target, actionOf(resource, "read"), false)],
				response: responseOf("list", resource),
			};
		}
		const { check, data } = await writeCheck(ctx, target, {
			resource,
			verb,
			shaping: options.shaping,
		});
		return {
			checks: [check],
			...(data && { data }),
			response: responseOf(options.response ?? "raw", resource),
		};
	});
}

/** Options of {@link onBody}. */
interface OnBodyOptions {
	readonly resource: Resource;
	readonly verb: Verb;
	/** The body member naming the object. */
	readonly field: string;
	readonly types: readonly Resource[];
	readonly response?: ResponseKind;
	readonly shared?: boolean;
}

/** An operation on the object a body member names, whose type is one of `types`. */
function onBody(options: OnBodyOptions): OperationRule {
	return make({ resource: options.resource, verb: options.verb, scope: "body" }, async (ctx) => {
		const target = await ctx.probe(ctx.bodyGid(options.field), options.types);
		const { check, data } = await writeCheck(ctx, target, {
			resource: options.resource,
			verb: options.verb,
		});
		return {
			checks: [check],
			...(data && { data }),
			response: responseOf(options.response, options.resource, sharedFacts(options.shared, target)),
			...(!KEEPS_FACTS.has(options.verb) && {
				invalidate: [{ type: target.type, gid: target.gid }],
			}),
		};
	});
}

/** A query member that may name the object a list is anchored on, and the types it may have. */
interface ListAnchor {
	readonly query: string;
	readonly types: readonly Resource[];
}

/** Options of {@link listBy}. */
interface ListByOptions {
	/** Items take the anchor's facts (they live inside it) instead of their own. */
	readonly shared?: boolean;
	/** The first anchor must be given; otherwise an absent anchor means the workspace. */
	readonly required?: boolean;
}

/**
 * A list anchored on the object a query member names (`?project=`, `?parent=`),
 * the first present of `anchors`, or on the workspace when none is given.
 */
function listBy(
	resource: Resource,
	anchors: readonly ListAnchor[],
	options: ListByOptions = {},
): OperationRule {
	const scope: ScopeKind = options.required === true ? "query" : "filter";
	return make({ resource, verb: "read", scope }, async (ctx) => {
		const [first] = anchors;
		const found =
			anchors.find((anchor) => ctx.query[anchor.query] !== undefined) ??
			(options.required === true ? first : undefined);
		// A `workspace` query must name the governed workspace, anchor or not.
		const workspace = ctx.workspace(ctx.query.workspace);
		const target =
			found === undefined ? workspace : await ctx.probe(ctx.query[found.query], found.types);
		const shared = options.shared === true && target.type !== "workspace";
		return {
			checks: [listCheck(target, actionOf(resource, "read"), shared)],
			response: { kind: "list", type: resource, ...(shared && { facts: target.facts }) },
		};
	});
}

/** The user gid a body's `assignee` names (`me`, a gid, an email or a `{ gid }` reference). */
async function assigneeOf(
	ctx: PlanContext,
	body: Readonly<Record<string, unknown>>,
): Promise<string | null> {
	const raw = body.assignee;
	if (typeof raw !== "string") {
		return refOf(raw)?.gid ?? null;
	}
	if (raw === "") {
		return null;
	}
	// Assignee scopes compare user gids, so the request is judged by the user it names.
	const gid = await ctx.loader.userGid(raw);
	if (gid === undefined) {
		throw badRequest(`assignee: Unknown object: ${raw}`);
	}
	return gid;
}

function customFieldValuesOf(
	body: Readonly<Record<string, unknown>>,
): Map<string, ReadonlySet<string>> {
	const customFields = new Map<string, ReadonlySet<string>>();
	if (isObject(body.custom_fields)) {
		for (const [gid, value] of Object.entries(body.custom_fields)) {
			customFields.set(gid, new Set(textsOf(value)));
		}
	}
	return customFields;
}

/** Tags, assignee and custom field values a task body sets, as facts. */
async function crossFactsOf(
	ctx: PlanContext,
	body: Readonly<Record<string, unknown>>,
): Promise<Pick<Facts, "tags" | "assignee" | "customFields">> {
	return {
		tags: new Set(gidsOf(body.tags)),
		assignee: await assigneeOf(ctx, body),
		customFields: customFieldValuesOf(body),
	};
}

/** The state of a task about to be created, from its request body. */
function createdTaskState(
	ctx: PlanContext,
	body: Readonly<Record<string, unknown>>,
	parent: Target | undefined,
): ObjectState {
	return {
		...taskState(body),
		createdBy: ctx.policy.me.gid,
		completed: body.completed === true,
		hasParent: parent !== undefined,
		createdAt: new Date().toISOString(),
	};
}

/**
 * The projects a task body places the task in: `memberships` with their
 * sections, plus the `projects` no membership names (Asana wants both for a
 * section, so a project named in both is one home, in its section).
 */
function membershipsOfBody(body: Readonly<Record<string, unknown>>): Membership[] {
	const listed = membershipsOf(body);
	const unlisted = gidsOf(body.projects).filter(
		(project) => !listed.some((membership) => membership.project === project),
	);
	return [...unlisted.map((project) => ({ project, section: undefined })), ...listed];
}

/** Where a task about to be created will live: its parent, and the projects of its memberships. */
interface NewTaskPlacement {
	readonly parent: Target | undefined;
	readonly homes: readonly { membership: Membership; project: Target }[];
}

/** The facts of a task about to be created, from its request body. */
async function createdTaskFacts(
	ctx: PlanContext,
	placement: NewTaskPlacement,
	body: Readonly<Record<string, unknown>>,
): Promise<Facts> {
	const cross = {
		...(await crossFactsOf(ctx, body)),
		state: createdTaskState(ctx, body, placement.parent),
	};
	if (placement.homes.length === 0 && placement.parent !== undefined) {
		return { ...placement.parent.facts, ...cross };
	}
	const workspace = ctx.workspace(ctx.bodyGid("workspace"));
	if (placement.homes.length === 0) {
		return {
			workspace: workspace.gid,
			branches: [{ ...WORKSPACE_BRANCH, unhomed: true }],
			...cross,
		};
	}
	// A subtask with projects of its own still descends from its parent, as one without takes in.
	const [parentBranch] = placement.parent?.facts.branches ?? [];
	const branches = placement.homes.map(({ membership, project }) => {
		const [branch] = project.facts.branches;
		if (branch === undefined || project.facts.workspace !== ctx.policy.workspace) {
			throw notFound("project", project.gid);
		}
		return {
			...branch,
			...(membership.section !== undefined && { section: membership.section }),
			...(parentBranch !== undefined && { taskChain: parentBranch.taskChain }),
		};
	});
	return { workspace: workspace.gid, branches, ...cross };
}

/** `POST /tasks` (the parent, if any, in the body) and `POST /tasks/{gid}/subtasks` (in the path). */
function createTaskRule(scope: "body" | "path"): OperationRule {
	return make({ resource: "task", verb: "create", scope }, async (ctx) => {
		const parentGid = scope === "path" ? pathGid(ctx) : ctx.bodyGid("parent");
		const [parent, homes] = await both(
			anchorIfGiven(ctx, "task", parentGid),
			Promise.all(
				membershipsOfBody(ctx.body).map(async (membership) => ({
					membership,
					project: await ctx.anchor("project", membership.project),
				})),
			),
		);
		const preliminary = await createdTaskFacts(ctx, { parent, homes }, ctx.body);
		const data = await ctx.shape(preliminary, { resource: "task", verb: "create" });
		// The shaped body may carry other tags, assignee or custom field values.
		const facts = {
			...preliminary,
			...(await crossFactsOf(ctx, data)),
			state: createdTaskState(ctx, data, parent),
		};
		// The new task has no gid yet; its name tells a person what is being created.
		const target: Target = {
			type: "task",
			gid: "(new)",
			facts,
			...(typeof data.name === "string" && { object: { name: data.name } }),
		};
		const checks: Check[] = [
			...(parent === undefined ? [] : [{ target: parent, actions: [] }]),
			{ target, actions: [actionOf("task", "create")] },
		];
		return { checks, data, response: { kind: "item", type: "task" } };
	});
}

/** The task as it would be placed in `container` (a project or a section), optionally in `section`; it keeps its ancestors. */
function homedIn(task: Target, container: Facts, section?: string): Target {
	const taskChain = task.facts.branches[0]?.taskChain ?? [task.gid];
	return {
		type: "task",
		gid: task.gid,
		facts: {
			...task.facts,
			workspace: container.workspace,
			branches: container.branches.map((branch) => ({
				...branch,
				...(section !== undefined && { section }),
				taskChain,
			})),
		},
	};
}

/**
 * The task as it would be placed under `parent` (or made top-level when
 * `parent` is undefined): a task without a project of its own takes the
 * parent's placement, and its ancestor chain becomes the parent's.
 */
function placedUnder(task: Target, parent: Target | undefined): Target {
	const own = membershipsOf(task.object ?? {}).length > 0;
	const chainOf = (branch: { readonly taskChain: readonly string[] }): string[] => [
		task.gid,
		...branch.taskChain.filter((gid) => gid !== task.gid),
	];
	let branches = task.facts.branches.map((branch) => ({ ...branch, taskChain: [task.gid] }));
	if (parent === undefined && !own) {
		branches = [{ ...WORKSPACE_BRANCH, unhomed: true, taskChain: [task.gid] }];
	} else if (parent !== undefined) {
		const source = own ? task.facts.branches : parent.facts.branches;
		const [parentBranch] = parent.facts.branches;
		branches = source.map((branch) => ({
			...branch,
			taskChain: chainOf(own ? (parentBranch ?? branch) : branch),
		}));
	}
	return {
		type: "task",
		gid: task.gid,
		facts: {
			...task.facts,
			workspace: parent?.facts.workspace ?? task.facts.workspace,
			branches,
			state: { ...task.facts.state, hasParent: parent !== undefined },
		},
	};
}

/** `POST /tasks/{gid}/setParent`: the moved task must be creatable where it lands, as itself. */
const setParentRule = make({ resource: "task", verb: "set_parent", scope: "path" }, async (ctx) => {
	const [task, parent] = await both(
		ctx.anchor("task", pathGid(ctx)),
		anchorIfGiven(ctx, "task", ctx.bodyGid("parent")),
	);
	const unparented = parent === undefined && ctx.body.parent === null;
	return {
		checks: [
			{ target: task, actions: [actionOf("task", "set_parent")] },
			...(parent === undefined ? [] : [{ target: parent, actions: [] }]),
			...(parent !== undefined || unparented
				? [{ target: placedUnder(task, parent), actions: [actionOf("task", "create")] }]
				: []),
		],
		response: { kind: "item", type: "task" },
		invalidate: [{ type: "task", gid: task.gid }],
	};
});

/** `POST /tasks/{gid}/addProject`: the task may be added, and may be created where it lands. */
const addProjectRule = make(
	{ resource: "task", verb: "add_project", scope: "path" },
	async (ctx) => {
		const [task, project] = await both(
			ctx.anchor("task", pathGid(ctx)),
			ctx.anchor("project", ctx.bodyGid("project")),
		);
		const destination = homedIn(task, project.facts, ctx.bodyGid("section"));
		return {
			checks: [
				{ target: task, actions: [actionOf("task", "add_project")] },
				{ target: project, actions: [] },
				{ target: destination, actions: [actionOf("task", "create")] },
			],
			response: RAW,
			invalidate: [{ type: "task", gid: task.gid }],
		};
	},
);

/** `POST /tasks/{gid}/removeProject`: the project must be visible. */
const removeProjectRule = actOn({
	on: "task",
	verb: "remove_project",
	also: [{ field: "project", types: ["project"] }],
});

/**
 * `POST /sections/{gid}/addTask`: moving a task needs `move` where it is and
 * where it goes. A task from outside the project is added to it (verified
 * live), which additionally needs `create` there.
 */
const addTaskForSectionRule = make(
	{ resource: "task", verb: "move", scope: "path" },
	async (ctx) => {
		const [section, task] = await both(
			ctx.anchor("section", pathGid(ctx)),
			ctx.anchor("task", ctx.bodyGid("task")),
		);
		const [sectionBranch] = section.facts.branches;
		// Only the task's own memberships count: a subtask placed through its parent is not in the
		// parent's projects, and adding it to one of them puts it there.
		const alreadyIn = membershipsOf(task.object ?? {}).some(
			(membership) => membership.project === sectionBranch?.project,
		);
		const destination = homedIn(task, section.facts);
		const moveActions = [actionOf("task", "move")];
		return {
			checks: [
				{ target: section, actions: [] },
				{ target: task, actions: moveActions },
				{
					target: destination,
					actions: alreadyIn ? moveActions : [...moveActions, actionOf("task", "create")],
				},
			],
			response: RAW,
			invalidate: [{ type: "task", gid: task.gid }],
		};
	},
);

/** An update of a task that also changes the tasks the body names (dependencies, dependents): both ends are updated. */
function taskLinkRule(field: string): OperationRule {
	return actOn({
		on: "task",
		verb: "update",
		also: [{ field, types: ["task"], many: true, actions: [actionOf("task", "update")] }],
		shaping: "checked",
	});
}

/** `POST /tasks/{gid}/addTag` and `removeTag`: `tag:apply` in the task's scope, on a visible tag. */
const tagApplyRule = actOn({
	on: "task",
	verb: "apply",
	resource: "tag",
	also: [{ field: "tag", types: ["tag"] }],
});

async function refVisible(
	ctx: PlanContext,
	ref: Ref | undefined,
	fallback: readonly Resource[],
): Promise<boolean> {
	if (ref === undefined) {
		return true;
	}
	const loaded = await ctx.loader.loadRef(ref, fallback);
	return loaded !== undefined && isVisible(ctx.policy, loaded.facts, loaded.type);
}

/** The objects of `data`, each as `show` resolves it; the ones it resolves to `undefined` go. */
async function mapData(
	body: Record<string, unknown>,
	show: (item: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>,
): Promise<Record<string, unknown>> {
	const items = Array.isArray(body.data) ? body.data : [];
	const shown = await Promise.all(
		items.filter((item: unknown) => isObject(item)).map((item) => show(item)),
	);
	return { ...body, data: shown.filter((item) => item !== undefined) };
}

/** The members of an event's `change` that may name another object. */
const CHANGE_VALUES = ["new_value", "added_value", "removed_value"] as const;

/**
 * An event as an agent may see it, or `undefined` when it points at hidden
 * objects. A deleted object cannot be loaded any more, so a `deleted` event
 * is kept when its parent is visible; values in `change` that name hidden
 * objects are cleared.
 */
async function visibleEvent(
	ctx: PlanContext,
	event: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
	const parent = refOf(event.parent);
	const deleted = event.action === "deleted";
	const [resourceOk, parentOk] = await Promise.all([
		deleted
			? Promise.resolve(parent !== undefined)
			: refVisible(ctx, refOf(event.resource), EVENT_TYPES),
		refVisible(ctx, parent, EVENT_TYPES),
	]);
	if (!resourceOk || !parentOk) {
		return undefined;
	}
	const { change } = event;
	if (!isObject(change)) {
		return event;
	}
	const values = await Promise.all(
		CHANGE_VALUES.map(async (key) => {
			const value = change[key];
			const named = isObject(value) && typeof value.resource_type === "string";
			const visible = !named || (await refVisible(ctx, refOf(value), PARENT_TYPES));
			return [key, visible ? value : null] as const;
		}),
	);
	const kept = Object.fromEntries(values.filter(([key]) => key in change));
	return { ...event, change: { ...change, ...kept } };
}

/** `GET /events` and `GET /workspaces/{gid}/events`: every event must point at visible objects. */
function eventsRule(anchor: (ctx: PlanContext) => Promise<Target>): OperationRule {
	return make({ resource: "event", verb: "read", scope: "filter" }, async (ctx) => {
		const target = await anchor(ctx);
		return {
			checks: [{ target, actions: [actionOf("event", "read")] }],
			response: {
				kind: "custom",
				transform: (body): Promise<Record<string, unknown>> =>
					mapData(body, (event) => visibleEvent(ctx, event)),
			},
		};
	});
}

/** `GET /users/{gid}/notifications`: a notification is visible when all of its work objects are. */
const notificationsRule = make(
	{ resource: "notification", verb: "read", scope: "filter" },
	async (ctx) => {
		const user = await ctx.anchor("user", pathGid(ctx));
		const workspace = ctx.workspace(ctx.query.workspace);
		return {
			checks: [
				{ target: user, actions: [] },
				{ target: workspace, actions: [actionOf("notification", "read")] },
			],
			response: {
				kind: "custom",
				transform: (body): Promise<Record<string, unknown>> =>
					mapData(body, async (item) => {
						const objects = Array.isArray(item.work_objects) ? item.work_objects : [];
						const visible = await Promise.all(
							objects.map((object: unknown) => refVisible(ctx, refOf(object), PARENT_TYPES)),
						);
						return visible.every(Boolean) ? item : undefined;
					}),
			},
		};
	},
);

interface BatchAction {
	readonly plan: Plan;
	readonly action: Record<string, unknown>;
}

/**
 * Each action of a batch with its result, in order: Asana's for the actions
 * sent, the answer planned for the others; an action Asana returned no
 * result for has none.
 */
function resultsInOrder(
	subs: readonly BatchAction[],
	results: readonly unknown[],
): { readonly plan: Plan; readonly result: unknown }[] {
	const fromAsana = results[Symbol.iterator]();
	return subs.flatMap(({ plan }) => {
		if (plan.answer !== undefined) {
			return [{ plan, result: { status_code: 200, headers: {}, body: plan.answer } }];
		}
		const next = fromAsana.next();
		return next.done === true ? [] : [{ plan, result: next.value }];
	});
}

async function planBatchAction(
	ctx: PlanContext,
	action: unknown,
	index: number,
): Promise<BatchAction> {
	if (!isObject(action)) {
		throw badRequest(`actions[${index}]: expected an object`);
	}
	const method = (stringOf(action.method) ?? "").toUpperCase();
	const relativePath = stringOf(action.relative_path) ?? "";
	if (!isHttpMethod(method)) {
		throw badRequest(`actions[${index}].method: unsupported method "${method}"`);
	}
	const match = matchRoute(method, relativePath);
	if (match === undefined) {
		throw inAction(noRoute(), index);
	}
	if (match.operationId === "createBatchRequest") {
		// Asana does not run a batch inside a batch.
		throw badRequest(`actions[${index}]: a batch cannot hold another batch`);
	}
	// Asana rejects query strings in relative_path; GET and DELETE actions carry
	// their parameters in `data` instead (verified live).
	const data = dataOf(action.data);
	const reads = method === "GET" || method === "DELETE";
	// A read's `opt_fields` joins `options.fields`, where Asana reads a batch
	// action's fields, so the caller's and the gate's arrive in one list.
	const { opt_fields: dataFields, ...readData } = reads ? data : {};
	const query = Object.fromEntries(Object.entries(readData).map(([k, v]) => [k, String(v)]));
	const options = isObject(action.options) ? action.options : {};
	const requested = requestedFields(
		dataFields,
		Array.isArray(options.fields) ? (options.fields as unknown[]) : [],
	);
	const plan = await ctx
		.planSub({
			operationId: match.operationId,
			spec: match.spec,
			params: match.params,
			// The read's fields, which a GET by gid answers with.
			query: requested.length > 0 ? { ...query, opt_fields: requested.join(",") } : query,
			body: reads ? {} : data,
			unit: index,
		})
		.catch((error: unknown) => {
			throw inAction(error, index);
		});
	const optFields = augmentOptFields(
		plan.response,
		requested.length > 0 ? requested : undefined,
		(type) => ctx.loader.requiredFields(type),
	);
	// Writes carry the body as the policy shaped it, exactly like a single request.
	let sent: unknown = action.data;
	if (reads && dataFields !== undefined) {
		sent = readData;
	} else if (!reads && plan.data !== undefined) {
		sent = plan.data;
	}
	return {
		plan,
		action: {
			...action,
			...(sent !== undefined && { data: sent }),
			options: { ...options, ...(optFields && { fields: optFields }) },
		},
	};
}

/**
 * `POST /batch`: every action is planned on its own and checked like a
 * single request (limits count each action); one refusal refuses the whole
 * batch and names the action (`actions[i]`).
 */
const batchRule = make({ scope: "batch" }, async (ctx) => {
	const actions = Array.isArray(ctx.body.actions) ? ctx.body.actions : [];
	if (actions.length > BATCH_LIMIT) {
		throw badRequest(`actions: at most ${BATCH_LIMIT} per batch`);
	}
	// Every action is planned; the refusal reported is the first action's, whichever settles first.
	const settled = await Promise.allSettled(
		actions.map((action: unknown, index) => planBatchAction(ctx, action, index)),
	);
	const refused = settled.find((result) => result.status === "rejected");
	if (refused !== undefined) {
		throw refused.reason;
	}
	const subs = settled.map((result) => (result as PromiseFulfilledResult<BatchAction>).value);
	// Reads answered while planning are not sent; Asana runs a batch's actions in parallel and in
	// no order, so a read beside a write could have seen either state anyway.
	const sent = subs.filter((sub) => sub.plan.answer === undefined);
	return {
		checks: subs.flatMap((sub, unit) => sub.plan.checks.map((check) => ({ ...check, unit }))),
		data: { ...ctx.body, actions: sent.map((sub) => sub.action) },
		...(sent.length === 0 && { answer: { data: [] } }),
		invalidate: subs.flatMap((sub) => sub.plan.invalidate ?? []),
		response: {
			kind: "custom",
			async transform(body): Promise<Record<string, unknown>> {
				const results = resultsInOrder(subs, Array.isArray(body.data) ? body.data : []);
				const processed = await Promise.all(
					results.map(async ({ plan, result }) => {
						if (!isObject(result) || !isObject(result.body)) {
							return result;
						}
						const status = typeof result.status_code === "number" ? result.status_code : 200;
						if (status >= 400) {
							return result;
						}
						return { ...result, body: await ctx.postProcess(plan.response, result.body) };
					}),
				);
				return { ...body, data: processed };
			},
		},
	};
});

/** The body's `team` as a target, when it names one. */
function teamTarget(ctx: PlanContext): Promise<Target | undefined> {
	return anchorIfGiven(ctx, "team", ctx.bodyGid("team"));
}

/**
 * `PUT /projects/{gid}` and `PUT /goals/{gid}`: an update whose body names
 * another team moves the object there, which needs `create` in that team
 * (and the team must be visible), like creating it there would.
 */
function updateMovable(type: "project" | "goal"): OperationRule {
	return make({ resource: type, verb: "update", scope: "path" }, async (ctx) => {
		const [target, team] = await both(ctx.anchor(type, pathGid(ctx)), teamTarget(ctx));
		const { check, data } = await writeCheck(ctx, target, { resource: type, verb: "update" });
		const current = target.facts.branches.map((branch) => branch.team);
		const moves = team !== undefined && !current.includes(team.gid);
		return {
			checks: [check, ...(moves ? [{ target: team, actions: [actionOf(type, "create")] }] : [])],
			data,
			response: { kind: "item", type },
			invalidate: [{ type, gid: target.gid }],
		};
	});
}

/**
 * `POST /projects`, `POST /goals` (the workspace in the body) and `POST
 * /workspaces/{gid}/projects` (in the path): create in the body's team, or at
 * workspace level.
 */
function createInTeam(resource: "project" | "goal", workspaceIn: "body" | "path"): OperationRule {
	return make({ resource, verb: "create", scope: "body" }, async (ctx) => {
		const workspace = ctx.workspace(
			workspaceIn === "path" ? pathGid(ctx) : ctx.bodyGid("workspace"),
		);
		const target = (await teamTarget(ctx)) ?? workspace;
		const { check, data } = await writeCheck(ctx, target, { resource, verb: "create" });
		return { checks: [check], data, response: { kind: "item", type: resource } };
	});
}

/** `GET /goals`: anchored on the first filter object the query names. */
const getGoalsRule = listBy("goal", [
	{ query: "portfolio", types: ["portfolio"] },
	{ query: "project", types: ["project"] },
	{ query: "task", types: ["task"] },
	{ query: "team", types: ["team"] },
]);

/** `POST /portfolios/{gid}/addItem` and `removeItem`: the portfolio is updated, the item must be visible. */
const portfolioItemRule = actOn({
	on: "portfolio",
	verb: "update",
	also: [{ field: "item", types: ["project", "portfolio"] }],
	shaping: "opaque",
});

/** `POST /projects/{gid}/sections/insert`: reorder a visible section of the project. */
const insertSectionRule = actOn({
	on: "project",
	verb: "reorder",
	resource: "section",
	also: [{ field: "section", types: ["section"] }],
});

/** `POST /goals/{gid}/addSupportingRelationship` and `removeSupportingRelationship`. */
function goalRelationshipRule(verb: Verb): OperationRule {
	return actOn({
		on: "goal",
		verb,
		resource: "goal_relationship",
		also: [{ field: "supporting_resource", types: ["goal", "project", "portfolio", "task"] }],
		response: verb === "create" ? "item" : "raw",
	});
}

/** Options of {@link createFromRule}. */
interface CreateFromOptions {
	/** The path object's type. */
	readonly from: Resource;
	/** The path object must also allow `read` (a template being instantiated). */
	readonly read?: true;
	/** What is created. */
	readonly resource: Resource;
	/** How the body relates to `resource` (default `shaped`). */
	readonly shaping?: Shaping;
}

/** `POST /<type>s/{gid}/<action>` creating an object from the path object, in the body's team or where the path object lives. */
function createFromRule(options: CreateFromOptions): OperationRule {
	const { from, resource, shaping } = options;
	return make({ resource, verb: "create", scope: "path" }, async (ctx) => {
		const [source, team] = await both(ctx.anchor(from, pathGid(ctx)), teamTarget(ctx));
		const { check, data } = await writeCheck(ctx, team ?? source, {
			resource,
			verb: "create",
			shaping,
		});
		const actions = options.read === true ? [actionOf(from, "read")] : [];
		return { checks: [{ target: source, actions }, check], data, response: RAW };
	});
}

/**
 * `POST /project_templates/{gid}/instantiateProject`: the template is read, a
 * project is created in the team. The body (name, team, dates, roles)
 * instantiates the template, not a project body.
 */
const instantiateProjectRule = createFromRule({
	from: "project_template",
	read: true,
	resource: "project",
	shaping: "opaque",
});

/** `POST /task_templates/{gid}/instantiateTask`: the template is read, a task is created in its project. */
const instantiateTaskRule = make(
	{ resource: "task", verb: "create", scope: "path" },
	async (ctx) => {
		const template = await ctx.anchor("task_template", pathGid(ctx));
		const { check, data } = await writeCheck(ctx, template, {
			resource: "task",
			verb: "create",
			shaping: "opaque",
		});
		return {
			checks: [{ ...check, actions: [actionOf("task_template", "read"), ...check.actions] }],
			data,
			response: RAW,
		};
	},
);

/** `POST /projects/{gid}/saveAsTemplate`: a template is created where the project (or the body's team) lives. */
const saveAsTemplateRule = createFromRule({ from: "project", resource: "project_template" });

/** `GET|PUT /users/{gid}` and `GET|PUT /workspaces/{wgid}/users/{gid}`. */
function userRule(verb: "read" | "update"): OperationRule {
	return make({ resource: "user", verb, scope: "workspace" }, async (ctx) => {
		// `/users/{user_gid}` takes the workspace from `?workspace=`,
		// `/workspaces/{workspace_gid}/users/{user_gid}` from its path.
		const gids = ctx.spec.pathParams.map((param) => ctx.params[param]);
		const [workspaceGid, userGid] = gids.length > 1 ? gids : [ctx.query.workspace, gids[0]];
		const workspace = ctx.workspace(workspaceGid);
		const user = await ctx.anchor("user", userGid);
		const { check, data } = await writeCheck(ctx, user, { resource: "user", verb });
		return {
			checks: [{ target: workspace, actions: [] }, check],
			...(data && { data }),
			response: responseOf("item", "user", verb === "read" ? user.facts : undefined),
		};
	});
}

/**
 * The results of a request whose `resource_type` query names their type
 * (typeahead, favorites): judged as objects of that type, or one by one when
 * it names none the gate knows.
 */
function listOfQueried(resourceType: string | undefined): ResponsePlan {
	const type = resourceOfType(resourceType);
	return { kind: "list", type: "mixed", ...(type !== undefined && { expect: [type] }) };
}

/** Options of {@link forUserRule}. */
interface ForUserOptions {
	/** The list holds objects of the type its `resource_type` query names (favorites) rather than `resource`s. */
	readonly mixed?: true;
	/** The response is one object at workspace level (the user's task list), not a filtered list. */
	readonly one?: true;
	/** The query member naming the workspace (default `workspace`). */
	readonly workspaceQuery?: string;
}

/** `GET /users/{gid}/<things>`: `resource:read` in the workspace the query names, on a visible user. */
function forUserRule(resource: Resource, options: ForUserOptions = {}): OperationRule {
	const scope: ScopeKind = options.one === true ? "workspace" : "filter";
	return make({ resource, verb: "read", scope }, async (ctx) => {
		const user = await ctx.anchor("user", pathGid(ctx));
		const workspace = ctx.workspace(ctx.query[options.workspaceQuery ?? "workspace"]);
		const list: ResponsePlan =
			options.mixed === true
				? listOfQueried(ctx.query.resource_type)
				: { kind: "list", type: resource };
		// The user's task list is one object at workspace level; the lists are filtered item by item.
		const one = options.one === true;
		return {
			checks: [
				{ target: user, actions: [] },
				listCheck(workspace, actionOf(resource, "read"), one),
			],
			response: one ? { kind: "item", type: resource, facts: workspace.facts } : list,
		};
	});
}

/** `GET /workspaces`: only the governed workspace is listed. */
const getWorkspacesRule = make({ resource: "workspace", verb: "read", scope: "filter" }, (ctx) =>
	Promise.resolve({
		checks: [{ target: ctx.workspace(), actions: [] }],
		response: { kind: "list", type: "workspace" },
	}),
);

/** `GET /workspaces/{gid}/typeahead`: results of the type asked for (`type` is its deprecated name). */
const typeaheadRule = make({ resource: "workspace", verb: "read", scope: "filter" }, (ctx) =>
	Promise.resolve({
		checks: [{ target: ctx.workspace(pathGid(ctx)), actions: [] }],
		response: listOfQueried(ctx.query.resource_type ?? ctx.query.type),
	}),
);

/**
 * `GET /workspaces/{gid}/tasks/custom_id/{id}`: the task can only be checked
 * once found; `limit` and `confirm` on `task:read` apply at workspace level
 * before it is fetched.
 */
const taskForCustomIdRule = make({ resource: "task", verb: "read", scope: "workspace" }, (ctx) =>
	Promise.resolve({
		checks: [
			{
				target: ctx.workspace(pathGid(ctx)),
				actions: [],
				counted: [actionOf("task", "read")],
			},
		],
		response: { kind: "item", type: "task", verify: true },
	}),
);

/** An object a request names in a query or body member, which must be visible. */
interface Named {
	readonly gid: string;
	readonly types: readonly Resource[];
}

/** The rule, after the objects the request names (`named(ctx)`) are found visible. */
function naming(rule: OperationRule, named: (ctx: PlanContext) => readonly Named[]): OperationRule {
	return {
		...rule,
		async plan(ctx) {
			const targets = await Promise.all(named(ctx).map(({ gid, types }) => ctx.probe(gid, types)));
			const plan = await rule.plan(ctx);
			return {
				...plan,
				checks: [...targets.map((target) => ({ target, actions: [] })), ...plan.checks],
			};
		},
	};
}

/** The gid-valued filters of `GET /workspaces/{gid}/tasks/search` (`projects.any`, …) and what they name. */
const SEARCH_FILTERS: Readonly<Record<string, Resource>> = {
	projects: "project",
	sections: "section",
	tags: "tag",
	teams: "team",
	portfolios: "portfolio",
	custom_fields: "custom_field",
};

/** The objects a task search names: the gids of its filters, and the custom fields its keys name. */
function searchNamed(ctx: PlanContext): Named[] {
	return Object.entries(ctx.query).flatMap(([key, value]): Named[] => {
		const [member = "", field] = key.split(".");
		const type = SEARCH_FILTERS[member];
		if (type === undefined) {
			return [];
		}
		if (type === "custom_field") {
			return field !== undefined && isGid(field) ? [{ gid: field, types: [type] }] : [];
		}
		return splitList(value)
			.filter((gid) => isGid(gid))
			.map((gid) => ({ gid, types: [type] }));
	});
}

/** The project or portfolio an access request names (`target`), from the query or the body. */
const ACCESS_TARGET_TYPES: readonly Resource[] = ["project", "portfolio"];

function accessTarget(gid: string | undefined): Named[] {
	return gid === undefined ? [] : [{ gid, types: ACCESS_TARGET_TYPES }];
}

/** A subset of the object operations (naming another is a type error). */
type ObjectOperations<Ids extends ObjectOperationId> = Ids;

/**
 * Object operations classified otherwise: jobs, organization exports, users
 * and workspaces are judged at workspace level, and an update that moves a
 * project or a goal to another team needs `create` there.
 */
type ClassifiedOtherwise = ObjectOperations<
	| "getJob"
	| "getOrganizationExport"
	| "getUser"
	| "updateUser"
	| "getWorkspace"
	| "updateWorkspace"
	| "updateProject"
	| "updateGoal"
>;

/** The operations classified from their path alone. */
type DerivedId = Exclude<ObjectOperationId, ClassifiedOtherwise>;

/** The rule of a plain read, update or delete of one object, when `spec` is one. */
function objectRule(spec: OperationSpec): OperationRule | undefined {
	const operation = objectOperationOf(spec);
	if (operation === undefined) {
		return undefined;
	}
	const rules = { read: getOne, update: updateOne, delete: deleteOne };
	return rules[operation.verb](operation.resource);
}

/**
 * The classification of every operation that is not a plain read, update or
 * delete of one object (those are derived from their path); a missing entry
 * is a type error, and so is an entry for a derived operation not listed in
 * {@link ClassifiedOtherwise}.
 */
const RULES = {
	// Access requests
	getAccessRequests: naming(
		onWorkspace("access_request", "read", { response: "list", scope: "filter" }),
		(ctx) => accessTarget(ctx.query.target),
	),
	createAccessRequest: naming(
		onWorkspace("access_request", "create", { response: "item" }),
		(ctx) => accessTarget(ctx.bodyGid("target")),
	),
	approveAccessRequest: onWorkspace("access_request", "update", {
		response: "item",
		shaping: "opaque",
	}),
	rejectAccessRequest: onWorkspace("access_request", "update", {
		response: "item",
		shaping: "opaque",
	}),
	// Agents
	getAgentsForWorkspace: onWorkspace("agent", "read", {
		path: true,
		response: "list",
		scope: "filter",
	}),
	// AI Studio usage API
	getAiStudioRuns: onWorkspace("ai_studio_usage", "read", { path: true }),
	getAiStudioSeats: onWorkspace("ai_studio_usage", "read", { path: true }),
	// Allocations
	getAllocations: listBy("allocation", [{ query: "parent", types: ["project", "portfolio"] }]),
	createAllocation: onBody({
		resource: "allocation",
		verb: "create",
		field: "parent",
		types: ["project", "portfolio"],
	}),
	// Attachments
	getAttachmentsForObject: listBy(
		"attachment",
		[{ query: "parent", types: ["task", "project_brief"] }],
		{ required: true, shared: true },
	),
	createAttachmentForObject: onBody({
		resource: "attachment",
		verb: "create",
		field: "parent",
		types: ["task", "project_brief"],
		shared: true,
	}),
	// Audit log API
	getAuditLogEvents: onWorkspace("audit_log", "read", { path: true }),
	// Batch API
	createBatchRequest: batchRule,
	// Budgets
	getBudgets: listBy("budget", [{ query: "parent", types: ["project", "portfolio"] }], {
		required: true,
		shared: true,
	}),
	createBudget: onBody({
		resource: "budget",
		verb: "create",
		field: "parent",
		types: ["project", "portfolio"],
	}),
	// Custom field settings
	getCustomFieldSettingsForGoal: listUnder({
		under: "goal",
		items: "custom_field_setting",
		shared: true,
	}),
	getCustomFieldSettingsForPortfolio: listUnder({
		under: "portfolio",
		items: "custom_field_setting",
		shared: true,
	}),
	getCustomFieldSettingsForProject: listUnder({
		under: "project",
		items: "custom_field_setting",
		shared: true,
	}),
	getCustomFieldSettingsForTeam: listUnder({
		under: "team",
		items: "custom_field_setting",
		shared: true,
	}),
	// Custom fields
	createCustomField: onWorkspace("custom_field", "create", { body: "workspace", response: "item" }),
	createEnumOptionForCustomField: actOn({
		on: "custom_field",
		verb: "update",
		shaping: "opaque",
	}),
	insertEnumOptionForCustomField: actOn({
		on: "custom_field",
		verb: "update",
		shaping: "opaque",
	}),
	updateEnumOption: onWorkspace("custom_field", "update", { shaping: "opaque" }),
	getCustomFieldsForWorkspace: onWorkspace("custom_field", "read", {
		path: true,
		response: "list",
		scope: "filter",
	}),
	// Custom types
	getCustomTypes: listBy("custom_type", [{ query: "project", types: ["project"] }]),
	// Events
	getEvents: eventsRule((ctx) => ctx.probe(ctx.query.resource, EVENT_TYPES)),
	// Exports
	createGraphExport: onBody({
		resource: "export",
		verb: "create",
		field: "parent",
		types: ["project", "portfolio", "goal", "team"],
		response: "raw",
	}),
	createResourceExport: onWorkspace("export", "create", { body: "workspace" }),
	// Goal relationships
	getGoalRelationships: listBy(
		"goal_relationship",
		[{ query: "supported_goal", types: ["goal"] }],
		{ shared: true },
	),
	addSupportingRelationship: goalRelationshipRule("create"),
	removeSupportingRelationship: goalRelationshipRule("delete"),
	// Goals
	updateGoal: updateMovable("goal"),
	getGoals: getGoalsRule,
	createGoal: createInTeam("goal", "body"),
	createGoalMetric: actOn({
		on: "goal",
		verb: "update",
		response: "item",
		shaping: "opaque",
	}),
	updateGoalMetric: actOn({
		on: "goal",
		verb: "update",
		response: "item",
		shaping: "opaque",
	}),
	addFollowers: actOn({
		on: "goal",
		verb: "update",
		response: "item",
		shaping: "checked",
	}),
	removeFollowers: actOn({
		on: "goal",
		verb: "update",
		response: "item",
		shaping: "checked",
	}),
	getParentGoalsForGoal: listUnder({ under: "goal", items: "goal" }),
	addCustomFieldSettingForGoal: actOn({
		on: "goal",
		verb: "create",
		resource: "custom_field_setting",
	}),
	removeCustomFieldSettingForGoal: actOn({
		on: "goal",
		verb: "delete",
		resource: "custom_field_setting",
	}),
	// Jobs
	// An item, so the objects a job created (`new_project`, `new_task`) are checked like any nested reference.
	getJob: onWorkspace("job", "read", { response: "item" }),
	// Memberships
	getMemberships: listBy(
		"membership",
		[{ query: "parent", types: ["project", "portfolio", "goal", "custom_field"] }],
		{ shared: true },
	),
	createMembership: onBody({
		resource: "membership",
		verb: "create",
		field: "parent",
		types: ["project", "portfolio", "goal", "custom_field"],
		shared: true,
	}),
	// Notifications
	getNotificationsForUser: notificationsRule,
	markNotificationsReadForUser: onWorkspace("notification", "update", { body: "workspace" }),
	markNotificationsUnreadForUser: onWorkspace("notification", "update", { body: "workspace" }),
	// Ooo entries
	getOooEntries: onWorkspace("ooo_entry", "read", {
		query: "workspace",
		response: "list",
		scope: "filter",
	}),
	createOooEntry: onWorkspace("ooo_entry", "create", { body: "workspace", response: "item" }),
	// Organization exports
	createOrganizationExport: onWorkspace("organization_export", "create", { body: "organization" }),
	getOrganizationExport: onWorkspace("organization_export", "read"),
	// Portfolio memberships
	getPortfolioMemberships: listBy(
		"portfolio_membership",
		[{ query: "portfolio", types: ["portfolio"] }],
		{ shared: true },
	),
	getPortfolioMembershipsForPortfolio: listUnder({
		under: "portfolio",
		items: "portfolio_membership",
		shared: true,
	}),
	// Portfolios
	getPortfolios: onWorkspace("portfolio", "read", {
		query: "workspace",
		response: "list",
		scope: "filter",
	}),
	createPortfolio: onWorkspace("portfolio", "create", { body: "workspace", response: "item" }),
	getItemsForPortfolio: listUnder({
		under: "portfolio",
		items: "mixed",
		expect: ["project", "portfolio"],
	}),
	addItemForPortfolio: portfolioItemRule,
	removeItemForPortfolio: portfolioItemRule,
	addCustomFieldSettingForPortfolio: actOn({
		on: "portfolio",
		verb: "create",
		resource: "custom_field_setting",
	}),
	removeCustomFieldSettingForPortfolio: actOn({
		on: "portfolio",
		verb: "delete",
		resource: "custom_field_setting",
	}),
	addMembersForPortfolio: actOn({
		on: "portfolio",
		verb: "manage_members",
		response: "item",
	}),
	removeMembersForPortfolio: actOn({
		on: "portfolio",
		verb: "manage_members",
		response: "item",
	}),
	duplicatePortfolio: actOn({
		on: "portfolio",
		verb: "create",
		shaping: "opaque",
	}),
	// Project briefs
	createProjectBrief: createUnder({
		under: "project",
		item: "project_brief",
		shared: true,
	}),
	// Project memberships
	getProjectMembershipsForProject: listUnder({
		under: "project",
		items: "project_membership",
		shared: true,
	}),
	// Project portfolio settings
	getProjectPortfolioSettingsForProject: listUnder({
		under: "project",
		items: "project_portfolio_setting",
		shared: true,
	}),
	getProjectPortfolioSettingsForPortfolio: listUnder({
		under: "portfolio",
		items: "project_portfolio_setting",
	}),
	// Project statuses (the older status update API)
	getProjectStatus: getOne("status_update"),
	deleteProjectStatus: deleteOne("status_update"),
	getProjectStatusesForProject: listUnder({
		under: "project",
		items: "status_update",
		shared: true,
	}),
	createProjectStatusForProject: createUnder({
		under: "project",
		item: "status_update",
		shared: true,
	}),
	// Project templates
	getProjectTemplates: listBy("project_template", [{ query: "team", types: ["team"] }]),
	getProjectTemplatesForTeam: listUnder({
		under: "team",
		items: "project_template",
	}),
	instantiateProject: instantiateProjectRule,
	// Projects
	getProjects: listBy("project", [{ query: "team", types: ["team"] }]),
	createProject: createInTeam("project", "body"),
	updateProject: updateMovable("project"),
	duplicateProject: actOn({
		on: "project",
		verb: "create",
		shaping: "opaque",
	}),
	getProjectsForTask: listUnder({ under: "task", items: "project" }),
	getProjectsForTeam: listUnder({ under: "team", items: "project" }),
	createProjectForTeam: createUnder({ under: "team", item: "project" }),
	getProjectsForWorkspace: onWorkspace("project", "read", {
		path: true,
		response: "list",
		scope: "filter",
	}),
	createProjectForWorkspace: createInTeam("project", "path"),
	searchProjectsForWorkspace: onWorkspace("project", "read", {
		path: true,
		response: "list",
		scope: "filter",
	}),
	addCustomFieldSettingForProject: actOn({
		on: "project",
		verb: "create",
		resource: "custom_field_setting",
	}),
	removeCustomFieldSettingForProject: actOn({
		on: "project",
		verb: "delete",
		resource: "custom_field_setting",
	}),
	getTaskCountsForProject: actOn({ on: "project", verb: "read" }),
	addMembersForProject: actOn({
		on: "project",
		verb: "manage_members",
		response: "item",
	}),
	removeMembersForProject: actOn({
		on: "project",
		verb: "manage_members",
		response: "item",
	}),
	addFollowersForProject: actOn({
		on: "project",
		verb: "update",
		response: "item",
		shaping: "checked",
	}),
	removeFollowersForProject: actOn({
		on: "project",
		verb: "update",
		response: "item",
		shaping: "checked",
	}),
	projectSaveAsTemplate: saveAsTemplateRule,
	rollupProject: actOn({
		on: "project",
		verb: "update",
		shaping: "checked",
	}),
	// Rates
	getRates: listBy("rate", [{ query: "parent", types: ["project", "portfolio"] }], {
		required: true,
		shared: true,
	}),
	createRate: onBody({
		resource: "rate",
		verb: "create",
		field: "parent",
		types: ["project", "portfolio"],
	}),
	// Reactions
	getReactionsOnObject: listBy(
		"reaction",
		[{ query: "target", types: ["story", "task", "status_update", "project_brief"] }],
		{ required: true, shared: true },
	),
	// Records
	getRecordsForTable: listUnder({
		under: "table",
		items: "record",
		shared: true,
	}),
	searchRecordsForWorkspace: onWorkspace("record", "read", {
		path: true,
		response: "list",
		scope: "filter",
	}),
	createRecord: onWorkspace("record", "create", { response: "item" }),
	// Roles
	getRoles: onWorkspace("role", "read", { query: "workspace", response: "list", scope: "filter" }),
	createRole: onWorkspace("role", "create", { body: "workspace", response: "item" }),
	// Rules
	triggerRule: onBody({
		resource: "rule",
		verb: "trigger",
		field: "resource",
		types: ["task", "project"],
		response: "raw",
	}),
	// Sections
	getSectionsForProject: listUnder({ under: "project", items: "section" }),
	createSectionForProject: createUnder({ under: "project", item: "section" }),
	addTaskForSection: addTaskForSectionRule,
	insertSectionForProject: insertSectionRule,
	// Status updates
	getStatusesForObject: listBy(
		"status_update",
		[{ query: "parent", types: ["project", "portfolio", "goal"] }],
		{ required: true, shared: true },
	),
	createStatusForObject: onBody({
		resource: "status_update",
		verb: "create",
		field: "parent",
		types: ["project", "portfolio", "goal"],
		shared: true,
	}),
	// Stories
	getStoriesForTask: listUnder({ under: "task", items: "story", shared: true }),
	createStoryForTask: createUnder({
		under: "task",
		item: "story",
		shared: true,
	}),
	getStoriesForRecord: listUnder({
		under: "record",
		items: "story",
		shared: true,
	}),
	createStoryForRecord: createUnder({
		under: "record",
		item: "story",
		shared: true,
	}),
	getStoriesForGoal: listUnder({ under: "goal", items: "story", shared: true }),
	createStoryForGoal: createUnder({
		under: "goal",
		item: "story",
		shared: true,
	}),
	// Tables
	getTablesForWorkspace: onWorkspace("table", "read", {
		path: true,
		response: "list",
		scope: "filter",
	}),
	createTable: onWorkspace("table", "create", { body: "workspace", response: "item" }),
	addCustomFieldSettingForTable: actOn({
		on: "table",
		verb: "create",
		resource: "custom_field_setting",
	}),
	removeCustomFieldSettingForTable: actOn({
		on: "table",
		verb: "delete",
		resource: "custom_field_setting",
	}),
	getCustomFieldSettingsForTableLegacy: listUnder({
		under: "table",
		items: "custom_field_setting",
		shared: true,
	}),
	getCustomFieldSettingsForTable: listUnder({
		under: "table",
		items: "custom_field_setting",
		shared: true,
	}),
	// Tags
	getTags: onWorkspace("tag", "read", { query: "workspace", response: "list", scope: "filter" }),
	createTag: onWorkspace("tag", "create", { body: "workspace", response: "item" }),
	getTagsForTask: listUnder({ under: "task", items: "tag" }),
	getTagsForWorkspace: onWorkspace("tag", "read", {
		path: true,
		response: "list",
		scope: "filter",
	}),
	createTagForWorkspace: onWorkspace("tag", "create", { path: true, response: "item" }),
	// Task templates
	getTaskTemplates: listBy("task_template", [{ query: "project", types: ["project"] }], {
		shared: true,
	}),
	instantiateTask: instantiateTaskRule,
	// Tasks
	getTasks: listBy("task", [
		{ query: "project", types: ["project"] },
		{ query: "section", types: ["section"] },
		{ query: "tag", types: ["tag"] },
	]),
	createTask: createTaskRule("body"),
	duplicateTask: actOn({ on: "task", verb: "create", shaping: "opaque" }),
	getTasksForProject: listUnder({ under: "project", items: "task" }),
	getTasksForSection: listUnder({ under: "section", items: "task" }),
	getTasksForTag: listUnder({ under: "tag", items: "task" }),
	getTasksForUserTaskList: listUnder({
		under: "user_task_list",
		items: "task",
	}),
	getSubtasksForTask: listUnder({ under: "task", items: "task" }),
	createSubtaskForTask: createTaskRule("path"),
	setParentForTask: setParentRule,
	getDependenciesForTask: listUnder({ under: "task", items: "task" }),
	addDependenciesForTask: taskLinkRule("dependencies"),
	removeDependenciesForTask: taskLinkRule("dependencies"),
	getDependentsForTask: listUnder({ under: "task", items: "task" }),
	addDependentsForTask: taskLinkRule("dependents"),
	removeDependentsForTask: taskLinkRule("dependents"),
	addProjectForTask: addProjectRule,
	removeProjectForTask: removeProjectRule,
	addTagForTask: tagApplyRule,
	removeTagForTask: tagApplyRule,
	addFollowersForTask: actOn({
		on: "task",
		verb: "update",
		response: "item",
		shaping: "checked",
	}),
	removeFollowerForTask: actOn({
		on: "task",
		verb: "update",
		response: "item",
		shaping: "checked",
	}),
	rollupTask: actOn({ on: "task", verb: "update", shaping: "checked" }),
	getTaskForCustomID: taskForCustomIdRule,
	searchTasksForWorkspace: naming(
		onWorkspace("task", "read", {
			path: true,
			response: "list",
			scope: "filter",
		}),
		searchNamed,
	),
	// Team memberships
	getTeamMemberships: listBy("team_membership", [{ query: "team", types: ["team"] }], {
		shared: true,
	}),
	getTeamMembershipsForTeam: listUnder({
		under: "team",
		items: "team_membership",
		shared: true,
	}),
	getTeamMembershipsForUser: forUserRule("team_membership"),
	// Teams
	createTeam: onWorkspace("team", "create", { body: "organization", response: "item" }),
	getTeamsForWorkspace: onWorkspace("team", "read", {
		path: true,
		response: "list",
		scope: "filter",
	}),
	getTeamsForUser: forUserRule("team", { workspaceQuery: "organization" }),
	addUserForTeam: actOn({ on: "team", verb: "manage_members" }),
	removeUserForTeam: actOn({ on: "team", verb: "manage_members" }),
	getUsersForTeam: listUnder({ under: "team", items: "user", shared: true }),
	// Time periods
	getTimePeriods: onWorkspace("time_period", "read", {
		query: "workspace",
		response: "list",
		scope: "filter",
	}),
	// Time tracking categories
	getTimeTrackingEntriesForTimeTrackingCategory: listUnder({
		under: "time_tracking_category",
		items: "time_tracking_entry",
	}),
	getTimeTrackingCategories: onWorkspace("time_tracking_category", "read", {
		query: "workspace",
		response: "list",
		scope: "filter",
	}),
	createTimeTrackingCategory: onWorkspace("time_tracking_category", "create", {
		body: "workspace",
		response: "item",
	}),
	// Time tracking entries
	getTimeTrackingEntriesForTask: listUnder({
		under: "task",
		items: "time_tracking_entry",
		shared: true,
	}),
	createTimeTrackingEntry: createUnder({
		under: "task",
		item: "time_tracking_entry",
		shared: true,
	}),
	getTimeTrackingEntries: listBy("time_tracking_entry", [
		{ query: "task", types: ["task"] },
		{ query: "portfolio", types: ["portfolio"] },
	]),
	// Timesheet approval statuses
	getTimesheetApprovalStatuses: onWorkspace("timesheet_approval_status", "read", {
		query: "workspace",
		response: "list",
		scope: "filter",
	}),
	createTimesheetApprovalStatus: onWorkspace("timesheet_approval_status", "create", {
		body: "workspace",
		response: "item",
	}),
	// Typeahead
	typeaheadForWorkspace: typeaheadRule,
	// User task lists
	getUserTaskListForUser: forUserRule("user_task_list", { one: true }),
	// Users
	getUsers: listBy("user", [{ query: "team", types: ["team"] }], { shared: true }),
	getUser: userRule("read"),
	updateUser: userRule("update"),
	getFavoritesForUser: forUserRule("user", { mixed: true }),
	getUsersForWorkspace: onWorkspace("user", "read", {
		path: true,
		response: "list",
		scope: "filter",
	}),
	getUserForWorkspace: userRule("read"),
	updateUserForWorkspace: userRule("update"),
	// Webhooks
	getWebhooks: listBy("webhook", [{ query: "resource", types: WEBHOOK_TYPES }]),
	createWebhook: onBody({
		resource: "webhook",
		verb: "create",
		field: "resource",
		types: WEBHOOK_TYPES,
		shared: true,
	}),
	// Workspace memberships
	getWorkspaceMembershipsForUser: forUserRule("workspace_membership"),
	getWorkspaceMembershipsForWorkspace: onWorkspace("workspace_membership", "read", {
		path: true,
		response: "list",
		scope: "filter",
	}),
	// Workspaces
	getWorkspaces: getWorkspacesRule,
	getWorkspace: onWorkspace("workspace", "read", { path: true, response: "item" }),
	updateWorkspace: onWorkspace("workspace", "update", { path: true, response: "item" }),
	addUserForWorkspace: onWorkspace("workspace", "manage_members", { path: true }),
	removeUserForWorkspace: onWorkspace("workspace", "manage_members", { path: true }),
	getWorkspaceEvents: eventsRule((ctx) => Promise.resolve(ctx.workspace(pathGid(ctx)))),
} satisfies Record<Exclude<OperationId, DerivedId>, OperationRule>;

/** Operation classification, one entry per Asana operation. */
const CLASSIFICATION = Object.fromEntries(
	Object.entries(OPERATIONS).flatMap(([id, spec]) => {
		const rule = (RULES as Partial<Record<string, OperationRule>>)[id] ?? objectRule(spec);
		return rule === undefined ? [] : [[id, rule] as const];
	}),
) as Record<OperationId, OperationRule>;

/** The classification of an operation. */
function ruleFor(operationId: OperationId): OperationRule {
	return CLASSIFICATION[operationId];
}

export { CLASSIFICATION, ruleFor };
export type { OperationRule, ScopeKind };
