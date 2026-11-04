// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { GateRequest } from "../src/gate/gate.ts";
import { message, setupGate } from "./helpers/gate.ts";

/** Makes task 101 depend on `gid`. */
const link = (gid: string): GateRequest => ({
	method: "POST",
	path: "/tasks/101/addDependencies",
	body: { dependencies: [gid] },
});

const POLICY = `
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { project: "21" }
    allow: ["task:*"]
  - where: { project: "23" }
    deny: ["*"]
  - where: { project: "21", completed: true }
    deny: ["*"]
  - where: { project: "21", section: "32" }
    deny: [task:update]
`;

describe("hidden objects answer like nonexistent ones", () => {
	it("refuses a create in a hidden project with the project's own 404", async () => {
		const { gate } = await setupGate(POLICY);
		const hidden = await gate.execute({
			method: "POST",
			path: "/tasks",
			body: { name: "x", projects: ["23"] },
		});
		const missing = await gate.execute({
			method: "POST",
			path: "/tasks",
			body: { name: "x", projects: ["99"] },
		});
		expect([hidden.status, missing.status]).toStrictEqual([404, 404]);
		expect(message(hidden.body)).toBe("project: Not a recognized ID: 23");
		expect(message(missing.body)).toBe("project: Not a recognized ID: 99");
	});

	it("answers 404 for a hidden path object before checking the other inputs", async () => {
		const { gate } = await setupGate(POLICY);
		const hidden = await gate.execute({ method: "POST", path: "/tasks/102/addProject", body: {} });
		expect(hidden.status).toBe(404);
		expect(message(hidden.body)).toBe("task: Not a recognized ID: 102");
	});

	it("refuses a subtask under a parent a filter hides", async () => {
		const { gate } = await setupGate(POLICY);
		const response = await gate.execute({
			method: "POST",
			path: "/tasks/105/subtasks",
			body: { name: "sub" },
		});
		expect(response.status).toBe(404);
		expect(message(response.body)).toBe("task: Not a recognized ID: 105");
	});

	it("refuses a workspace query that names another workspace, anchor or not", async () => {
		const { gate } = await setupGate(POLICY);
		const response = await gate.execute({
			method: "GET",
			path: "/tasks",
			query: { workspace: "2", project: "21" },
		});
		expect(message(response.body)).toBe("workspace: Not a recognized ID: 2");
	});

	it("needs task:update on both tasks of a dependency", async () => {
		const { gate } = await setupGate(`
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { project: "21" }
    allow: ["task:*"]
  - where: { project: "21", section: "32" }
    deny: [task:update]
`);
		// Task 105 sits in the frozen Done section (32); subtask 104 lives in 21 like its parent.
		await expect(gate.authorize(link("105"))).rejects.toMatchObject({ status: 403 });
		await expect(gate.authorize(link("104"))).resolves.toBeDefined();
	});
});

describe("the task being placed is the one judged", () => {
	it("judges an assignee given by email as the user it names", async () => {
		const { gate } = await setupGate(
			`${POLICY}  - where: { project: "21", assignee: "bob@acme.test" }\n    deny: [task:create]\n`,
		);
		const byGid = await gate.execute({
			method: "POST",
			path: "/tasks",
			body: { name: "x", projects: ["21"], assignee: "52" },
		});
		const byEmail = await gate.execute({
			method: "POST",
			path: "/tasks",
			body: { name: "x", projects: ["21"], assignee: "bob@acme.test" },
		});
		expect([byGid.status, byEmail.status]).toStrictEqual([403, 403]);
	});

	it("lets a section-scoped create grant cover projects plus memberships", async () => {
		const { gate } = await setupGate(`
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { project: "21", section: "31" }
    allow: [task:create]
`);
		const response = await gate.execute({
			method: "POST",
			path: "/tasks",
			body: { name: "x", projects: ["21"], memberships: [{ project: "21", section: "31" }] },
		});
		expect(response.status).toBe(201);
	});

	it("judges setParent by the moved task, not by its new parent", async () => {
		const policy = `
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { unhomed: true }
    allow: [task:set_parent]
  - where: { project: "21", name: { prefix: "U1" } }
    allow: [task:create]
`;
		const { gate } = await setupGate(policy);
		// Task 106 ("U1 unhomed") may be created in project 21 by its name; the parent's name does not matter.
		await expect(
			gate.authorize({ method: "POST", path: "/tasks/106/setParent", body: { parent: "101" } }),
		).resolves.toBeDefined();
		const { gate: strict } = await setupGate(policy.replace('prefix: "U1"', 'prefix: "T1"'));
		await expect(
			strict.authorize({ method: "POST", path: "/tasks/106/setParent", body: { parent: "101" } }),
		).rejects.toMatchObject({ status: 403 });
	});

	it("needs create in the team a project moves to", async () => {
		const policy = `
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { team: "Platform" }
    allow: [project:update]
`;
		const { gate } = await setupGate(policy);
		const move = { method: "PUT", path: "/projects/21", body: { team: "12" } } as const;
		await expect(gate.authorize(move)).rejects.toMatchObject({ status: 403 });
		const { gate: hidden } = await setupGate(
			`${policy}  - where: { team: "Design" }\n    deny: ["*"]\n`,
		);
		await expect(hidden.authorize(move)).rejects.toMatchObject({ status: 404 });
		await expect(
			gate.authorize({ method: "PUT", path: "/projects/21", body: { team: "11", name: "x" } }),
		).resolves.toBeDefined();
	});
});
