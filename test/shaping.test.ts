// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { type Body, data, type Fake, items, message, setupGate } from "./helpers/gate.ts";

const POLICY = `
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { project: "21" }
    allow: ["task:*"]
    redact: { task: [notes] }
  - where: { project: "23" }
    deny: ["*"]
`;

/** Creates a task in project 21 through the fake's own API; its gid. */
function createTask(fake: Fake, extra: Body = {}): string {
	const created = fake.api("POST", "/tasks", {
		name: "T new",
		projects: ["21"],
		notes: "secret notes",
		...extra,
	});
	return String(data(created.body).gid);
}

/**
 * How a response may name a subtask's parent: compactly (Asana's default);
 * with its memberships' projects but neither their sections nor its own
 * parent; and with everything its placement derives from.
 */
const PARENT_SELECTIONS = [
	{ label: "compactly", query: {} },
	{
		label: "with its projects",
		query: { opt_fields: "parent.name,parent.memberships.project" },
	},
	{
		label: "with its placement",
		query: {
			opt_fields: "parent.name,parent.memberships.project,parent.memberships.section,parent.parent",
		},
	},
];

describe("nested references", () => {
	it("removes a hidden parent from a visible subtask", async () => {
		const { fake, gate } = await setupGate(POLICY);
		const gid = createTask(fake, { parent: "102" });
		const response = await gate.execute({ method: "GET", path: `/tasks/${gid}` });
		expect(response.status).toBe(200);
		expect(data(response.body).parent).toBeNull();
	});

	it("removes a hidden parent whatever members of it the caller selects", async () => {
		const { fake, gate } = await setupGate(POLICY);
		const gid = createTask(fake, { parent: "102" });
		const response = await gate.execute({
			method: "GET",
			path: `/tasks/${gid}`,
			query: { opt_fields: "name,parent.name" },
		});
		expect(data(response.body).parent).toBeNull();
	});

	it("removes a hidden parent a batch read's fields reach into", async () => {
		const { fake, gate } = await setupGate(POLICY);
		const gid = createTask(fake, { parent: "102" });
		const response = await gate.execute({
			method: "POST",
			path: "/batch",
			body: {
				actions: [
					{
						method: "get",
						relative_path: `/tasks/${gid}`,
						options: { fields: ["name", "parent.name", "parent.notes"] },
					},
				],
			},
		});
		expect(items(response.body)).toMatchObject([{ body: { data: { gid, parent: null } } }]);
	});

	it("removes a hidden parent from the items of a list, whatever the gate asked for", async () => {
		const { fake, gate } = await setupGate(POLICY);
		const gid = createTask(fake, { parent: "102" });
		const response = await gate.execute({ method: "GET", path: "/projects/21/tasks" });
		const item = items(response.body).find((task) => task.gid === gid);
		expect(item?.parent).toBeNull();
		expect(JSON.stringify(response.body)).not.toMatch(/"(?:102|23|34)"/u);
	});

	it("redacts a visible parent as its own policy says", async () => {
		const { gate } = await setupGate(POLICY);
		// Asana names the parent compactly unless its members are selected.
		const response = await gate.execute({
			method: "GET",
			path: "/tasks/104",
			query: { opt_fields: "name,parent.name,parent.notes" },
		});
		const parent = data(response.body).parent as Body;
		expect(parent).toMatchObject({ gid: "101", name: "T1" });
		expect(parent).not.toHaveProperty("notes");
	});

	it.each(PARENT_SELECTIONS)(
		"removes a parent that a rule hides by its tags, named $label",
		async ({ query }) => {
			const { fake, gate } = await setupGate(`${POLICY}
  - where: { project: "21", tag: frozen }
    deny: [task:read]
`);
			const parent = createTask(fake, { tags: ["42"] });
			const gid = createTask(fake, { parent, projects: [] });
			const response = await gate.execute({ method: "GET", path: `/tasks/${gid}`, query });
			expect(response.status).toBe(200);
			expect(data(response.body).parent).toBeNull();
		},
	);

	it.each(PARENT_SELECTIONS)(
		"removes a parent that a rule hides by its section, named $label",
		async ({ query }) => {
			const { fake, gate } = await setupGate(`${POLICY}
  - where: { project: "21", section: Done }
    deny: [task:read]
`);
			const parent = createTask(fake);
			expect(fake.api("POST", "/sections/32/addTask", { task: parent }).status).toBe(200);
			// The subtask is in Backlog, where it is visible.
			const gid = createTask(fake, { parent });
			const response = await gate.execute({ method: "GET", path: `/tasks/${gid}`, query });
			expect(response.status).toBe(200);
			expect(data(response.body).parent).toBeNull();
		},
	);

	it.each(PARENT_SELECTIONS)(
		"redacts a parent by a rule that names its tags, named $label",
		async ({ query }) => {
			const { fake, gate } = await setupGate(`${POLICY}
  - where: { tag: ai-ok }
    redact: { task: [name] }
`);
			const parent = createTask(fake, { tags: ["41"] });
			const gid = createTask(fake, { parent, projects: [] });
			const response = await gate.execute({ method: "GET", path: `/tasks/${gid}`, query });
			expect(data(response.body).parent).toMatchObject({ gid: parent });
			expect(data(response.body).parent).not.toHaveProperty("name");
		},
	);

	it.each(PARENT_SELECTIONS)(
		"judges a parent without a project of its own by the placement above it, named $label",
		async ({ query }) => {
			const { fake, gate } = await setupGate(`${POLICY}
  - where: { unhomed: true }
    deny: [task:read]
`);
			const root = createTask(fake);
			const parent = createTask(fake, { parent: root, projects: [] });
			const gid = createTask(fake, { parent, projects: [] });
			const response = await gate.execute({ method: "GET", path: `/tasks/${gid}`, query });
			expect(data(response.body).parent).toMatchObject({ gid: parent, name: "T new" });
		},
	);
});

describe("lists", () => {
	it("never refills a page beyond the requested limit", async () => {
		const { fake, gate } = await setupGate(POLICY);
		// Backlog (31) lists 103 (hidden), 101 and the new task; Done (32) lists 105.
		const gid = createTask(fake);
		const response = await gate.execute({
			method: "GET",
			path: "/projects/21/tasks",
			query: { limit: "2" },
		});
		expect(items(response.body).map((task) => task.gid)).toStrictEqual(["101", gid]);
	});

	it("keeps typeahead results whose fields the caller selects", async () => {
		const { gate } = await setupGate(POLICY);
		const response = await gate.execute({
			method: "GET",
			path: "/workspaces/1/typeahead",
			query: { resource_type: "task", query: "T", opt_fields: "name" },
		});
		expect(items(response.body).map((task) => task.gid)).toStrictEqual(["101", "105", "107"]);
	});

	it("asks Asana for the names that name filters on projects need", async () => {
		const { fake, gate } = await setupGate(POLICY);
		await gate.execute({
			method: "GET",
			path: "/workspaces/1/projects",
			query: { opt_fields: "notes" },
		});
		const sent = fake.calls.at(-1)?.url.searchParams.get("opt_fields")?.split(",");
		expect(sent).toContain("name");
	});

	it("applies a limit on reads to list requests", async () => {
		const { gate } = await setupGate(`
version: 1
workspace: "1"
rules:
  - allow: [read]
    limit: { "task:read": { max: 1, per: 1h } }
`);
		const list = { method: "GET", path: "/projects/21/tasks" } as const;
		await expect(gate.execute(list)).resolves.toMatchObject({ status: 200 });
		await expect(gate.execute(list)).resolves.toMatchObject({ status: 429 });
	});

	it("refuses a search that names a hidden project, like one that names none", async () => {
		const { gate } = await setupGate(POLICY);
		const hidden = await gate.execute({
			method: "GET",
			path: "/workspaces/1/tasks/search",
			query: { "projects.any": "23" },
		});
		expect(message(hidden.body)).toBe("project: Not a recognized ID: 23");
		const access = await gate.execute({
			method: "GET",
			path: "/access_requests",
			query: { target: "23" },
		});
		expect(message(access.body)).toBe("project: Not a recognized ID: 23");
	});
});

describe("events", () => {
	it("keeps deleted events of visible parents and clears changes naming hidden objects", async () => {
		const { gate } = await setupGate(POLICY);
		const response = await gate.execute({
			method: "GET",
			path: "/events",
			query: { resource: "21", sync: "token-more" },
		});
		const events = items(response.body);
		expect(events.map((event) => (event.resource as Body).gid)).toStrictEqual([
			"101",
			"199",
			"101",
		]);
		expect((events[2]?.change as Body | undefined)?.added_value).toBeNull();
	});

	it("clears a change naming a hidden object by the members the caller selects", async () => {
		const { gate } = await setupGate(POLICY);
		const response = await gate.execute({
			method: "GET",
			path: "/events",
			query: {
				resource: "21",
				sync: "token-more",
				opt_fields: "resource.name,change.added_value.name",
			},
		});
		const changes = items(response.body).map((event) => event.change as Body | undefined);
		expect(changes.at(-1)?.added_value).toBeNull();
	});
});
