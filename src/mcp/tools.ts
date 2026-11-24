// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import * as z from "zod";

import { ASANA_BATCH_ACTIONS, BATCH_LIMIT } from "../asana/client.ts";
import { type QueryValue, renderQuery } from "../asana/query.ts";
import { ruleFor } from "../catalog/classification.ts";
import type { HttpMethod } from "../catalog/operation-spec.ts";
import { type OperationId, OPERATIONS } from "../catalog/operations.gen.ts";
import type { Action } from "../catalog/resources.ts";
import { SCHEMAS } from "../catalog/schemas.gen.ts";
import type { ExecuteOptions, Gate, GateRequest, GateResponse } from "../gate/gate.ts";
import { isObject } from "../gate/objects.ts";
import { fillPath } from "../gate/router.ts";
import { grantedActions } from "../policy/evaluate.ts";
import { GidSchema } from "../policy/schema.ts";
import type { Policy } from "../policy/types.ts";

/** How a tool appears on the command line: `asana-gate <noun> <verb> [positionals] [--flags]`. */
interface CliShape {
	readonly noun: string;
	readonly verb: string;
	/** Input members taken from positional arguments, in order. */
	readonly positional?: readonly string[];
	/** Flag names for input members whose key reads badly as a flag (`section_gid` → `section`). */
	readonly flags?: Readonly<Record<string, string>>;
}

/** A curated MCP tool: a schema plus the gated request it stands for. */
interface ToolSpec<S extends z.ZodObject<z.ZodRawShape>> {
	readonly name: string;
	/** The Asana operation its requests are. */
	readonly operation: OperationId;
	/** The actions its requests may need; the server lists the tool only when the policy could allow one of them. */
	readonly needs: readonly Action[];
	readonly title: string;
	readonly description: string;
	readonly input: S;
	readonly readOnly?: boolean;
	readonly destructive?: boolean;
	readonly idempotent?: boolean;
	/** The command-line form; `false` for tools the CLI expresses otherwise. */
	readonly cli: CliShape | false;
	readonly request: (args: z.output<S>, policy: Policy) => ToolRequest;
}

/** What a tool asks of the gate: a request, and the requests answered together with it, each under its name. */
interface ToolRequest extends GateRequest {
	readonly include?: Readonly<Record<string, GateRequest>>;
}

/**
 * Sends a tool's request through the gate. The requests it includes follow
 * once it succeeded, each gated like a request of its own, and their `data`
 * joins its own under their names; `null` stands for a part the policy or
 * Asana refused, so the answer says it is missing rather than empty. Nobody
 * is asked to confirm a part: one that needs it is refused.
 */
async function answer(
	gate: Gate,
	{ include, ...request }: ToolRequest,
	options: ExecuteOptions = {},
): Promise<GateResponse> {
	const response = await gate.execute(request, options);
	const { data } = response.body;
	if (include === undefined || response.status >= 400 || !isObject(data)) {
		return response;
	}
	const parts = await Promise.all(
		Object.entries(include).map(async ([key, part]) => {
			const { status, body } = await gate.execute(part);
			return [key, status < 400 ? (body.data ?? null) : null] as const;
		}),
	);
	return {
		status: response.status,
		body: { ...response.body, data: { ...data, ...Object.fromEntries(parts) } },
	};
}

type AnyToolSpec = ToolSpec<z.ZodObject<z.ZodRawShape>>;

type QueryInput = Record<string, QueryValue>;

/** Drops undefined members of a body. */
function toBody(input: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

const Gid = GidSchema;
const StringList = z.array(z.string());
const GidList = z.array(Gid);
const OptFields = StringList.optional().describe(
	"The fields each object carries besides its gid, in place of the default ones (Asana opt_fields, dotted paths allowed)",
);
/** A count Asana takes from 1 to 100. */
const upTo100 = (): z.ZodOptional<z.ZodNumber> => z.number().int().min(1).max(100).optional();
const Limit = upTo100().describe("Page size (1-100)");
const Offset = z
	.string()
	.optional()
	.describe("Pagination token: next_page.offset of the previous page");
const Workspace = Gid.optional().describe("Workspace gid; defaults to the policy's workspace");
const CustomFields = z
	.record(z.string(), z.unknown())
	.optional()
	.describe("Custom field values keyed by field gid (enum option gid, text, number, …)");
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "YYYY-MM-DD");
const DateTime = z.string().describe("ISO 8601 date-time");
const User = z.string().min(1).describe('User gid, email or "me"');
const USERS = 'User gids, emails or "me"';
const Users = StringList.min(1).describe(USERS);
const UserFilter = StringList.optional().describe(USERS);
/** An option of an enum custom field, as it is created. */
const EnumOption = z.strictObject({
	name: z.string(),
	color: z.string().optional(),
	enabled: z.boolean().optional(),
});
/** What a project template's date variable, and its role, are given when a project is made of it. */
const TemplateDate = z.strictObject({ gid: Gid, value: DateOnly });
const TemplateRole = z.strictObject({ gid: Gid, value: User });
/** As many notifications as Asana marks in one request. */
const NotificationGids = GidList.min(1).max(50).describe("Notification gids (1-50)");
/** Every count `GET /projects/{gid}/task_counts` answers when asked for it. */
const TASK_COUNTS = Object.keys(SCHEMAS.TaskCountResponse);

const SortBy = z.enum(["due_date", "created_at", "completed_at", "likes", "modified_at"]);
const TaskSubtype = z.enum(["default_task", "milestone", "approval"]);
const PrivacySetting = z.enum(["public_to_workspace", "private_to_team", "private"]);
const AccessLevel = z.enum(["admin", "editor", "commenter", "viewer"]);
const StatusType = z.enum([
	"on_track",
	"at_risk",
	"off_track",
	"on_hold",
	"complete",
	"achieved",
	"partial",
	"missed",
	"dropped",
]);
const DefaultView = z.enum(["list", "board", "calendar", "timeline"]);
const TypeaheadType = z.enum([
	"task",
	"project",
	"user",
	"tag",
	"team",
	"portfolio",
	"goal",
	"custom_field",
	"project_template",
	"agent",
	"actor",
]);

const taskFields = {
	name: z.string().optional(),
	notes: z.string().optional().describe("Plain-text description"),
	html_notes: z.string().optional().describe("Rich-text description (<body>…</body>)"),
	assignee: z.string().optional().describe('User gid, email, "me", or null to unassign'),
	assignee_section: Gid.nullable()
		.optional()
		.describe("Section gid in the assignee's My Tasks, or null to clear"),
	due_on: DateOnly.nullable().optional().describe("YYYY-MM-DD, or null to clear"),
	due_at: DateTime.nullable().optional().describe("ISO 8601 date-time, or null to clear"),
	start_on: DateOnly.nullable().optional().describe("YYYY-MM-DD, or null to clear"),
	start_at: DateTime.nullable().optional().describe("ISO 8601 date-time, or null to clear"),
	completed: z.boolean().optional(),
	approval_status: z
		.enum(["pending", "approved", "rejected", "changes_requested"])
		.optional()
		.describe("Of an approval task; every status but pending completes it"),
	custom_fields: CustomFields,
};

/** The input of `asana_create_task`, and of each task of `asana_create_tasks`. */
const NewTask = z.object({
	...taskFields,
	name: z.string(),
	resource_subtype: TaskSubtype.optional(),
	projects: GidList.optional().describe("Project gids to add the task to"),
	section: Gid.optional().describe("Section gid within the first project (requires projects)"),
	parent: Gid.optional().describe("Parent task gid (creates a subtask)"),
	workspace: Workspace,
	tags: GidList.optional(),
	followers: StringList.optional(),
});

/** What a project carries, as it is created or updated. */
const projectFields = {
	name: z.string().optional(),
	notes: z.string().optional(),
	html_notes: z.string().optional(),
	color: z.string().nullable().optional(),
	due_on: DateOnly.nullable().optional(),
	start_on: DateOnly.nullable().optional(),
	public: z.boolean().optional(),
	privacy_setting: PrivacySetting.optional(),
	default_access_level: AccessLevel.optional().describe("What a member added later may do"),
	default_view: DefaultView.optional(),
	owner: z.string().nullable().optional().describe('User gid, email, "me", or null for none'),
	custom_fields: CustomFields,
};

/** What a comment carries, on a task or a record. */
const commentFields = {
	text: z.string().optional().describe("Plain-text comment"),
	html_text: z.string().optional().describe("Rich-text comment (<body>…</body>)"),
	is_pinned: z.boolean().optional(),
};

/** A custom field put on a project or a table, where it shows among the fields already there. */
const fieldSetting = {
	custom_field: Gid.describe("Custom field gid"),
	is_important: z.boolean().optional().describe("Whether the field shows prominently"),
	insert_before: Gid.optional().describe("Custom field setting gid to put it before"),
	insert_after: Gid.optional().describe("Custom field setting gid to put it after"),
};

const CreateTaskInput = NewTask
	// A section belongs to a project; without one the task would silently land outside it.
	.refine((task) => task.section === undefined || (task.projects?.length ?? 0) > 0, {
		message: "section needs projects: give the section's project first",
		path: ["section"],
	});

/** The input of `asana_update_task`, and of each task of `asana_update_tasks`. */
const UpdateTaskInput = z.object({
	task_gid: Gid,
	...taskFields,
	assignee: z.string().nullable().optional(),
});

const page = (args: { limit?: number; offset?: string; opt_fields?: string[] }): QueryInput => ({
	limit: args.limit,
	offset: args.offset,
	opt_fields: args.opt_fields,
});

const get = (path: string, query: QueryInput = {}): GateRequest => ({
	method: "GET",
	path,
	query: renderQuery(query),
});
const send = (method: HttpMethod, path: string, body: Record<string, unknown>): GateRequest => ({
	method,
	path,
	body: toBody(body),
});

/** What tells where a subtask stands, for a task read together with its subtasks. */
const SUBTASK_FIELDS = ["name", "completed", "assignee.name", "due_on"];
/** As many comments as a task is read with when no number is given. */
const COMMENTS = 10;

/** The counts of a project's tasks; Asana answers no count it is not asked for. */
const taskCounts = (project: string): GateRequest =>
	get(`/projects/${project}/task_counts`, { opt_fields: TASK_COUNTS });

/**
 * A tool as written: `needs` defaults to the action its operation is
 * classified as, and `request` to the operation itself, with the input
 * members named like its path parameters in the path and the others as its
 * query (`GET`) or body.
 */
type ToolDefinition<S extends z.ZodObject<z.ZodRawShape>> = Omit<ToolSpec<S>, "needs" | "request"> &
	Partial<Pick<ToolSpec<S>, "needs" | "request">>;

/** The request of `operation` built from a tool's input, as {@link ToolDefinition} describes. */
function operationRequest(operation: OperationId): (args: object, policy: Policy) => GateRequest {
	const { method, path, pathParams, queryParams } = OPERATIONS[operation];
	const inPath: readonly string[] = pathParams;
	const ofWorkspace = inPath.includes("workspace_gid");
	// A parameter Asana writes with a dot is the member written with an underscore: `projects.any` is `projects_any`.
	const named = new Map(queryParams.map((param) => [param.replaceAll(".", "_"), param]));
	return (args, policy) => {
		const { workspace, ...rest } = args as Record<string, unknown>;
		// A path below the workspace is below the governed one unless the input names it.
		const input = ofWorkspace
			? { workspace_gid: workspace ?? policy.workspace, ...rest }
			: (args as Record<string, unknown>);
		// The path members are gids, which the input schema checks.
		const filled = fillPath(path, input as Record<string, string>);
		const members = Object.fromEntries(
			Object.entries(input).filter(([key]) => !inPath.includes(key)),
		);
		if (method === "GET") {
			const query = Object.entries(members).map(([key, value]) => [named.get(key) ?? key, value]);
			return get(filled, Object.fromEntries(query) as QueryInput);
		}
		return method === "DELETE" ? { method, path: filled } : send(method, filled, members);
	};
}

/** The action `operation` is classified as, which a tool's requests need. */
function classifiedNeeds(operation: OperationId): readonly Action[] {
	const { action } = ruleFor(operation);
	if (action === undefined) {
		throw new Error(`${operation} has no action of its own: name the tool's needs`);
	}
	return [action];
}

/**
 * `spec` refusing an argument its input does not declare, by name: dropped,
 * the argument would let the call run as something else than was asked.
 */
const strict = (spec: AnyToolSpec): AnyToolSpec => ({ ...spec, input: spec.input.strict() });

function tool<S extends z.ZodObject<z.ZodRawShape>>(definition: ToolDefinition<S>): AnyToolSpec {
	const spec: ToolSpec<S> = {
		...definition,
		needs: definition.needs ?? classifiedNeeds(definition.operation),
		request: definition.request ?? operationRequest(definition.operation),
	};
	return strict(spec);
}

/** The request of `asana_create_task`: the fields with the task's projects, section membership, parent or workspace. */
function createTask(
	{ projects, section, parent, workspace, ...fields }: z.output<typeof CreateTaskInput>,
	policy: Policy,
): GateRequest {
	const [first] = projects ?? [];
	// Without a project or a parent, Asana needs the workspace (an empty `projects` names none).
	const placed = first !== undefined || parent !== undefined;
	return send("POST", "/tasks", {
		...fields,
		projects,
		parent,
		memberships:
			section !== undefined && first !== undefined ? [{ project: first, section }] : undefined,
		workspace: placed ? workspace : (workspace ?? policy.workspace),
	});
}

/** A request as one action of Asana's Batch API. */
const asAction = (request: GateRequest): Record<string, unknown> => ({
	method: request.method.toLowerCase(),
	relative_path: request.path,
	data: request.body,
});

/** A `POST /batch` of `actions`; the client sends them to Asana {@link ASANA_BATCH_ACTIONS} at a time. */
const batch = (actions: readonly Record<string, unknown>[]): GateRequest => ({
	method: "POST",
	path: "/batch",
	body: { actions },
});

/** What the generic tools say about batches. */
const BATCH_NOTE = `POST /batch takes up to ${BATCH_LIMIT} actions, sent to Asana ${ASANA_BATCH_ACTIONS} at a time.`;

/** What a batch tool answers with, for a batch of `thing`s. */
const batchResult = (thing: string): string =>
	`The result holds one status_code and body per ${thing}, in order; Asana may fail some while the others succeed. A policy refusal of any ${thing} refuses the whole call before anything runs, and its message names the ${thing} (actions[i]).`;

/**
 * The batch form of a tool (`create` → `create-many`): up to
 * {@link BATCH_LIMIT} of its inputs in one `POST /batch`.
 */
function manyOf(single: AnyToolSpec, name: string): AnyToolSpec {
	if (single.cli === false) {
		throw new Error(`${single.name} has no command-line form to batch`);
	}
	const { noun, verb } = single.cli;
	const things = `${noun}s`;
	return tool({
		name,
		operation: "createBatchRequest",
		needs: single.needs,
		cli: { noun, verb: `${verb}-many` },
		title: `${single.title}s`,
		description: `${verb.charAt(0).toUpperCase()}${verb.slice(1)}s up to ${BATCH_LIMIT} ${things} in one call, each as ${single.name} would. ${batchResult(noun)}`,
		...(single.idempotent !== undefined && { idempotent: single.idempotent }),
		input: z.object({
			[things]: z
				.array(single.input)
				.min(1)
				.max(BATCH_LIMIT)
				.describe(`The ${things} to ${verb}, each like the input of ${single.name}`),
		}),
		request: (input, policy) =>
			batch(
				(input[things] as Record<string, unknown>[]).map((item) =>
					asAction(single.request(item, policy)),
				),
			),
	});
}

const createTaskTool = tool({
	name: "asana_create_task",
	operation: "createTask",
	cli: { noun: "task", verb: "create" },
	title: "Create task",
	description:
		"Creates a task in one or more projects (optionally in a section), under a parent task, or unhomed in the workspace.",
	input: CreateTaskInput,
	request: createTask,
});

const updateTaskTool = tool({
	name: "asana_update_task",
	operation: "updateTask",
	// Completing and assigning are actions of their own.
	needs: ["task:update", "task:complete", "task:assign"],
	cli: { noun: "task", verb: "update", positional: ["task_gid"] },
	title: "Update task",
	description:
		"Updates fields of a task. Completing (completed, or the approval_status of an approval task) needs task:complete, assigning needs task:assign; other fields need task:update (possibly limited to an allowlist).",
	idempotent: true,
	input: UpdateTaskInput,
});

const createRecord = tool({
	name: "asana_create_record",
	operation: "createRecord",
	cli: { noun: "record", verb: "create" },
	title: "Create record",
	description: "Creates a record in a table.",
	input: z.object({
		name: z.string(),
		table: Gid,
		custom_fields: CustomFields,
		unique_fingerprint: z
			.string()
			.optional()
			.describe("A key of your own; Asana refuses a second record with the same key in the table"),
	}),
});

const updateRecord = tool({
	name: "asana_update_record",
	operation: "updateRecord",
	cli: { noun: "record", verb: "update", positional: ["record_gid"] },
	title: "Update record",
	description: "Updates the name or the custom field values of a record.",
	idempotent: true,
	input: z.object({ record_gid: Gid, name: z.string().optional(), custom_fields: CustomFields }),
});

/** Every curated tool, registered in this order. */
const TOOLS: readonly AnyToolSpec[] = [
	// ---- tasks ----
	tool({
		name: "asana_search_tasks",
		operation: "searchTasksForWorkspace",
		cli: { noun: "task", verb: "search" },
		title: "Search tasks",
		description:
			"Full-text and filtered task search in the workspace (Asana Search API; paid plans only). Results are limited to tasks the policy makes visible.",
		readOnly: true,
		input: z.object({
			text: z.string().optional().describe("Free-text query"),
			resource_subtype: TaskSubtype.optional(),
			assignee_any: UserFilter,
			created_by_any: UserFilter,
			followers_any: UserFilter,
			projects_any: GidList.optional(),
			sections_any: GidList.optional(),
			tags_any: GidList.optional(),
			completed: z.boolean().optional(),
			is_subtask: z.boolean().optional(),
			due_on: DateOnly.optional(),
			due_on_before: DateOnly.optional(),
			due_on_after: DateOnly.optional(),
			created_on_before: DateOnly.optional(),
			created_on_after: DateOnly.optional(),
			created_at_before: DateTime.optional(),
			created_at_after: DateTime.optional(),
			completed_on_before: DateOnly.optional(),
			completed_on_after: DateOnly.optional(),
			completed_at_before: DateTime.optional(),
			completed_at_after: DateTime.optional(),
			modified_on_after: DateOnly.optional(),
			modified_at_after: DateTime.optional(),
			sort_by: SortBy.optional(),
			sort_ascending: z.boolean().optional(),
			limit: Limit,
			opt_fields: OptFields,
		}),
	}),
	tool({
		name: "asana_list_tasks",
		operation: "getTasks",
		cli: { noun: "task", verb: "list" },
		title: "List tasks",
		description:
			"Lists tasks in a project, a section, with a tag, or assigned to a user (one of project, section, tag or assignee is required). Each task carries allowed_actions.",
		readOnly: true,
		input: z.object({
			project: Gid.optional(),
			section: Gid.optional(),
			tag: Gid.optional(),
			assignee: z.string().optional().describe('User gid, email or "me" (needs workspace)'),
			workspace: Workspace,
			completed_since: z
				.string()
				.optional()
				.describe('ISO date-time, or "now" for incomplete tasks only'),
			modified_since: DateTime.optional(),
			limit: Limit,
			offset: Offset,
			opt_fields: OptFields,
		}),
		request: (args, policy) =>
			get("/tasks", {
				project: args.project,
				section: args.section,
				tag: args.tag,
				assignee: args.assignee,
				workspace:
					args.assignee === undefined ? args.workspace : (args.workspace ?? policy.workspace),
				completed_since: args.completed_since,
				modified_since: args.modified_since,
				...page(args),
			}),
	}),
	tool({
		name: "asana_get_task",
		operation: "getTask",
		cli: { noun: "task", verb: "get", positional: ["task_gid"] },
		title: "Get task",
		description:
			"Reads one task with its full fields and allowed_actions and, when asked, its latest comments and its direct subtasks in the same call. A part that cannot be read is null.",
		readOnly: true,
		input: z.object({
			task_gid: Gid,
			include_comments: z
				.boolean()
				.optional()
				.describe("Also answer the latest comments, newest first, as comments"),
			comment_limit: upTo100().describe(`How many comments (${COMMENTS} by default)`),
			include_subtasks: z
				.boolean()
				.optional()
				.describe("Also answer the direct subtasks, as subtasks"),
			opt_fields: OptFields,
		}),
		request: (args) => ({
			...get(`/tasks/${args.task_gid}`, { opt_fields: args.opt_fields }),
			include: {
				...(args.include_comments === true && {
					comments: get(`/tasks/${args.task_gid}/stories`, {
						resource_subtype: "comment_added",
						sort_ascending: false,
						limit: args.comment_limit ?? COMMENTS,
					}),
				}),
				...(args.include_subtasks === true && {
					subtasks: get(`/tasks/${args.task_gid}/subtasks`, { opt_fields: SUBTASK_FIELDS }),
				}),
			},
		}),
	}),
	createTaskTool,
	updateTaskTool,
	manyOf(createTaskTool, "asana_create_tasks"),
	manyOf(updateTaskTool, "asana_update_tasks"),
	tool({
		name: "asana_delete_task",
		operation: "deleteTask",
		cli: { noun: "task", verb: "delete", positional: ["task_gid"] },
		title: "Delete task",
		description: "Deletes a task (it moves to the trash in Asana).",
		destructive: true,
		input: z.object({ task_gid: Gid }),
	}),
	tool({
		name: "asana_list_subtasks",
		operation: "getSubtasksForTask",
		cli: { noun: "task", verb: "subtasks", positional: ["task_gid"] },
		title: "List subtasks",
		description: "Lists the direct subtasks of a task.",
		readOnly: true,
		input: z.object({ task_gid: Gid, limit: Limit, offset: Offset, opt_fields: OptFields }),
	}),
	tool({
		name: "asana_create_subtask",
		operation: "createSubtaskForTask",
		cli: false,
		title: "Create subtask",
		description:
			"Creates a subtask under a task; it inherits the parent's scope unless projects are given.",
		input: NewTask.omit({ parent: true, section: true, workspace: true, followers: true }).extend({
			parent_task_gid: Gid,
		}),
		request: ({ parent_task_gid, ...fields }) =>
			send("POST", `/tasks/${parent_task_gid}/subtasks`, fields),
	}),
	tool({
		name: "asana_set_task_parent",
		operation: "setParentForTask",
		cli: { noun: "task", verb: "set-parent", positional: ["task_gid"] },
		title: "Set task parent",
		description: "Makes a task a subtask of another (or a top-level task with parent null).",
		idempotent: true,
		input: z.object({
			task_gid: Gid,
			parent: Gid.nullable().describe("New parent task gid, or null"),
			insert_after: Gid.optional(),
			insert_before: Gid.optional(),
		}),
	}),
	tool({
		name: "asana_add_task_to_project",
		operation: "addProjectForTask",
		cli: { noun: "task", verb: "add-project", positional: ["task_gid"] },
		title: "Add task to project",
		description: "Multi-homes a task into a project, optionally into a section.",
		idempotent: true,
		input: z.object({
			task_gid: Gid,
			project: Gid,
			section: Gid.optional(),
			insert_before: Gid.optional(),
			insert_after: Gid.optional(),
		}),
	}),
	tool({
		name: "asana_remove_task_from_project",
		operation: "removeProjectForTask",
		cli: { noun: "task", verb: "remove-project", positional: ["task_gid"] },
		title: "Remove task from project",
		description: "Removes a task from one of its projects.",
		idempotent: true,
		input: z.object({ task_gid: Gid, project: Gid }),
	}),
	tool({
		name: "asana_move_task_to_section",
		operation: "addTaskForSection",
		cli: {
			noun: "task",
			verb: "move",
			positional: ["task_gid"],
			flags: { section_gid: "section" },
		},
		title: "Move task to section",
		description:
			"Moves a task into a section of a project it belongs to (needs task:move at both ends).",
		idempotent: true,
		input: z.object({
			section_gid: Gid,
			task_gid: Gid,
			insert_before: Gid.optional(),
			insert_after: Gid.optional(),
		}),
		request: ({ section_gid, task_gid, ...body }) =>
			send("POST", `/sections/${section_gid}/addTask`, { task: task_gid, ...body }),
	}),
	tool({
		name: "asana_add_tag_to_task",
		operation: "addTagForTask",
		cli: { noun: "task", verb: "tag", positional: ["task_gid"] },
		title: "Add tag to task",
		description: "Applies a tag to a task (needs tag:apply in the task's scope).",
		idempotent: true,
		input: z.object({ task_gid: Gid, tag: Gid }),
	}),
	tool({
		name: "asana_remove_tag_from_task",
		operation: "removeTagForTask",
		cli: { noun: "task", verb: "untag", positional: ["task_gid"] },
		title: "Remove tag from task",
		description: "Removes a tag from a task (needs tag:apply in the task's scope).",
		idempotent: true,
		input: z.object({ task_gid: Gid, tag: Gid }),
	}),
	tool({
		name: "asana_add_task_dependencies",
		operation: "addDependenciesForTask",
		cli: { noun: "task", verb: "add-dependencies", positional: ["task_gid"] },
		title: "Add task dependencies",
		description: "Marks tasks this task depends on; every referenced task must be visible.",
		idempotent: true,
		input: z.object({ task_gid: Gid, dependencies: GidList.min(1) }),
	}),
	tool({
		name: "asana_remove_task_dependencies",
		operation: "removeDependenciesForTask",
		cli: { noun: "task", verb: "remove-dependencies", positional: ["task_gid"] },
		title: "Remove task dependencies",
		description: "Removes dependencies of a task.",
		idempotent: true,
		input: z.object({ task_gid: Gid, dependencies: GidList.min(1) }),
	}),
	tool({
		name: "asana_add_task_dependents",
		operation: "addDependentsForTask",
		cli: { noun: "task", verb: "add-dependents", positional: ["task_gid"] },
		title: "Add task dependents",
		description: "Marks tasks that depend on this task; every referenced task must be visible.",
		idempotent: true,
		input: z.object({ task_gid: Gid, dependents: GidList.min(1) }),
	}),
	tool({
		name: "asana_remove_task_dependents",
		operation: "removeDependentsForTask",
		cli: { noun: "task", verb: "remove-dependents", positional: ["task_gid"] },
		title: "Remove task dependents",
		description: "Removes dependents of a task.",
		idempotent: true,
		input: z.object({ task_gid: Gid, dependents: GidList.min(1) }),
	}),
	tool({
		name: "asana_add_task_followers",
		operation: "addFollowersForTask",
		cli: { noun: "task", verb: "add-followers", positional: ["task_gid"] },
		title: "Add task followers",
		description: "Adds followers (collaborators) to a task.",
		idempotent: true,
		input: z.object({ task_gid: Gid, followers: Users }),
	}),
	tool({
		name: "asana_remove_task_followers",
		operation: "removeFollowerForTask",
		cli: { noun: "task", verb: "remove-followers", positional: ["task_gid"] },
		title: "Remove task followers",
		description: "Removes followers (collaborators) from a task.",
		idempotent: true,
		input: z.object({ task_gid: Gid, followers: Users }),
	}),
	// ---- stories (comments) ----
	tool({
		name: "asana_list_task_stories",
		operation: "getStoriesForTask",
		cli: { noun: "task", verb: "comments", positional: ["task_gid"] },
		title: "List task stories",
		description: "Lists the comments and activity (stories) of a task.",
		readOnly: true,
		input: z.object({
			task_gid: Gid,
			created_after: DateTime.optional(),
			resource_subtype: z.enum(["comment_added"]).optional().describe("Comments only"),
			sort_ascending: z.boolean().optional().describe("Oldest first (the default) or newest first"),
			limit: Limit,
			offset: Offset,
			opt_fields: OptFields,
		}),
	}),
	tool({
		name: "asana_create_comment",
		operation: "createStoryForTask",
		cli: { noun: "task", verb: "comment", positional: ["task_gid"] },
		title: "Comment on task",
		description: "Adds a comment (story) to a task.",
		input: z.object({ task_gid: Gid, ...commentFields }),
	}),
	tool({
		name: "asana_update_story",
		operation: "updateStory",
		cli: { noun: "comment", verb: "update", positional: ["story_gid"] },
		title: "Update story",
		description: "Edits a comment.",
		idempotent: true,
		input: z.object({ story_gid: Gid, ...commentFields }),
	}),
	tool({
		name: "asana_delete_story",
		operation: "deleteStory",
		cli: { noun: "comment", verb: "delete", positional: ["story_gid"] },
		title: "Delete story",
		description: "Deletes a comment.",
		destructive: true,
		input: z.object({ story_gid: Gid }),
	}),
	// ---- attachments ----
	tool({
		name: "asana_list_attachments",
		operation: "getAttachmentsForObject",
		cli: { noun: "attachment", verb: "list" },
		title: "List attachments",
		description: "Lists the attachments of a task or project brief.",
		readOnly: true,
		input: z.object({ parent: Gid, limit: Limit, offset: Offset, opt_fields: OptFields }),
	}),
	tool({
		name: "asana_get_attachment",
		operation: "getAttachment",
		cli: { noun: "attachment", verb: "get", positional: ["attachment_gid"] },
		title: "Get attachment",
		description: "Reads an attachment, including its download URL.",
		readOnly: true,
		input: z.object({ attachment_gid: Gid, opt_fields: OptFields }),
	}),
	tool({
		name: "asana_create_attachment",
		operation: "createAttachmentForObject",
		cli: { noun: "attachment", verb: "create" },
		title: "Create attachment",
		description:
			"Attaches an external URL, or uploads a small file given as base64, to a task or project brief.",
		input: z.object({
			parent: Gid,
			url: z.url().optional().describe("External link to attach"),
			name: z.string().optional().describe("Display name (required with url)"),
			file_name: z.string().optional().describe("File name when uploading content"),
			content_base64: z.string().optional().describe("File content, base64-encoded"),
			content_type: z.string().optional().describe("MIME type of the uploaded content"),
		}),
		request: (args) => {
			const form = new FormData();
			form.set("parent", args.parent);
			if (args.url !== undefined) {
				form.set("resource_subtype", "external");
				form.set("url", args.url);
				form.set("name", args.name ?? args.url);
			} else if (args.content_base64 !== undefined) {
				const bytes = Buffer.from(args.content_base64, "base64");
				form.set(
					"file",
					new Blob([bytes], { type: args.content_type ?? "application/octet-stream" }),
					args.file_name ?? "attachment",
				);
			}
			// The gate shapes and checks the members the form carries, then sends them as shaped.
			const members =
				args.url === undefined
					? { ...(args.content_base64 !== undefined && { file: args.file_name ?? "attachment" }) }
					: { resource_subtype: "external", url: args.url, name: args.name ?? args.url };
			return {
				method: "POST",
				path: "/attachments",
				body: { parent: args.parent, ...members },
				multipart: form,
			};
		},
	}),
	tool({
		name: "asana_delete_attachment",
		operation: "deleteAttachment",
		cli: { noun: "attachment", verb: "delete", positional: ["attachment_gid"] },
		title: "Delete attachment",
		description: "Deletes an attachment.",
		destructive: true,
		input: z.object({ attachment_gid: Gid }),
	}),
	// ---- projects and sections ----
	tool({
		name: "asana_list_projects",
		operation: "getProjects",
		cli: { noun: "project", verb: "list" },
		title: "List projects",
		description:
			"Lists projects of the workspace or of a team. Each project carries allowed_actions.",
		readOnly: true,
		input: z.object({
			workspace: Workspace,
			team: Gid.optional(),
			archived: z.boolean().optional(),
			limit: Limit,
			offset: Offset,
			opt_fields: OptFields,
		}),
		request: (args, policy) =>
			get("/projects", {
				workspace: args.team === undefined ? (args.workspace ?? policy.workspace) : args.workspace,
				team: args.team,
				archived: args.archived,
				...page(args),
			}),
	}),
	tool({
		name: "asana_get_project",
		operation: "getProject",
		cli: { noun: "project", verb: "get", positional: ["project_gid"] },
		title: "Get project",
		description:
			"Reads one project and, when asked, its sections and its task counts in the same call. A part that cannot be read is null.",
		readOnly: true,
		input: z.object({
			project_gid: Gid,
			include_sections: z.boolean().optional().describe("Also answer the sections, as sections"),
			include_task_counts: z
				.boolean()
				.optional()
				.describe("Also answer the counts of its tasks, hidden ones too, as task_counts"),
			opt_fields: OptFields,
		}),
		request: (args) => ({
			...get(`/projects/${args.project_gid}`, { opt_fields: args.opt_fields }),
			include: {
				...(args.include_sections === true && {
					sections: get(`/projects/${args.project_gid}/sections`, { limit: 100 }),
				}),
				...(args.include_task_counts === true && { task_counts: taskCounts(args.project_gid) }),
			},
		}),
	}),
	tool({
		name: "asana_create_project",
		operation: "createProject",
		cli: { noun: "project", verb: "create" },
		title: "Create project",
		description: "Creates a project in the workspace (and a team, in organizations).",
		input: z.object({
			...projectFields,
			name: z.string(),
			workspace: Workspace,
			team: Gid.optional(),
		}),
		request: (args, policy) =>
			send("POST", "/projects", { ...args, workspace: args.workspace ?? policy.workspace }),
	}),
	tool({
		name: "asana_update_project",
		operation: "updateProject",
		needs: ["project:update", "project:archive"],
		cli: { noun: "project", verb: "update", positional: ["project_gid"] },
		title: "Update project",
		description: "Updates fields of a project; archiving needs project:archive.",
		idempotent: true,
		input: z.object({
			project_gid: Gid,
			...projectFields,
			icon: z.string().nullable().optional(),
			archived: z.boolean().optional(),
		}),
	}),
	tool({
		name: "asana_delete_project",
		operation: "deleteProject",
		cli: { noun: "project", verb: "delete", positional: ["project_gid"] },
		title: "Delete project",
		description: "Deletes a project.",
		destructive: true,
		input: z.object({ project_gid: Gid }),
	}),
	tool({
		name: "asana_get_project_task_counts",
		operation: "getTaskCountsForProject",
		cli: { noun: "project", verb: "task-counts", positional: ["project_gid"] },
		title: "Get project task counts",
		description:
			"Counts the tasks and milestones of a project, complete and incomplete; the tasks the policy hides are counted too.",
		readOnly: true,
		input: z.object({ project_gid: Gid }),
		request: ({ project_gid }) => taskCounts(project_gid),
	}),
	tool({
		name: "asana_add_project_members",
		operation: "addMembersForProject",
		cli: { noun: "project", verb: "add-members", positional: ["project_gid"] },
		title: "Add project members",
		description: "Adds members to a project (needs project:manage_members).",
		idempotent: true,
		input: z.object({ project_gid: Gid, members: Users }),
	}),
	tool({
		name: "asana_remove_project_members",
		operation: "removeMembersForProject",
		cli: { noun: "project", verb: "remove-members", positional: ["project_gid"] },
		title: "Remove project members",
		description:
			"Removes members from a project (needs project:manage_members). Removing its owner leaves the project without one.",
		idempotent: true,
		input: z.object({
			project_gid: Gid,
			members: GidList.min(1).describe('User gids; Asana does not take "me" here'),
		}),
	}),
	tool({
		name: "asana_add_custom_field_to_project",
		operation: "addCustomFieldSettingForProject",
		cli: { noun: "project", verb: "add-custom-field", positional: ["project_gid"] },
		title: "Add custom field to project",
		description:
			"Puts a custom field on a project, for its tasks to carry (needs custom_field_setting:create).",
		input: z.object({ project_gid: Gid, ...fieldSetting }),
	}),
	tool({
		name: "asana_remove_custom_field_from_project",
		operation: "removeCustomFieldSettingForProject",
		cli: { noun: "project", verb: "remove-custom-field", positional: ["project_gid"] },
		title: "Remove custom field from project",
		description: "Takes a custom field off a project (needs custom_field_setting:delete).",
		idempotent: true,
		input: z.object({ project_gid: Gid, custom_field: Gid }),
	}),
	tool({
		name: "asana_list_sections",
		operation: "getSectionsForProject",
		cli: { noun: "section", verb: "list", flags: { project_gid: "project" } },
		title: "List sections",
		description: "Lists the sections of a project.",
		readOnly: true,
		input: z.object({ project_gid: Gid, limit: Limit, offset: Offset, opt_fields: OptFields }),
	}),
	tool({
		name: "asana_create_section",
		operation: "createSectionForProject",
		cli: { noun: "section", verb: "create", flags: { project_gid: "project" } },
		title: "Create section",
		description: "Creates a section in a project.",
		input: z.object({
			project_gid: Gid,
			name: z.string(),
			insert_before: Gid.optional(),
			insert_after: Gid.optional(),
		}),
	}),
	tool({
		name: "asana_update_section",
		operation: "updateSection",
		cli: { noun: "section", verb: "update", positional: ["section_gid"] },
		title: "Update section",
		description: "Renames a section.",
		idempotent: true,
		input: z.object({ section_gid: Gid, name: z.string() }),
	}),
	tool({
		name: "asana_delete_section",
		operation: "deleteSection",
		cli: { noun: "section", verb: "delete", positional: ["section_gid"] },
		title: "Delete section",
		description: "Deletes an empty section.",
		destructive: true,
		input: z.object({ section_gid: Gid }),
	}),
	tool({
		name: "asana_list_status_updates",
		operation: "getStatusesForObject",
		cli: { noun: "status", verb: "list" },
		title: "List status updates",
		description: "Lists the status updates of a project, portfolio or goal.",
		readOnly: true,
		input: z.object({ parent: Gid, limit: Limit, offset: Offset, opt_fields: OptFields }),
	}),
	tool({
		name: "asana_create_status_update",
		operation: "createStatusForObject",
		cli: { noun: "status", verb: "create", flags: { status_type: "type" } },
		title: "Create status update",
		description: "Posts a status update on a project, portfolio or goal.",
		input: z.object({
			parent: Gid,
			text: z.string(),
			status_type: StatusType,
			title: z.string().optional(),
			html_text: z.string().optional(),
		}),
	}),
	// ---- workspace, people, tags, portfolios ----
	tool({
		name: "asana_get_workspace",
		operation: "getWorkspace",
		cli: { noun: "workspace", verb: "get" },
		title: "Get workspace",
		description: "Reads the workspace the policy governs.",
		readOnly: true,
		input: z.object({ opt_fields: OptFields }),
	}),
	tool({
		name: "asana_get_me",
		operation: "getUser",
		cli: { noun: "user", verb: "me" },
		title: "Get current user",
		description: "Reads the user the access token belongs to.",
		readOnly: true,
		input: z.object({ opt_fields: OptFields }),
		request: (args) => get("/users/me", { opt_fields: args.opt_fields }),
	}),
	tool({
		name: "asana_list_users",
		operation: "getUsers",
		cli: { noun: "user", verb: "list" },
		title: "List users",
		description: "Lists the users of the workspace or of a team.",
		readOnly: true,
		input: z.object({
			workspace: Workspace,
			team: Gid.optional(),
			limit: Limit,
			offset: Offset,
			opt_fields: OptFields,
		}),
		request: (args, policy) =>
			get("/users", {
				workspace: args.team === undefined ? (args.workspace ?? policy.workspace) : undefined,
				team: args.team,
				...page(args),
			}),
	}),
	tool({
		name: "asana_get_user",
		operation: "getUser",
		cli: { noun: "user", verb: "get", positional: ["user"] },
		title: "Get user",
		description: "Reads a user by gid or email.",
		readOnly: true,
		input: z.object({ user: User, opt_fields: OptFields }),
		request: (args, policy) =>
			get(`/users/${encodeURIComponent(args.user)}`, {
				workspace: policy.workspace,
				opt_fields: args.opt_fields,
			}),
	}),
	tool({
		name: "asana_list_user_teams",
		operation: "getTeamsForUser",
		cli: { noun: "user", verb: "teams", positional: ["user"] },
		title: "List a user's teams",
		description: "Lists the teams a user belongs to.",
		readOnly: true,
		input: z.object({ user: User, limit: Limit, offset: Offset, opt_fields: OptFields }),
		request: ({ user, ...rest }, policy) =>
			get(`/users/${encodeURIComponent(user)}/teams`, {
				organization: policy.workspace,
				...page(rest),
			}),
	}),
	tool({
		name: "asana_list_teams",
		operation: "getTeamsForWorkspace",
		cli: { noun: "team", verb: "list" },
		title: "List teams",
		description: "Lists the teams of the workspace (organizations only).",
		readOnly: true,
		input: z.object({ workspace: Workspace, limit: Limit, offset: Offset, opt_fields: OptFields }),
	}),
	tool({
		name: "asana_get_team",
		operation: "getTeam",
		cli: { noun: "team", verb: "get", positional: ["team_gid"] },
		title: "Get team",
		description: "Reads one team.",
		readOnly: true,
		input: z.object({ team_gid: Gid, opt_fields: OptFields }),
	}),
	tool({
		name: "asana_list_tags",
		operation: "getTagsForWorkspace",
		cli: { noun: "tag", verb: "list" },
		title: "List tags",
		description: "Lists the tags of the workspace.",
		readOnly: true,
		input: z.object({ workspace: Workspace, limit: Limit, offset: Offset, opt_fields: OptFields }),
	}),
	tool({
		name: "asana_create_tag",
		operation: "createTagForWorkspace",
		cli: { noun: "tag", verb: "create" },
		title: "Create tag",
		description: "Creates a tag in the workspace.",
		input: z.object({
			name: z.string(),
			workspace: Workspace,
			color: z.string().optional(),
			notes: z.string().optional(),
		}),
	}),
	tool({
		name: "asana_list_portfolios",
		operation: "getPortfolios",
		cli: { noun: "portfolio", verb: "list" },
		title: "List portfolios",
		description:
			"Lists the portfolios of the workspace owned by a user (the token owner by default).",
		readOnly: true,
		input: z.object({
			workspace: Workspace,
			owner: z.string().optional().describe('User gid or "me"'),
			limit: Limit,
			offset: Offset,
			opt_fields: OptFields,
		}),
		request: (args, policy) =>
			get("/portfolios", {
				workspace: args.workspace ?? policy.workspace,
				owner: args.owner ?? "me",
				...page(args),
			}),
	}),
	tool({
		name: "asana_get_portfolio",
		operation: "getPortfolio",
		cli: { noun: "portfolio", verb: "get", positional: ["portfolio_gid"] },
		title: "Get portfolio",
		description: "Reads one portfolio.",
		readOnly: true,
		input: z.object({ portfolio_gid: Gid, opt_fields: OptFields }),
	}),
	tool({
		name: "asana_list_portfolio_items",
		operation: "getItemsForPortfolio",
		cli: { noun: "portfolio", verb: "items", positional: ["portfolio_gid"] },
		title: "List portfolio items",
		description: "Lists the projects and portfolios inside a portfolio.",
		readOnly: true,
		input: z.object({ portfolio_gid: Gid, limit: Limit, offset: Offset, opt_fields: OptFields }),
	}),
	tool({
		name: "asana_list_custom_fields",
		operation: "getCustomFieldsForWorkspace",
		cli: { noun: "custom-field", verb: "list" },
		title: "List custom fields",
		description: "Lists the custom field definitions of the workspace.",
		readOnly: true,
		input: z.object({ workspace: Workspace, limit: Limit, offset: Offset, opt_fields: OptFields }),
	}),
	tool({
		name: "asana_create_custom_field",
		operation: "createCustomField",
		cli: { noun: "custom-field", verb: "create", flags: { resource_subtype: "type" } },
		title: "Create custom field",
		description:
			"Creates a custom field definition in the workspace, to put on a project or a table.",
		input: z.object({
			name: z.string(),
			resource_subtype: z.enum([
				"text",
				"number",
				"date",
				"enum",
				"multi_enum",
				"people",
				"reference",
			]),
			description: z.string().optional(),
			enum_options: z
				.array(EnumOption)
				.optional()
				.describe("The options of an enum or multi_enum field"),
			precision: z.number().int().min(0).optional().describe("Decimal places of a number field"),
			format: z
				.enum(["currency", "identifier", "percentage", "custom", "duration", "none"])
				.optional()
				.describe("How a number field shows"),
			currency_code: z.string().optional().describe("ISO 4217 code, with the currency format"),
			custom_label: z.string().optional().describe("The label of the custom format"),
			custom_label_position: z.enum(["prefix", "suffix"]).optional(),
		}),
		request: (args, policy) =>
			send("POST", "/custom_fields", { ...args, workspace: policy.workspace }),
	}),
	// ---- templates ----
	tool({
		name: "asana_list_task_templates",
		operation: "getTaskTemplates",
		cli: { noun: "task-template", verb: "list" },
		title: "List task templates",
		description: "Lists the task templates of a project.",
		readOnly: true,
		input: z.object({ project: Gid, limit: Limit, offset: Offset, opt_fields: OptFields }),
	}),
	tool({
		name: "asana_create_task_from_template",
		operation: "instantiateTask",
		cli: { noun: "task-template", verb: "instantiate", positional: ["task_template_gid"] },
		title: "Create task from template",
		description:
			"Starts creating a task from a task template, in the template's project (needs task_template:read and task:create there). Asana answers with the job doing it, not the task.",
		input: z.object({
			task_template_gid: Gid,
			name: z.string().optional().describe("Name of the task; the template's by default"),
		}),
	}),
	tool({
		name: "asana_create_project_from_template",
		operation: "instantiateProject",
		cli: { noun: "project-template", verb: "instantiate", positional: ["project_template_gid"] },
		title: "Create project from template",
		description:
			"Starts creating a project from a project template, which asana_typeahead finds (needs project_template:read, and project:create in the team given or else where the template lives). Asana answers with the job doing it, not the project.",
		input: z.object({
			project_template_gid: Gid,
			name: z.string().min(1),
			team: Gid.optional().describe("Team of the project"),
			privacy_setting: PrivacySetting.optional(),
			is_strict: z
				.boolean()
				.optional()
				.describe("Fail when a date variable of the template is given no date"),
			requested_dates: z
				.array(TemplateDate)
				.optional()
				.describe("A date for each date variable of the template, by the variable's gid"),
			requested_roles: z
				.array(TemplateRole)
				.optional()
				.describe("A user for each role of the template, by the role's gid"),
		}),
	}),
	// ---- notifications ----
	tool({
		name: "asana_list_notifications",
		operation: "getNotificationsForUser",
		cli: { noun: "notification", verb: "list" },
		title: "List notifications",
		description:
			"Lists the Inbox notifications of the token's user; one shows only when the policy shows every object it is about.",
		readOnly: true,
		input: z.object({ limit: Limit, offset: Offset, opt_fields: OptFields }),
		request: (args, policy) =>
			get("/users/me/notifications", { workspace: policy.workspace, ...page(args) }),
	}),
	tool({
		name: "asana_mark_notifications_read",
		operation: "markNotificationsReadForUser",
		cli: { noun: "notification", verb: "mark-read" },
		title: "Mark notifications read",
		description: "Marks Inbox notifications of the token's user as read.",
		idempotent: true,
		input: z.object({ notification_gids: NotificationGids }),
		request: ({ notification_gids }, policy) =>
			send("POST", "/users/me/notifications/markRead", {
				workspace: policy.workspace,
				notification_gids,
			}),
	}),
	tool({
		name: "asana_mark_notifications_unread",
		operation: "markNotificationsUnreadForUser",
		cli: { noun: "notification", verb: "mark-unread" },
		title: "Mark notifications unread",
		description: "Marks Inbox notifications of the token's user as unread.",
		idempotent: true,
		input: z.object({ notification_gids: NotificationGids }),
		request: ({ notification_gids }, policy) =>
			send("POST", "/users/me/notifications/markUnread", {
				workspace: policy.workspace,
				notification_gids,
			}),
	}),
	// ---- AI Teammates ----
	tool({
		name: "asana_list_agents",
		operation: "getAgentsForWorkspace",
		cli: { noun: "agent", verb: "list" },
		title: "List AI Teammates",
		description: "Lists the AI Teammates (agents) of the workspace.",
		readOnly: true,
		input: z.object({ limit: Limit, offset: Offset, opt_fields: OptFields }),
	}),
	tool({
		name: "asana_get_agent",
		operation: "getAgent",
		cli: { noun: "agent", verb: "get", positional: ["agent_gid"] },
		title: "Get AI Teammate",
		description: "Reads one AI Teammate (agent).",
		readOnly: true,
		input: z.object({ agent_gid: Gid, opt_fields: OptFields }),
	}),
	// ---- tables and records ----
	tool({
		name: "asana_list_tables",
		operation: "getTablesForWorkspace",
		cli: { noun: "table", verb: "list" },
		title: "List tables",
		description: "Lists the tables of the workspace.",
		readOnly: true,
		input: z.object({ limit: Limit, offset: Offset, opt_fields: OptFields }),
	}),
	tool({
		name: "asana_get_table",
		operation: "getTable",
		cli: { noun: "table", verb: "get", positional: ["table_gid"] },
		title: "Get table",
		description: "Reads one table.",
		readOnly: true,
		input: z.object({ table_gid: Gid, opt_fields: OptFields }),
	}),
	tool({
		name: "asana_list_table_custom_fields",
		operation: "getCustomFieldSettingsForTable",
		cli: { noun: "table", verb: "custom-fields", positional: ["table_gid"] },
		title: "List table custom fields",
		description: "Lists the custom field settings of a table: the fields its records carry.",
		readOnly: true,
		input: z.object({ table_gid: Gid, limit: Limit, offset: Offset, opt_fields: OptFields }),
	}),
	tool({
		name: "asana_create_table",
		operation: "createTable",
		cli: { noun: "table", verb: "create" },
		title: "Create table",
		description: "Creates a table in the workspace.",
		input: z.object({ name: z.string() }),
		request: (args, policy) => send("POST", "/tables", { ...args, workspace: policy.workspace }),
	}),
	tool({
		name: "asana_update_table",
		operation: "updateTable",
		cli: { noun: "table", verb: "update", positional: ["table_gid"] },
		title: "Update table",
		description: "Renames a table.",
		idempotent: true,
		input: z.object({ table_gid: Gid, name: z.string() }),
	}),
	tool({
		name: "asana_add_custom_field_to_table",
		operation: "addCustomFieldSettingForTable",
		cli: { noun: "table", verb: "add-custom-field", positional: ["table_gid"] },
		title: "Add custom field to table",
		description:
			"Puts a custom field on a table, for its records to carry (needs custom_field_setting:create).",
		input: z.object({ table_gid: Gid, ...fieldSetting }),
	}),
	tool({
		name: "asana_remove_custom_field_from_table",
		operation: "removeCustomFieldSettingForTable",
		cli: { noun: "table", verb: "remove-custom-field", positional: ["table_gid"] },
		title: "Remove custom field from table",
		description: "Takes a custom field off a table (needs custom_field_setting:delete).",
		idempotent: true,
		input: z.object({ table_gid: Gid, custom_field: Gid }),
	}),
	tool({
		name: "asana_list_records",
		operation: "getRecordsForTable",
		cli: { noun: "record", verb: "list", flags: { table_gid: "table" } },
		title: "List records",
		description: "Lists the records of a table.",
		readOnly: true,
		input: z.object({
			table_gid: Gid,
			modified_since: DateTime.optional(),
			sort_by: z.enum(["created_at"]).optional(),
			limit: Limit,
			offset: Offset,
			opt_fields: OptFields,
		}),
	}),
	tool({
		name: "asana_search_records",
		operation: "searchRecordsForWorkspace",
		cli: { noun: "record", verb: "search" },
		title: "Search records",
		description:
			"Searches the records of the workspace by name and filters, in every table unless the filters name some; Asana wants at least one filter. Results are limited to records the policy makes visible.",
		readOnly: true,
		input: z.object({
			text: z.string().optional().describe("Text in the record's name"),
			tables_any: GidList.optional(),
			tables_not: GidList.optional(),
			tables_all: GidList.optional(),
			teams_any: GidList.optional(),
			followers_any: UserFilter,
			followers_not: UserFilter,
			created_on: DateOnly.optional(),
			created_on_before: DateOnly.optional(),
			created_on_after: DateOnly.optional(),
			created_at_before: DateTime.optional(),
			created_at_after: DateTime.optional(),
			sort_by: z.enum(["created_at", "modified_at"]).optional(),
			sort_ascending: z.boolean().optional(),
			limit: Limit,
			opt_fields: OptFields,
		}),
	}),
	tool({
		name: "asana_get_record",
		operation: "getRecord",
		cli: { noun: "record", verb: "get", positional: ["record_gid"] },
		title: "Get record",
		description: "Reads one record.",
		readOnly: true,
		input: z.object({ record_gid: Gid, opt_fields: OptFields }),
	}),
	createRecord,
	updateRecord,
	manyOf(createRecord, "asana_create_records"),
	manyOf(updateRecord, "asana_update_records"),
	tool({
		name: "asana_delete_record",
		operation: "deleteRecord",
		cli: { noun: "record", verb: "delete", positional: ["record_gid"] },
		title: "Delete record",
		description: "Deletes a record.",
		destructive: true,
		input: z.object({ record_gid: Gid }),
	}),
	tool({
		name: "asana_list_record_stories",
		operation: "getStoriesForRecord",
		cli: { noun: "record", verb: "comments", positional: ["record_gid"] },
		title: "List record stories",
		description: "Lists the comments and activity (stories) of a record.",
		readOnly: true,
		input: z.object({ record_gid: Gid, limit: Limit, offset: Offset, opt_fields: OptFields }),
	}),
	tool({
		name: "asana_create_record_comment",
		operation: "createStoryForRecord",
		cli: { noun: "record", verb: "comment", positional: ["record_gid"] },
		title: "Comment on record",
		description: "Adds a comment (story) to a record.",
		input: z.object({ record_gid: Gid, ...commentFields }),
	}),
	tool({
		name: "asana_typeahead",
		operation: "typeaheadForWorkspace",
		cli: { noun: "find", verb: "", positional: ["query"], flags: { resource_type: "type" } },
		title: "Typeahead search",
		description:
			"Finds objects by name prefix (tasks, projects, users, tags, teams, portfolios, goals, custom fields, project templates, AI Teammates as agent, people and AI Teammates together as actor).",
		readOnly: true,
		input: z.object({
			resource_type: TypeaheadType,
			query: z.string(),
			count: upTo100().describe("Results to return (1-100)"),
			opt_fields: OptFields,
		}),
	}),
];

/** The curated tools the policy could ever allow: those needing an action it grants ({@link grantedActions}). */
function exposedTools(policy: Policy): AnyToolSpec[] {
	const allowed = grantedActions(policy);
	return TOOLS.filter((spec) => spec.needs.some((action) => allowed.has(action)));
}

export { answer, BATCH_NOTE, exposedTools, TOOLS };
export type { AnyToolSpec, CliShape, ToolRequest, ToolSpec };
