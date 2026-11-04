// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createFakeAsana } from "./helpers/fake-asana.ts";
import { type Body, data, type Fake, items, message } from "./helpers/gate.ts";

/** Per resource, its read, create, update, delete and placement operations. */
const CORE: Readonly<Record<string, string>> = {
	task: "getTask getTasks getTasksForProject getTasksForSection getTasksForTag getSubtasksForTask searchTasksForWorkspace createTask createSubtaskForTask updateTask deleteTask addProjectForTask removeProjectForTask setParentForTask addTagForTask removeTagForTask addFollowersForTask removeFollowerForTask addDependenciesForTask removeDependenciesForTask addDependentsForTask removeDependentsForTask",
	project:
		"getProject getProjects getProjectsForWorkspace getProjectsForTeam getProjectsForTask createProject createProjectForWorkspace createProjectForTeam updateProject deleteProject addMembersForProject removeMembersForProject addFollowersForProject removeFollowersForProject",
	section:
		"getSection getSectionsForProject createSectionForProject updateSection deleteSection insertSectionForProject addTaskForSection",
	tag: "getTag getTags getTagsForWorkspace getTagsForTask createTag createTagForWorkspace updateTag deleteTag",
	user: "getUser getUsers getUsersForWorkspace getUsersForTeam getUserForWorkspace updateUser updateUserForWorkspace addUserForWorkspace removeUserForWorkspace",
	team: "getTeam getTeamsForWorkspace getTeamsForUser createTeam updateTeam addUserForTeam removeUserForTeam",
	portfolio:
		"getPortfolio getPortfolios getItemsForPortfolio createPortfolio updatePortfolio deletePortfolio addItemForPortfolio removeItemForPortfolio addMembersForPortfolio removeMembersForPortfolio",
	custom_field:
		"getCustomField getCustomFieldsForWorkspace getCustomFieldSettingsForProject createCustomField updateCustomField deleteCustomField createEnumOptionForCustomField insertEnumOptionForCustomField updateEnumOption addCustomFieldSettingForProject removeCustomFieldSettingForProject addCustomFieldSettingForPortfolio removeCustomFieldSettingForPortfolio",
};

/** The body of a request (`"POST /tasks"`) served by the fake, which must succeed. */
function served(fake: Fake, request: string, body: Body = {}): Body {
	const [method = "", path = ""] = request.split(" ");
	const reply = fake.api(method, path, body);
	expect(reply.status, `${request}: ${JSON.stringify(reply.body)}`).toBeLessThan(300);
	return reply.body;
}

const get = (fake: Fake, path: string): Body => served(fake, `GET ${path}`);

const gidsOf = (body: Body): string[] => items(body).map((item) => String(item.gid));

describe("the fake's routes", () => {
	it("serves every core operation from its one store", () => {
		const operations: ReadonlySet<string> = createFakeAsana().served;
		const core = Object.values(CORE).flatMap((ids) => ids.split(" "));
		expect(core.filter((id) => !operations.has(id))).toStrictEqual([]);
	});

	it("answers 501 for an operation it does not serve, and Asana's 404 for unknown paths", () => {
		const fake = createFakeAsana();
		expect(fake.api("POST", "/tasks/101/duplicate", { name: "copy" }).status).toBe(501);
		const unknown = fake.api("GET", "/nope");
		expect([unknown.status, message(unknown.body)]).toStrictEqual([
			404,
			"No matching route for request",
		]);
	});

	it("answers a gid it does not know with Asana's wording, and finds users by email or me", () => {
		const fake = createFakeAsana();
		expect(message(fake.api("GET", "/tasks/999").body)).toBe("task: Not a recognized ID: 999");
		expect(message(fake.api("GET", "/sections/999").body)).toBe(
			"section: Not a recognized ID: 999",
		);
		expect(data(get(fake, "/users/me")).gid).toBe("51");
		expect(data(get(fake, "/users/bob%40acme.test")).gid).toBe("52");
	});

	it("records what it was sent", async () => {
		const fake = createFakeAsana();
		await fake.fetch("https://app.asana.com/api/1.0/tasks/101?opt_fields=name", {
			method: "PUT",
			body: JSON.stringify({ data: { name: "renamed" } }),
		});
		const form = new FormData();
		form.set("parent", "101");
		form.set("name", "doc");
		await fake.fetch("https://app.asana.com/api/1.0/attachments", { method: "POST", body: form });
		const [put, upload] = fake.calls;
		expect(put).toMatchObject({ method: "PUT", body: { name: "renamed" } });
		expect(put?.url.searchParams.get("opt_fields")).toBe("name");
		expect(upload?.form).toStrictEqual({ parent: "101", name: "doc" });
		expect(fake.store.get("task", "101")?.name).toBe("renamed");
	});
});

describe("responses, projected like Asana's", () => {
	it("serves a project's status updates under their deprecated name too", () => {
		const fake = createFakeAsana();
		expect(gidsOf(get(fake, "/projects/21/project_statuses"))).toStrictEqual(["91"]);
		expect(data(get(fake, "/project_statuses/91")).resource_type).toBe("project_status");
		const created = served(fake, "POST /projects/21/project_statuses", {
			title: "At risk",
			status_type: "at_risk",
		});
		const gid = String(data(created).gid);
		expect(data(get(fake, `/status_updates/${gid}`)).resource_type).toBe("status_update");
	});

	it("answers the gid and the members opt_fields selects, ignoring members it does not know", () => {
		const fake = createFakeAsana();
		expect(data(get(fake, "/tasks/104?opt_fields=name,nonsense"))).toStrictEqual({
			gid: "104",
			name: "S1 subtask",
		});
	});

	// Observed live: a reference selected alone is `{ gid, resource_type }`; the full object names it compactly.
	it("names a reference by gid and type unless members of it are selected", () => {
		const fake = createFakeAsana();
		expect(data(get(fake, "/tasks/104?opt_fields=parent")).parent).toStrictEqual({
			gid: "101",
			resource_type: "task",
		});
		expect(data(get(fake, "/tasks/104")).parent).toMatchObject({
			gid: "101",
			resource_type: "task",
			name: "T1",
		});
		expect(
			data(get(fake, "/tasks/104?opt_fields=parent.memberships.project")).parent,
		).toStrictEqual({
			gid: "101",
			memberships: [{ project: { gid: "21", resource_type: "project" } }],
		});
		// A nested object that is no reference shows only the members selected in it.
		expect(data(get(fake, "/tasks/101?opt_fields=memberships")).memberships).toStrictEqual([{}]);
	});

	it("answers the response schema without opt_fields: compact items in lists, full objects alone", () => {
		const fake = createFakeAsana();
		expect(items(get(fake, "/projects/21/tasks"))[0]).toStrictEqual({
			gid: "103",
			resource_type: "task",
			resource_subtype: "default_task",
			name: "T3 multi",
			created_by: { gid: "51", resource_type: "user" },
		});
		// TaskResponse names its parent as a TaskCompact, without the parent's placement.
		const task = data(get(fake, "/tasks/104"));
		expect(task.parent).toStrictEqual({
			gid: "101",
			resource_type: "task",
			resource_subtype: "default_task",
			name: "T1",
			created_by: { gid: "51", resource_type: "user", name: "Me" },
		});
		expect(task).toMatchObject({ completed: false, projects: [], num_subtasks: 0 });
	});

	it("reads a batch action's fields and paging from its options", () => {
		const fake = createFakeAsana();
		const actions = [
			{ method: "get", relative_path: "/tasks/101", options: { fields: ["name"] } },
			{
				method: "get",
				relative_path: "/projects/21/tasks",
				options: { limit: 1, fields: ["name"] },
			},
		];
		const results = items(served(fake, "POST /batch", { actions }));
		expect(results.map((result) => (result.body as Body).data)).toStrictEqual([
			{ gid: "101", name: "T1" },
			[{ gid: "103", name: "T3 multi" }],
		]);
	});
});

describe("placement routes, which change what Asana holds", () => {
	it("adds a task to a project and takes it out again", () => {
		const fake = createFakeAsana();
		served(fake, "POST /tasks/106/addProject", { project: "22", section: "33" });
		expect(gidsOf(get(fake, "/projects/22/tasks"))).toStrictEqual(["107", "106"]);
		expect(data(get(fake, "/tasks/106?opt_fields=projects")).projects).toStrictEqual([
			{ gid: "22", resource_type: "project" },
		]);
		served(fake, "POST /tasks/106/removeProject", { project: "22" });
		expect(gidsOf(get(fake, "/projects/22/tasks"))).toStrictEqual(["107"]);
	});

	it("places a task where addProject says: at the end, or next to a sibling and in its section", () => {
		const fake = createFakeAsana();
		served(fake, "POST /tasks/106/addProject", { project: "21" });
		expect(gidsOf(get(fake, "/sections/32/tasks"))).toStrictEqual(["105", "106"]);
		served(fake, "POST /tasks/106/addProject", { project: "21", insert_before: "101" });
		expect(gidsOf(get(fake, "/projects/21/tasks"))).toStrictEqual(["103", "106", "101", "105"]);
	});

	it("moves a task to the top of another section of its project", () => {
		const fake = createFakeAsana();
		served(fake, "POST /sections/32/addTask", { task: "101" });
		expect(gidsOf(get(fake, "/sections/31/tasks"))).toStrictEqual(["103"]);
		expect(gidsOf(get(fake, "/sections/32/tasks"))).toStrictEqual(["101", "105"]);
	});

	it("changes a task's parent, and refuses a cycle", () => {
		const fake = createFakeAsana();
		const moved = served(fake, "POST /tasks/104/setParent", { parent: "105" });
		expect((data(moved).parent as Body).gid).toBe("105");
		expect(gidsOf(get(fake, "/tasks/105/subtasks"))).toStrictEqual(["104"]);
		expect(gidsOf(get(fake, "/tasks/101/subtasks"))).toStrictEqual([]);
		expect(fake.api("POST", "/tasks/105/setParent", { parent: "104" }).status).toBe(400);
		served(fake, "POST /tasks/104/setParent", { parent: null });
		expect(data(get(fake, "/tasks/104?opt_fields=parent")).parent).toBeNull();
	});

	it("tags, follows and links tasks", () => {
		const fake = createFakeAsana();
		served(fake, "POST /tasks/101/addTag", { tag: "42" });
		expect(gidsOf(get(fake, "/tags/42/tasks"))).toStrictEqual(["101"]);
		served(fake, "POST /tasks/101/removeTag", { tag: "42" });
		expect(gidsOf(get(fake, "/tags/42/tasks"))).toStrictEqual([]);
		const followed = served(fake, "POST /tasks/101/addFollowers", {
			followers: ["bob@acme.test"],
		});
		expect(data(followed).followers).toStrictEqual([
			{ gid: "52", resource_type: "user", name: "Bob" },
		]);
		served(fake, "POST /tasks/101/addDependencies", { dependencies: ["105"] });
		expect(gidsOf(get(fake, "/tasks/105/dependents"))).toStrictEqual(["101"]);
		expect(fake.api("POST", "/tasks/101/addTag", { tag: "999" }).status).toBe(400);
	});

	it("keeps a project's sections, a portfolio's items and a project's custom fields in order", () => {
		const fake = createFakeAsana();
		const section = data(
			served(fake, "POST /projects/21/sections", { name: "Doing", insert_before: "32" }),
		);
		expect(gidsOf(get(fake, "/projects/21/sections"))).toStrictEqual(["31", section.gid, "32"]);
		served(fake, "POST /portfolios/81/addItem", { item: "21", insert_before: "22" });
		expect(gidsOf(get(fake, "/portfolios/81/items"))).toStrictEqual(["21", "22"]);
		served(fake, "POST /portfolios/81/removeItem", { item: "22" });
		expect(gidsOf(get(fake, "/portfolios/81/items"))).toStrictEqual(["21"]);
		served(fake, "POST /projects/21/addCustomFieldSetting", { custom_field: "61" });
		const settings = items(get(fake, "/projects/21/custom_field_settings?opt_fields=custom_field"));
		expect(settings.map((setting) => (setting.custom_field as Body).gid)).toStrictEqual(["61"]);
		expect(
			data(get(fake, "/projects/21?opt_fields=custom_fields.name")).custom_fields,
		).toStrictEqual([{ gid: "61", name: "Owner" }]);
	});
});

describe("creates", () => {
	it("creates objects where the path or the body puts them, and refuses one with no workspace", () => {
		const fake = createFakeAsana();
		const tag = data(served(fake, "POST /workspaces/1/tags", { name: "new" }));
		expect(gidsOf(get(fake, "/tags?workspace=1"))).toContain(tag.gid);
		const project = data(served(fake, "POST /teams/12/projects", { name: "P" }));
		expect(project).toMatchObject({ team: { gid: "12" }, workspace: { gid: "1" } });
		const missing = fake.api("POST", "/tags", { name: "x" });
		expect([missing.status, message(missing.body)]).toStrictEqual([
			400,
			"workspace: Missing input",
		]);
	});

	it("refuses what Asana refuses: a task placed by memberships alone, a parent changed by PUT", () => {
		const fake = createFakeAsana();
		const memberships = [{ project: "21", section: "31" }];
		const unplaced = fake.api("POST", "/tasks", { name: "x", memberships });
		expect([unplaced.status, message(unplaced.body)]).toStrictEqual([
			400,
			"You should specify one of workspace, parent, projects",
		]);
		expect(fake.api("PUT", "/tasks/104", { parent: "105" }).status).toBe(400);
	});

	it("shows only the members Asana's schema names", () => {
		const fake = createFakeAsana();
		// The store files custom field 61 under workspace 1; Asana's custom field has no workspace.
		expect(data(get(fake, "/custom_fields/61?opt_fields=name,workspace"))).toStrictEqual({
			gid: "61",
			name: "Owner",
		});
		expect(gidsOf(get(fake, "/workspaces/1/custom_fields"))).toStrictEqual(["61"]);
	});

	it("creates a task in its projects, with its custom field values", () => {
		const fake = createFakeAsana();
		const task = data(
			served(fake, "POST /tasks", {
				name: "new",
				projects: ["21"],
				assignee: "me",
				custom_fields: { "61": "72" },
			}),
		);
		expect(task).toMatchObject({
			memberships: [{ project: { gid: "21" }, section: { gid: "31" } }],
			assignee: { gid: "51" },
			workspace: { gid: "1" },
		});
		expect((task.custom_fields as Body[])[0]).toMatchObject({
			gid: "61",
			name: "Owner",
			enum_value: { gid: "72", name: "Human" },
			display_value: "Human",
		});
		expect(gidsOf(get(fake, "/sections/31/tasks"))).toStrictEqual(["103", "101", task.gid]);
	});
});
