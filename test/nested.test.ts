// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { type Body, data, type Fake, items, message, setupGate } from "./helpers/gate.ts";

/**
 * Everything is readable but project 23, with its task 102; a project's
 * notes are redacted, and the tasks of project 21 are writable, without
 * their notes.
 */
const POLICY = `
version: 1
workspace: "1"
rules:
  - allow: [read]
    redact: { project: [notes] }
  - where: { project: "21" }
    allow: ["task:*"]
    redact: { task: [notes] }
  - where: { project: "23" }
    deny: ["*"]
`;

/** Tasks of project 22 only: its team, like everything else at workspace level, is not readable. */
const TASKS_ONLY = `
version: 1
workspace: "1"
rules:
  - where: { project: "22" }
    allow: ["task:*"]
`;

/** Puts a `reference` custom field on task 101 that names `gids`; the field's gid. */
function refer(fake: Fake, gids: readonly string[]): string {
	const field = fake.api("POST", "/custom_fields", {
		workspace: "1",
		name: "Related",
		resource_subtype: "reference",
		input_restrictions: ["task", "project"],
	});
	const gid = String(data(field.body).gid);
	fake.api("PUT", "/tasks/101", { custom_fields: { [gid]: gids } });
	return gid;
}

describe("references a custom field holds", () => {
	it("removes the hidden objects a reference field names, and Asana's text for them", async () => {
		const { fake, gate } = await setupGate(POLICY);
		const field = refer(fake, ["102", "23", "105"]);
		const response = await gate.execute({ method: "GET", path: "/tasks/101" });
		const [shown] = data(response.body).custom_fields as Body[];
		expect(shown).toMatchObject({
			gid: field,
			reference_value: [{ gid: "105", resource_type: "task", name: "T5 done" }],
			display_value: null,
		});
		expect(JSON.stringify(response.body)).not.toMatch(/T2 secret|Secret/u);
	});

	it("keeps Asana's text for a field that names no hidden object", async () => {
		const { fake, gate } = await setupGate(POLICY);
		refer(fake, ["105", "21"]);
		const response = await gate.execute({
			method: "GET",
			path: "/tasks/101",
			query: { opt_fields: "custom_fields.display_value,custom_fields.reference_value.name" },
		});
		expect(data(response.body).custom_fields).toStrictEqual([
			{
				gid: expect.any(String) as string,
				display_value: "T5 done, Backend",
				reference_value: [
					{ gid: "105", name: "T5 done" },
					{ gid: "21", name: "Backend" },
				],
			},
		]);
	});

	it("clears the text asked for without the references it names", async () => {
		const { fake, gate } = await setupGate(POLICY);
		const field = refer(fake, ["102"]);
		const response = await gate.execute({
			method: "GET",
			path: "/tasks/101",
			query: { opt_fields: "custom_fields.display_value" },
		});
		// The gate asks for the references beside the text, and answers the caller's fields.
		expect(data(response.body).custom_fields).toStrictEqual([{ gid: field, display_value: null }]);
		const sent = fake.calls.find((call) => call.url.pathname.endsWith("/tasks/101"));
		expect(sent?.url.searchParams.get("opt_fields")?.split(",")).toContain(
			"custom_fields.reference_value",
		);
	});

	it("removes them from the items of a list", async () => {
		const { fake, gate } = await setupGate(POLICY);
		refer(fake, ["102", "105"]);
		const response = await gate.execute({
			method: "GET",
			path: "/projects/21/tasks",
			query: { opt_fields: "custom_fields.reference_value.name,custom_fields.display_value" },
		});
		const item = items(response.body).find((task) => task.gid === "101");
		expect(item?.custom_fields).toMatchObject([
			{ reference_value: [{ gid: "105", name: "T5 done" }], display_value: null },
		]);
		expect(JSON.stringify(response.body)).not.toContain("T2 secret");
	});
});

describe("the objects a request names", () => {
	it("answers a hidden object of any type a member may name as one that does not exist", async () => {
		const { gate } = await setupGate(POLICY);
		const events = (resource: string): ReturnType<typeof gate.execute> =>
			gate.execute({ method: "GET", path: "/events", query: { resource } });
		// `resource` may name a project, a task and more: the message tells neither the type nor the existence.
		const [hidden, nothing] = await Promise.all([events("102"), events("999")]);
		expect(message(hidden.body)).toBe("project: Not a recognized ID: 102");
		expect(message(nothing.body)).toBe("project: Not a recognized ID: 999");
	});

	it("refuses a hidden object a reference custom field is set to, and sends nothing", async () => {
		const { fake, gate } = await setupGate(POLICY);
		const field = refer(fake, []);
		const set = (gid: string): ReturnType<typeof gate.execute> =>
			gate.execute({
				method: "PUT",
				path: "/tasks/101",
				body: { custom_fields: { [field]: ["105", gid] } },
			});
		const [task, project, nothing] = await Promise.all([set("102"), set("23"), set("999")]);
		expect([task.status, project.status, nothing.status]).toStrictEqual([404, 404, 404]);
		expect(message(task.body)).toBe("task: Not a recognized ID: 102");
		expect(message(project.body)).toBe("task: Not a recognized ID: 23");
		expect(message(nothing.body)).toBe("task: Not a recognized ID: 999");
		expect(fake.calls.filter((call) => call.method === "PUT")).toStrictEqual([]);
	});

	it("takes visible objects, named by one gid or a list of them", async () => {
		const { fake, gate } = await setupGate(POLICY);
		const field = refer(fake, []);
		const set = async (value: unknown): Promise<unknown> => {
			const response = await gate.execute({
				method: "PUT",
				path: "/tasks/101",
				body: { custom_fields: { [field]: value } },
				query: { opt_fields: "custom_fields.display_value" },
			});
			return [response.status, data(response.body).custom_fields];
		};
		await expect(set("105")).resolves.toStrictEqual([
			200,
			[{ gid: field, display_value: "T5 done" }],
		]);
		await expect(set(["105", "21"])).resolves.toStrictEqual([
			200,
			[{ gid: field, display_value: "T5 done, Backend" }],
		]);
	});

	it("refuses a hidden object named by a new task", async () => {
		const { fake, gate } = await setupGate(POLICY);
		const field = refer(fake, []);
		const response = await gate.execute({
			method: "POST",
			path: "/tasks",
			body: { name: "new", projects: ["21"], custom_fields: { [field]: "102" } },
		});
		expect(response.status).toBe(404);
		expect(fake.calls.filter((call) => call.method === "POST")).toStrictEqual([]);
	});

	it("takes whatever a reference field is set to for a name, a number or an object's gid too", async () => {
		const { fake, gate } = await setupGate(POLICY);
		const field = refer(fake, []);
		const set = (value: unknown): ReturnType<typeof gate.execute> =>
			gate.execute({
				method: "PUT",
				path: "/tasks/101",
				body: { custom_fields: { [field]: value } },
			});
		const answers = await Promise.all([set(102), set([{ gid: "102" }]), set(" 102")]);
		expect(answers.map((answer) => answer.status)).toStrictEqual([404, 404, 404]);
		expect(fake.calls.filter((call) => call.method === "PUT")).toStrictEqual([]);
	});

	it("looks a field up once for the requests that set it, and not for a value that names nothing", async () => {
		const { fake, gate } = await setupGate(POLICY);
		const set = (value: unknown): ReturnType<typeof gate.execute> =>
			gate.execute({ method: "PUT", path: "/tasks/101", body: { custom_fields: { "61": value } } });
		const lookups = (): number =>
			fake.calls.filter((call) => call.url.pathname.endsWith("/custom_fields/61")).length;
		await set(null);
		const before = lookups();
		// Field 61 takes an option of its own, which only its definition tells from an object's gid.
		await Promise.all([set("71"), set("72")]);
		await set("71");
		expect([before, lookups()]).toStrictEqual([0, 1]);
	});
});

describe("references a membership holds", () => {
	it("removes a hidden project and section from a visible task's memberships", async () => {
		const { gate } = await setupGate(TASKS_ONLY);
		const response = await gate.execute({ method: "GET", path: "/tasks/107" });
		expect(response.status).toBe(200);
		// As in `projects`, where the project is a reference of the task itself.
		expect(data(response.body)).toMatchObject({
			projects: [],
			memberships: [{ project: null, section: null }],
		});
	});

	it("redacts a project read through a task's memberships as its own policy says", async () => {
		const { fake, gate } = await setupGate(POLICY);
		fake.api("PUT", "/projects/21", { notes: "project notes" });
		const response = await gate.execute({
			method: "GET",
			path: "/tasks/101",
			query: { opt_fields: "memberships.project.name,memberships.project.notes" },
		});
		expect(data(response.body).memberships).toStrictEqual([
			{ project: { gid: "21", name: "Backend" } },
		]);
	});

	it("removes a hidden team reached through a task's memberships", async () => {
		const { gate } = await setupGate(`${TASKS_ONLY}
  - where: { project: "22" }
    allow: [project:read]
`);
		const response = await gate.execute({
			method: "GET",
			path: "/tasks/107",
			query: { opt_fields: "memberships.project.name,memberships.project.team.name" },
		});
		expect(data(response.body).memberships).toStrictEqual([
			{ project: { gid: "22", name: "Design System", team: null } },
		]);
	});

	it("loads nothing to check what the answer leaves out", async () => {
		const { fake, gate } = await setupGate(POLICY);
		await gate.execute({ method: "GET", path: "/tasks/101", query: { opt_fields: "name" } });
		// The gate asks for the task's memberships to place it, and cuts them back unchecked.
		expect(fake.calls.map((call) => call.url.pathname)).toStrictEqual(["/api/1.0/tasks/101"]);
	});
});

describe("what events and notifications name", () => {
	it("redacts the object an event names as its own policy says", async () => {
		const { fake, gate } = await setupGate(POLICY);
		fake.api("PUT", "/tasks/101", { notes: "task notes" });
		const response = await gate.execute({
			method: "GET",
			path: "/events",
			query: { resource: "21", sync: "token-1", opt_fields: "resource.name,resource.notes" },
		});
		expect(items(response.body)).toStrictEqual([{ resource: { gid: "101", name: "T1" } }]);
	});

	it("judges an event by the objects it names, whatever fields the caller selects", async () => {
		const { fake, gate } = await setupGate(POLICY);
		const response = await gate.execute({
			method: "GET",
			path: "/events",
			query: { resource: "21", sync: "token-1", opt_fields: "action" },
		});
		// The event of the hidden task 102 goes, though the caller left `resource` out.
		expect(items(response.body)).toStrictEqual([{ action: "changed" }]);
		const sent = fake.calls.find((call) => call.url.pathname.endsWith("/events"));
		expect(sent?.url.searchParams.get("opt_fields")?.split(",")).toStrictEqual(
			expect.arrayContaining(["action", "resource", "parent"]),
		);
	});

	it("judges a notification by its work objects, whatever fields the caller selects", async () => {
		const { fake, gate } = await setupGate(POLICY);
		const about = (gid: string, task: string): Body =>
			fake.store.put({
				gid,
				resource_type: "notification",
				is_read: false,
				user: { gid: "51", resource_type: "user" },
				workspace: { gid: "1", resource_type: "workspace" },
				work_objects: [{ gid: task, resource_type: "task" }],
			});
		about("601", "101");
		about("602", "102");
		const response = await gate.execute({
			method: "GET",
			path: "/users/51/notifications",
			query: { workspace: "1", opt_fields: "is_read" },
		});
		expect(items(response.body)).toStrictEqual([{ gid: "601", is_read: false }]);
	});
});
