// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

/**
 * The vocabulary of policy actions: every Asana resource type asana-gate
 * knows, and the verbs that are meaningful for each. An action is written
 * `<resource>:<verb>` in a policy file.
 */
const RESOURCE_VERBS = {
	task: [
		"read",
		"create",
		"update",
		"delete",
		"complete",
		"move",
		"add_project",
		"remove_project",
		"set_parent",
		"assign",
	],
	story: ["read", "create", "update", "delete"],
	attachment: ["read", "create", "delete"],
	section: ["read", "create", "update", "delete", "reorder"],
	project: ["read", "create", "update", "delete", "archive", "manage_members"],
	project_brief: ["read", "create", "update", "delete"],
	status_update: ["read", "create", "delete"],
	project_membership: ["read"],
	project_template: ["read", "create", "delete"],
	task_template: ["read", "delete"],
	custom_field: ["read", "create", "update", "delete"],
	custom_field_setting: ["read", "create", "delete"],
	custom_type: ["read"],
	tag: ["read", "create", "update", "delete", "apply"],
	portfolio: ["read", "create", "update", "delete", "manage_members"],
	portfolio_membership: ["read"],
	project_portfolio_setting: ["read", "update"],
	goal: ["read", "create", "update", "delete"],
	goal_relationship: ["read", "create", "update", "delete"],
	membership: ["read", "create", "update", "delete"],
	team: ["read", "create", "update", "manage_members"],
	team_membership: ["read"],
	workspace: ["read", "update", "manage_members"],
	workspace_membership: ["read"],
	user: ["read", "update"],
	user_task_list: ["read"],
	notification: ["read", "update"],
	job: ["read"],
	webhook: ["read", "create", "update", "delete"],
	event: ["read"],
	export: ["create"],
	organization_export: ["read", "create"],
	audit_log: ["read"],
	ai_studio_usage: ["read"],
	agent: ["read"],
	access_request: ["read", "create", "update"],
	allocation: ["read", "create", "update", "delete"],
	budget: ["read", "create", "update", "delete"],
	rate: ["read", "create", "update", "delete"],
	role: ["read", "create", "update", "delete"],
	record: ["read", "create", "update", "delete"],
	table: ["read", "create", "update", "delete"],
	rule: ["trigger"],
	ooo_entry: ["read", "create", "update", "delete"],
	time_period: ["read"],
	time_tracking_category: ["read", "create", "update", "delete"],
	time_tracking_entry: ["read", "create", "update", "delete"],
	timesheet_approval_status: ["read", "create", "update"],
	reaction: ["read"],
} as const satisfies Record<string, readonly string[]>;

/** A resource type that policy actions can name. */
type Resource = keyof typeof RESOURCE_VERBS;

/** A verb that some resource supports. */
type Verb = (typeof RESOURCE_VERBS)[Resource][number];

/** A concrete `<resource>:<verb>` action. */
type Action = {
	[R in Resource]: `${R}:${(typeof RESOURCE_VERBS)[R][number]}`;
}[Resource];

/** All resource types, in declaration order. */
const RESOURCES = Object.keys(RESOURCE_VERBS) as Resource[];

/** Every concrete action, in resource declaration order. */
const ALL_ACTIONS: readonly Action[] = RESOURCES.flatMap((resource) =>
	RESOURCE_VERBS[resource].map((verb) => `${resource}:${verb}` as Action),
);

const ACTION_SET: ReadonlySet<string> = new Set(ALL_ACTIONS);

/** Whether `value` is a known resource type. */
function isResource(value: string): value is Resource {
	return Object.hasOwn(RESOURCE_VERBS, value);
}

/** Whether `value` is a known concrete action. */
function isAction(value: string): value is Action {
	return ACTION_SET.has(value);
}

/** The `<resource>:<verb>` action for a pair known to be valid. */
function actionOf(resource: Resource, verb: Verb): Action {
	return `${resource}:${verb}` as Action;
}

/** The verb part of an action. */
function verbOf(action: Action): Verb {
	return action.slice(action.indexOf(":") + 1) as Verb;
}

/** The `<resource>:read` action, when the resource has one. */
function readActionOf(resource: Resource): Action | undefined {
	const action = `${resource}:read`;
	return isAction(action) ? action : undefined;
}

/**
 * Verbs grouped by tier. `read` is the `read` tier; `write` adds every verb
 * that creates or modifies content; `admin` adds the destructive and
 * membership-management verbs.
 */
const VERB_TIERS = {
	read: new Set<Verb>(["read"]),
	write: new Set<Verb>([
		"create",
		"update",
		"complete",
		"move",
		"add_project",
		"remove_project",
		"set_parent",
		"assign",
		"apply",
		"reorder",
		"trigger",
	]),
	admin: new Set<Verb>(["delete", "archive", "manage_members"]),
} as const;

/**
 * Body members of an `update` that stand for a verb of their own. Updating
 * such a member requires that verb instead of `update`, and a `fields`
 * allowlist naming the member grants that verb.
 */
const FIELD_VERBS: Partial<Record<Resource, Readonly<Record<string, Verb>>>> = {
	task: { completed: "complete", assignee: "assign" },
	project: { archived: "archive" },
};

/**
 * Actions that are never granted by a group (`read` / `write` / `admin`) or
 * a wildcard (`*`, `webhook:*`, `*:create`): they move data out of Asana or
 * out of asana-gate's control, so a policy must name them literally.
 */
const EXPLICIT_ONLY_ACTIONS: ReadonlySet<Action> = new Set<Action>([
	"webhook:create",
	"webhook:update",
	"export:create",
	"organization_export:create",
	"organization_export:read",
	"audit_log:read",
]);

export {
	actionOf,
	ALL_ACTIONS,
	EXPLICIT_ONLY_ACTIONS,
	FIELD_VERBS,
	isAction,
	isResource,
	readActionOf,
	RESOURCE_VERBS,
	RESOURCES,
	VERB_TIERS,
	verbOf,
};
export type { Action, Resource, Verb };
