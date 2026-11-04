// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { type Body, data, items, message, setupGate } from "./helpers/gate.ts";
import { fieldsSentTo } from "./helpers/requests.ts";

const POLICY = `
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { project: "21" }
    allow: ["task:*", story:create]
  - where: { project: "21", section: Done }
    deny: [task:update, task:delete, task:complete]
  - where: { project: "23" }
    deny: ["*"]
  - where: { project: "22" }
    allow: [read]
    fields: { task: [completed, due_on] }
`;

/** A fresh fake Asana and a gate over it, per test. */
function setup(): ReturnType<typeof setupGate> {
	return setupGate(POLICY);
}

/** The body of the n-th result of a batch response. */
const batchBody = (body: Body, index: number): Body =>
	(body.data as { body: Body }[])[index]?.body ?? {};

describe("gate", () => {
	it("returns visible objects with their allowed actions", async () => {
		const { gate } = await setup();
		const response = await gate.execute({ method: "GET", path: "/tasks/101" });
		expect(response.status).toBe(200);
		expect(data(response.body).name).toBe("T1");
		expect(data(response.body).allowed_actions).toStrictEqual(
			expect.arrayContaining(["task:read", "task:update", "task:delete"]),
		);
	});

	it("answers like Asana's 404 for invisible objects, including multi-homed ones", async () => {
		const { gate } = await setup();
		const hidden = await gate.execute({ method: "GET", path: "/tasks/102" });
		expect(hidden.status).toBe(404);
		expect(message(hidden.body)).toBe("task: Not a recognized ID: 102");
		await expect(gate.execute({ method: "GET", path: "/tasks/103" })).resolves.toMatchObject({
			status: 404,
		});
	});

	it("hides projects the policy denies, and workspaces other than the governed one", async () => {
		const { gate } = await setup();
		await expect(gate.execute({ method: "GET", path: "/projects/23" })).resolves.toMatchObject({
			status: 404,
		});
		await expect(
			gate.execute({ method: "GET", path: "/projects/23/tasks" }),
		).resolves.toMatchObject({ status: 404 });
		await expect(gate.execute({ method: "GET", path: "/workspaces/2" })).resolves.toMatchObject({
			status: 404,
		});
	});

	it("lets a subtask inherit its parent's placement without an extra request", async () => {
		const { fake, gate } = await setup();
		// The placement comes with the loader's own fetch (parent.memberships.*); the fields
		// name no parent, so this checks that fetch alone.
		const response = await gate.execute({
			method: "GET",
			path: "/tasks/104",
			query: { opt_fields: "name" },
		});
		expect(response.status).toBe(200);
		expect(data(response.body).allowed_actions).toContain("task:update");
		expect(fake.calls.filter((c) => c.url.pathname.endsWith("/tasks/101"))).toHaveLength(0);
	});

	it("judges a subtask's parent by the placement its own fetch carries", async () => {
		const { fake, gate } = await setup();
		// The one read of the subtask carries the parent's placement beside the caller's fields.
		const response = await gate.execute({
			method: "GET",
			path: "/tasks/104",
			query: { opt_fields: "name,parent.name" },
		});
		expect(response.status).toBe(200);
		expect(data(response.body).parent).toStrictEqual({ gid: "101", name: "T1" });
		expect(fake.calls.map((c) => c.url.pathname)).toStrictEqual(["/api/1.0/tasks/104"]);
	});

	it("refuses actions the policy does not allow with a 403 that names them", async () => {
		const { fake, gate } = await setup();
		const rename = await gate.execute({ method: "PUT", path: "/tasks/105", body: { name: "x" } });
		expect(rename.status).toBe(403);
		expect(message(rename.body)).toContain("task:update is not permitted on task 105");
		const complete = await gate.execute({
			method: "PUT",
			path: "/tasks/105",
			body: { data: { completed: false } },
		});
		expect(complete.status).toBe(403);
		expect(message(complete.body)).toContain("task:complete");
		expect(fake.store.get("task", "105")?.name).toBe("T5 done");
	});

	it("refuses deletes the policy does not grant", async () => {
		const { fake, gate } = await setup();
		await expect(gate.execute({ method: "DELETE", path: "/tasks/107" })).resolves.toMatchObject({
			status: 403,
		});
		expect(fake.store.get("task", "107")).toBeDefined();
	});

	it("enforces field allowlists on updates", async () => {
		const { fake, gate } = await setup();
		await expect(
			gate.execute({ method: "PUT", path: "/tasks/107", body: { completed: true } }),
		).resolves.toMatchObject({ status: 200 });
		await expect(
			gate.execute({ method: "PUT", path: "/tasks/107", body: { due_on: "2026-12-01" } }),
		).resolves.toMatchObject({ status: 200 });
		const rename = await gate.execute({
			method: "PUT",
			path: "/tasks/107",
			body: { name: "renamed" },
		});
		expect(rename.status).toBe(403);
		expect(message(rename.body)).toContain("task.name");
		expect(fake.store.get("task", "107")?.name).toBe("T7 design");
	});

	it("filters lists, decorates items and asks Asana for the fields it needs", async () => {
		const { fake, gate } = await setup();
		const response = await gate.execute({ method: "GET", path: "/projects/21/tasks" });
		expect(response.status).toBe(200);
		expect(items(response.body).map((t) => t.gid)).toStrictEqual(["101", "105"]);
		expect(items(response.body)[1]?.allowed_actions).not.toContain("task:update");
		expect(fieldsSentTo(fake, "/projects/21/tasks")).toStrictEqual(
			expect.arrayContaining([
				"name",
				"memberships.project",
				"memberships.section",
				"parent",
				"workspace",
			]),
		);
	});

	it("refills a page that filtering emptied, keeping the pagination token", async () => {
		const { fake, gate } = await setup();
		const response = await gate.execute({
			method: "GET",
			path: "/projects/21/tasks",
			query: { limit: "1" },
		});
		expect(items(response.body).map((t) => t.gid)).toStrictEqual(["101"]);
		expect((response.body.next_page as { offset: string }).offset).toBe("2");
		expect(fake.calls.filter((c) => c.url.pathname.endsWith("/projects/21/tasks"))).toHaveLength(2);
	});

	it("filters typeahead results and the workspace list", async () => {
		const { gate } = await setup();
		const typeahead = await gate.execute({
			method: "GET",
			path: "/workspaces/1/typeahead",
			query: { resource_type: "task", query: "T" },
		});
		expect(items(typeahead.body).map((t) => t.gid)).toStrictEqual(["101", "105", "107"]);
		const workspaces = await gate.execute({ method: "GET", path: "/workspaces" });
		expect(items(workspaces.body).map((w) => w.gid)).toStrictEqual(["1"]);
	});

	it("evaluates task creation where the task will live", async () => {
		const { gate } = await setup();
		const ok = await gate.execute({
			method: "POST",
			path: "/tasks",
			body: { name: "new", projects: ["21"] },
		});
		expect(ok.status).toBe(201);
		expect(data(ok.body).allowed_actions).toContain("task:update");
		await expect(
			gate.execute({ method: "POST", path: "/tasks", body: { name: "new", projects: ["23"] } }),
		).resolves.toMatchObject({ status: 404 });
		await expect(
			gate.execute({ method: "POST", path: "/tasks", body: { name: "new", workspace: "1" } }),
		).resolves.toMatchObject({ status: 403 });
	});

	it("evaluates subtask creation under the parent", async () => {
		const { gate } = await setup();
		await expect(
			gate.execute({ method: "POST", path: "/tasks/101/subtasks", body: { name: "sub" } }),
		).resolves.toMatchObject({ status: 201 });
		await expect(
			gate.execute({ method: "POST", path: "/tasks/102/subtasks", body: { name: "sub" } }),
		).resolves.toMatchObject({ status: 404 });
	});

	it("lets stories follow their task", async () => {
		const { gate } = await setup();
		const list = await gate.execute({ method: "GET", path: "/tasks/101/stories" });
		expect(items(list.body)[0]?.allowed_actions).toStrictEqual(["story:read", "story:create"]);
		await expect(
			gate.execute({ method: "POST", path: "/tasks/101/stories", body: { text: "hi" } }),
		).resolves.toMatchObject({ status: 201 });
		await expect(
			gate.execute({ method: "POST", path: "/tasks/107/stories", body: { text: "hi" } }),
		).resolves.toMatchObject({ status: 403 });
	});

	it("refuses a whole batch when one action is refused, and post-processes each result otherwise", async () => {
		const { fake, gate } = await setup();
		const refused = await gate.execute({
			method: "POST",
			path: "/batch",
			body: {
				actions: [
					{ relative_path: "/tasks/101", method: "get" },
					{ relative_path: "/tasks/102", method: "get" },
				],
			},
		});
		expect(refused.status).toBe(404);
		expect(fake.calls.filter((c) => c.url.pathname.endsWith("/batch"))).toHaveLength(0);
		const ok = await gate.execute({
			method: "POST",
			path: "/batch",
			body: {
				actions: [
					{ relative_path: "/tasks/101", method: "get", options: { fields: ["name"] } },
					{ relative_path: "/projects/21/tasks", method: "get", data: { limit: 5 } },
				],
			},
		});
		expect(ok.status).toBe(200);
		expect(data(batchBody(ok.body, 0)).allowed_actions).toContain("task:read");
		expect(items(batchBody(ok.body, 1)).map((t) => t.gid)).toStrictEqual(["101", "105"]);
	});

	it("passes Asana's own errors through untouched, sync token included", async () => {
		const { gate } = await setup();
		const handshake = await gate.execute({
			method: "GET",
			path: "/events",
			query: { resource: "21" },
		});
		expect(handshake.status).toBe(412);
		expect(handshake.body.sync).toBe("token-1");
		const events = await gate.execute({
			method: "GET",
			path: "/events",
			query: { resource: "21", sync: "token-1" },
		});
		expect(events.status).toBe(200);
		expect(items(events.body).map((e) => (e.resource as { gid: string }).gid)).toStrictEqual([
			"101",
		]);
	});

	it("answers unknown routes like Asana", async () => {
		const { gate } = await setup();
		const route = await gate.execute({ method: "GET", path: "/nope" });
		expect(route.status).toBe(404);
		expect(message(route.body)).toBe("No matching route for request");
	});

	it("explains visible objects and hides invisible ones", async () => {
		const { gate } = await setup();
		const { explanation } = await gate.explain("task", "105");
		expect(explanation.visible).toBe(true);
		expect(explanation.actions.find((d) => d.action === "task:update")?.allowed).toBe(false);
		await expect(gate.explain("task", "102")).rejects.toMatchObject({ status: 404 });
	});

	it("refuses a batch of more than fifty actions before planning any", async () => {
		const { gate, fake } = await setup();
		const actions = Array.from({ length: 51 }, () => ({
			method: "get",
			relative_path: "/tasks/101",
		}));
		const response = await gate.execute({ method: "POST", path: "/batch", body: { actions } });
		expect(response.status).toBe(400);
		expect(message(response.body)).toContain("at most 50");
		expect(fake.calls.filter((c) => c.url.pathname.endsWith("/batch"))).toHaveLength(0);
	});
});
