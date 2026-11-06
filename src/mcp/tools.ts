// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import * as z from "zod";

import { ASANA_BATCH_ACTIONS, BATCH_LIMIT } from "../asana/client.ts";
import { type QueryValue, renderQuery } from "../asana/query.ts";
import { ruleFor } from "../catalog/classification.ts";
import type { HttpMethod } from "../catalog/operation-spec.ts";
import { type OperationId, OPERATIONS } from "../catalog/operations.gen.ts";
import type { Action } from "../catalog/resources.ts";
import type { GateRequest } from "../gate/gate.ts";
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
	readonly request: (args: z.output<S>, policy: Policy) => GateRequest;
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
	"Extra fields to include in each object (Asana opt_fields, dotted paths allowed)",
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

const SortBy = z.enum(["due_date", "created_at", "completed_at", "likes", "modified_at"]);
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
]);

const taskFields = {
	name: z.string().optional(),
	notes: z.string().optional().describe("Plain-text description"),
	html_notes: z.string().optional().describe("Rich-text description (<body>…</body>)"),
	assignee: z.string().optional().describe('User gid, email, "me", or null to unassign'),
	due_on: DateOnly.nullable().optional().describe("YYYY-MM-DD, or null to clear"),
	due_at: DateTime.nullable().optional().describe("ISO 8601 date-time, or null to clear"),
	start_on: DateOnly.nullable().optional().describe("YYYY-MM-DD, or null to clear"),
	start_at: DateTime.nullable().optional().describe("ISO 8601 date-time, or null to clear"),
	completed: z.boolean().optional(),
	custom_fields: CustomFields,
};

/** The input of `asana_create_task`, and of each task of `asana_create_tasks`. */
const NewTask = z.object({
	...taskFields,
	name: z.string(),
	projects: GidList.optional().describe("Project gids to add the task to"),
	section: Gid.optional().describe("Section gid within the first project (requires projects)"),
	parent: Gid.optional().describe("Parent task gid (creates a subtask)"),
	workspace: Workspace,
	tags: GidList.optional(),
	followers: StringList.optional(),
});

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

/**
 * A tool as written: `needs` defaults to the action its operation is
 * classified as, and `request` to the operation itself, with the input
 * members named like its path parameters in the path and the others as its
 * query (`GET`) or body.
 */
type ToolDefinition<S extends z.ZodObject<z.ZodRawShape>> = Omit<ToolSpec<S>, "needs" | "request"> &
	Partial<Pick<ToolSpec<S>, "needs" | "request">>;

/** The request of `operation` built from a tool's input, as {@link ToolDefinition} describes. */
function operationRequest(operation: OperationId): (args: object) => GateRequest {
	const { method, path, pathParams } = OPERATIONS[operation];
	const inPath: readonly string[] = pathParams;
	return (args) => {
		const input = args as Record<string, unknown>;
		// The path members are gids, which the input schema checks.
		const filled = fillPath(path, input as Record<string, string>);
		const members = Object.fromEntries(
			Object.entries(input).filter(([key]) => !inPath.includes(key)),
		);
		if (method === "GET") {
			return get(filled, members as QueryInput);
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

function tool<S extends z.ZodObject<z.ZodRawShape>>(definition: ToolDefinition<S>): AnyToolSpec {
	const spec: ToolSpec<S> = {
		...definition,
		needs: definition.needs ?? classifiedNeeds(definition.operation),
		request: definition.request ?? operationRequest(definition.operation),
	};
	return spec;
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

/** What a batch tool answers with. */
const BATCH_RESULT =
	"The result holds one status_code and body per task, in order; Asana may fail some while the others succeed. A policy refusal of any task refuses the whole call before anything runs, and its message names the task (actions[i]).";

/** The batch form of a task tool (`create` → `create-many`): up to {@link BATCH_LIMIT} of its inputs in one `POST /batch`. */
function manyOf(single: AnyToolSpec, name: string): AnyToolSpec {
	if (single.cli === false) {
		throw new Error(`${single.name} has no command-line form to batch`);
	}
	const { verb } = single.cli;
	return {
		name,
		operation: "createBatchRequest",
		needs: single.needs,
		cli: { noun: single.cli.noun, verb: `${verb}-many` },
		title: `${single.title}s`,
		description: `${verb.charAt(0).toUpperCase()}${verb.slice(1)}s up to ${BATCH_LIMIT} tasks in one call, each as ${single.name} would. ${BATCH_RESULT}`,
		...(single.idempotent !== undefined && { idempotent: single.idempotent }),
		input: z.object({
			tasks: z
				.array(single.input)
				.min(1)
				.max(BATCH_LIMIT)
				.describe(`The tasks to ${verb}, each like the input of ${single.name}`),
		}),
		request: ({ tasks }, policy) =>
			batch(
				(tasks as Record<string, unknown>[]).map((task) => asAction(single.request(task, policy))),
			),
	};
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
		"Updates fields of a task. Completing needs task:complete, assigning needs task:assign; other fields need task:update (possibly limited to an allowlist).",
	idempotent: true,
	input: UpdateTaskInput,
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
			assignee_any: StringList.optional().describe('User gids, emails or "me"'),
			projects_any: GidList.optional(),
			sections_any: GidList.optional(),
			tags_any: GidList.optional(),
			completed: z.boolean().optional(),
			is_subtask: z.boolean().optional(),
			due_on_before: DateOnly.optional(),
			due_on_after: DateOnly.optional(),
			modified_on_after: DateOnly.optional(),
			created_on_after: DateOnly.optional(),
			sort_by: SortBy.optional(),
			sort_ascending: z.boolean().optional(),
			limit: Limit,
			opt_fields: OptFields,
		}),
		request: (args, policy) =>
			get(`/workspaces/${policy.workspace}/tasks/search`, {
				text: args.text,
				"assignee.any": args.assignee_any,
				"projects.any": args.projects_any,
				"sections.any": args.sections_any,
				"tags.any": args.tags_any,
				completed: args.completed,
				is_subtask: args.is_subtask,
				"due_on.before": args.due_on_before,
				"due_on.after": args.due_on_after,
				"modified_on.after": args.modified_on_after,
				"created_on.after": args.created_on_after,
				sort_by: args.sort_by,
				sort_ascending: args.sort_ascending,
				limit: args.limit,
				opt_fields: args.opt_fields,
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
		description: "Reads one task with its full fields and allowed_actions.",
		readOnly: true,
		input: z.object({ task_gid: Gid, opt_fields: OptFields }),
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
	// ---- stories (comments) ----
	tool({
		name: "asana_list_task_stories",
		operation: "getStoriesForTask",
		cli: { noun: "task", verb: "comments", positional: ["task_gid"] },
		title: "List task stories",
		description: "Lists the comments and activity (stories) of a task.",
		readOnly: true,
		input: z.object({ task_gid: Gid, limit: Limit, offset: Offset, opt_fields: OptFields }),
	}),
	tool({
		name: "asana_create_comment",
		operation: "createStoryForTask",
		cli: { noun: "task", verb: "comment", positional: ["task_gid"] },
		title: "Comment on task",
		description: "Adds a comment (story) to a task.",
		input: z.object({
			task_gid: Gid,
			text: z.string().optional().describe("Plain-text comment"),
			html_text: z.string().optional().describe("Rich-text comment (<body>…</body>)"),
			is_pinned: z.boolean().optional(),
		}),
	}),
	tool({
		name: "asana_update_story",
		operation: "updateStory",
		cli: { noun: "comment", verb: "update", positional: ["story_gid"] },
		title: "Update story",
		description: "Edits a comment.",
		idempotent: true,
		input: z.object({
			story_gid: Gid,
			text: z.string().optional(),
			html_text: z.string().optional(),
			is_pinned: z.boolean().optional(),
		}),
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
		description: "Reads one project.",
		readOnly: true,
		input: z.object({ project_gid: Gid, opt_fields: OptFields }),
	}),
	tool({
		name: "asana_create_project",
		operation: "createProject",
		cli: { noun: "project", verb: "create" },
		title: "Create project",
		description: "Creates a project in the workspace (and a team, in organizations).",
		input: z.object({
			name: z.string(),
			workspace: Workspace,
			team: Gid.optional(),
			notes: z.string().optional(),
			html_notes: z.string().optional(),
			color: z.string().optional(),
			due_on: DateOnly.optional(),
			start_on: DateOnly.optional(),
			public: z.boolean().optional(),
			default_view: DefaultView.optional(),
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
			name: z.string().optional(),
			notes: z.string().optional(),
			html_notes: z.string().optional(),
			color: z.string().nullable().optional(),
			due_on: DateOnly.nullable().optional(),
			start_on: DateOnly.nullable().optional(),
			archived: z.boolean().optional(),
			public: z.boolean().optional(),
			owner: z.string().optional(),
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
		request: (args, policy) =>
			get(`/workspaces/${policy.workspace}`, { opt_fields: args.opt_fields }),
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
		input: z.object({
			user: z.string().min(1).describe('User gid, email or "me"'),
			opt_fields: OptFields,
		}),
		request: (args, policy) =>
			get(`/users/${encodeURIComponent(args.user)}`, {
				workspace: policy.workspace,
				opt_fields: args.opt_fields,
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
		request: (args, policy) =>
			get(`/workspaces/${args.workspace ?? policy.workspace}/teams`, page(args)),
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
		request: (args, policy) =>
			get(`/workspaces/${args.workspace ?? policy.workspace}/tags`, page(args)),
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
		request: ({ workspace, ...body }, policy) =>
			send("POST", `/workspaces/${workspace ?? policy.workspace}/tags`, body),
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
		request: (args, policy) =>
			get(`/workspaces/${args.workspace ?? policy.workspace}/custom_fields`, page(args)),
	}),
	tool({
		name: "asana_typeahead",
		operation: "typeaheadForWorkspace",
		cli: { noun: "find", verb: "", positional: ["query"], flags: { resource_type: "type" } },
		title: "Typeahead search",
		description:
			"Finds objects by name prefix (tasks, projects, users, tags, teams, portfolios, goals, custom fields, project templates).",
		readOnly: true,
		input: z.object({
			resource_type: TypeaheadType,
			query: z.string(),
			count: upTo100().describe("Results to return (1-100)"),
			opt_fields: OptFields,
		}),
		request: (args, policy) => get(`/workspaces/${policy.workspace}/typeahead`, args),
	}),
];

/** The curated tools the policy could ever allow: those needing an action some rule allows somewhere. */
function exposedTools(policy: Policy): AnyToolSpec[] {
	const allowed = grantedActions(policy);
	return TOOLS.filter((spec) => spec.needs.some((action) => allowed.has(action)));
}

export { BATCH_NOTE, exposedTools, TOOLS };
export type { AnyToolSpec, CliShape, ToolSpec };
