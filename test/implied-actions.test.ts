// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { Gate } from "../src/gate/gate.ts";
import { gidOf } from "../src/gate/objects.ts";
import { data, message, setupGate } from "./helpers/gate.ts";

/** Updating tasks and putting custom fields on project 21, but neither completing tasks nor creating custom fields. */
const UPDATE_ONLY = `
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { project: "21" }
    allow: [task:update, custom_field_setting:create]
`;

/** Defining custom fields, and putting them on project 21 and taking them off, but not deleting them. */
const FIELD_SETTINGS = `
version: 1
workspace: "1"
rules:
  - allow: [read, custom_field:create]
  - where: { project: "21" }
    allow: [custom_field_setting:create, custom_field_setting:delete]
`;

/** A custom field defined in place, which is local to the project it is put on. */
const LOCAL_FIELD = { name: "Effort", resource_subtype: "number" };

/** Puts custom field `field` (a gid, or a definition) on project 21; the field's gid. */
async function putField(gate: Gate, field: unknown): Promise<string> {
	const response = await gate.execute({
		method: "POST",
		path: "/projects/21/addCustomFieldSetting",
		body: { custom_field: field },
	});
	return gidOf(data(response.body).custom_field) ?? "";
}

/** Takes custom field `field` off project 21. */
const remove = (gate: Gate, field: string): ReturnType<Gate["execute"]> =>
	gate.execute({
		method: "POST",
		path: "/projects/21/removeCustomFieldSetting",
		body: { custom_field: field },
	});

/**
 * The statuses of creating a record in table 91 and of searching the records
 * of that table, when the policy allows `reads` besides creating and reading
 * records.
 */
async function recordStatuses(reads: string): Promise<number[]> {
	const { fake, gate } = await setupGate(
		`version: 1\nworkspace: "1"\nrules:\n  - allow: [${reads}, record:create, record:read]\n`,
	);
	fake.store.put({ gid: "91", resource_type: "table", name: "Vendors", workspace: { gid: "1" } });
	const created = await gate.execute({
		method: "POST",
		path: "/records",
		body: { name: "Acme Corp", table: "91" },
	});
	const searched = await gate.execute({
		method: "GET",
		path: "/workspaces/1/records/search",
		query: { "tables.any": "91" },
	});
	return [created.status, searched.status];
}

describe("what a body does beyond its operation", () => {
	it("needs task:complete for the approval_status that completes an approval task", async () => {
		const { fake, gate } = await setupGate(UPDATE_ONLY);
		await expect(
			gate.execute({ method: "PUT", path: "/tasks/101", body: { name: "renamed" } }),
		).resolves.toMatchObject({ status: 200 });
		const approved = await gate.execute({
			method: "PUT",
			path: "/tasks/101",
			body: { approval_status: "approved" },
		});
		expect(approved.status).toBe(403);
		expect(message(approved.body)).toContain("task:complete is not permitted on task 101");
		expect(fake.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
	});

	it("needs custom_field:create for a custom field defined where one is put on a project", async () => {
		const { fake, gate } = await setupGate(UPDATE_ONLY);
		const path = "/projects/21/addCustomFieldSetting";
		await expect(
			gate.execute({ method: "POST", path, body: { custom_field: "61" } }),
		).resolves.toMatchObject({ status: 200 });
		const defined = await gate.execute({
			method: "POST",
			path,
			body: { custom_field: { name: "Effort", resource_subtype: "number" } },
		});
		expect(defined.status).toBe(403);
		expect(message(defined.body)).toContain("custom_field:create is not permitted");
		expect(fake.calls.filter((call) => call.method === "POST")).toHaveLength(1);
	});

	it("shapes such a definition like a custom field of its own, in the governed workspace only", async () => {
		const { fake, gate } = await setupGate(`${UPDATE_ONLY}  - allow: [custom_field:create]
    forbid: { custom_field: [description] }
    apply: { custom_field: { name: { prefix: "[AI] " } } }
`);
		const path = "/projects/21/addCustomFieldSetting";
		const field = { name: "Effort", resource_subtype: "number" };
		const described = await gate.execute({
			method: "POST",
			path,
			body: { custom_field: { ...field, description: "hours" } },
		});
		expect(described.status).toBe(400);
		expect(message(described.body)).toContain("description may not be set");
		await expect(
			gate.execute({ method: "POST", path, body: { custom_field: { ...field, workspace: "2" } } }),
		).resolves.toMatchObject({ status: 404 });
		expect(fake.calls.filter((call) => call.method === "POST")).toHaveLength(0);
		await gate.execute({ method: "POST", path, body: { custom_field: field, is_important: true } });
		expect(fake.calls.findLast((call) => call.method === "POST")?.body).toStrictEqual({
			custom_field: { ...field, name: "[AI] Effort" },
			is_important: true,
		});
	});

	it("reads a new approval task in a status other than pending as the completed task it is", async () => {
		const { gate } = await setupGate(`
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { project: "21" }
    allow: [task:create]
  - where: { project: "21", completed: true }
    deny: [task:create]
`);
		const created = async (member: Record<string, unknown>): Promise<number> => {
			const body = { name: "x", projects: ["21"], resource_subtype: "approval", ...member };
			const response = await gate.execute({ method: "POST", path: "/tasks", body });
			return response.status;
		};
		await expect(created({ approval_status: "pending" })).resolves.toBe(201);
		await expect(created({ completed: true })).resolves.toBe(403);
		await expect(created({ approval_status: "approved" })).resolves.toBe(403);
	});

	it("takes a custom field named by gid for an object the policy must show, to put it on and to take it off", async () => {
		const { fake, gate } = await setupGate(`
version: 1
workspace: "1"
rules:
  - allow: [workspace:read, project:read]
  - where: { project: "21" }
    allow: [custom_field_setting:create, custom_field_setting:delete]
`);
		const named = { custom_field: "61" };
		const put = await gate.execute({
			method: "POST",
			path: "/projects/21/addCustomFieldSetting",
			body: named,
		});
		expect(put.status).toBe(404);
		expect(message(put.body)).toBe("custom_field: Not a recognized ID: 61");
		await expect(
			gate.execute({ method: "POST", path: "/projects/21/removeCustomFieldSetting", body: named }),
		).resolves.toMatchObject({ status: 404 });
		expect(fake.calls.filter((call) => call.method === "POST")).toHaveLength(0);
	});

	it("puts a record only into a table the policy shows, and searches only such tables", async () => {
		await expect(recordStatuses("workspace:read")).resolves.toStrictEqual([404, 404]);
		// The fake does not serve the record search, so the search the gate lets through gets 501.
		await expect(recordStatuses("workspace:read, table:read")).resolves.toStrictEqual([201, 501]);
	});

	it("needs custom_field:delete to take off a custom field local to the project, which goes with it", async () => {
		const { fake, gate } = await setupGate(FIELD_SETTINGS);
		const local = await putField(gate, LOCAL_FIELD);
		const removed = await remove(gate, local);
		expect(removed.status).toBe(403);
		expect(message(removed.body)).toContain(
			`custom_field:delete is not permitted on custom_field ${local}`,
		);
		expect(
			fake.calls.filter((call) => call.url.pathname.endsWith("/removeCustomFieldSetting")),
		).toHaveLength(0);
	});

	it("takes a library custom field off without custom_field:delete, and a local one with it", async () => {
		const library = await setupGate(FIELD_SETTINGS);
		await putField(library.gate, "61");
		await expect(remove(library.gate, "61")).resolves.toMatchObject({ status: 200 });
		const { gate } = await setupGate(`${FIELD_SETTINGS}  - allow: [custom_field:delete]\n`);
		const local = await putField(gate, LOCAL_FIELD);
		await expect(remove(gate, local)).resolves.toMatchObject({ status: 200 });
		await expect(
			gate.execute({ method: "GET", path: `/custom_fields/${local}` }),
		).resolves.toMatchObject({ status: 404 });
	});
});
