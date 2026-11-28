// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { Gate } from "../src/gate/gate.ts";
import { type Body, data, type Fake, items, setupGate } from "./helpers/gate.ts";
import { PROJECT_POLICY, requests, TEAM_POLICY } from "./helpers/requests.ts";

const TASK_READ = ["task:read"];

/** One read per 1 h in project 21; reads in project 22 need a confirmation. */
const LIMITED = `
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { project: "21" }
    limit: { "task:read": { max: 1, per: 1h } }
  - where: { project: "22" }
    confirm: [task:read]
`;

/** Renames a task of the fake behind the gate's back. */
function rename(fake: Fake, gid: string, name: string): void {
	fake.api("PUT", `/tasks/${gid}`, { name });
}

/** GET /tasks/{gid} for its name. */
const read = (gate: Gate, gid: string): ReturnType<Gate["execute"]> =>
	gate.execute({ method: "GET", path: `/tasks/${gid}`, query: { opt_fields: "name" } });

/** A batch of GET actions on `gids`, each asking for `fields`. */
const readsOf = (gids: readonly string[], fields: readonly string[]): Body => ({
	actions: gids.map((gid) => ({
		method: "get",
		relative_path: `/tasks/${gid}`,
		options: { fields },
	})),
});

describe("a GET by gid", () => {
	it("is answered from the one request that checks it, cut back to the caller's fields", async () => {
		const { fake, gate } = await setupGate(TEAM_POLICY);
		const response = await gate.execute({
			method: "GET",
			path: "/tasks/101",
			query: { opt_fields: "name,notes" },
		});
		expect(response.status).toBe(200);
		expect(data(response.body)).toStrictEqual({
			gid: "101",
			name: "T1",
			notes: "",
			allowed_actions: TASK_READ,
		});
		expect(requests(fake)).toStrictEqual(["GET /tasks/101"]);
		const sent = fake.calls[0]?.url.searchParams.get("opt_fields")?.split(",");
		expect(sent).toStrictEqual(
			expect.arrayContaining(["name", "notes", "memberships.project.team", "parent.resource_type"]),
		);
	});

	it("answers the whole object when the caller names no fields", async () => {
		const { fake, gate } = await setupGate(PROJECT_POLICY);
		const response = await gate.execute({ method: "GET", path: "/tasks/101" });
		expect(data(response.body)).toMatchObject({
			gid: "101",
			resource_type: "task",
			notes: "",
			memberships: [{ project: { gid: "21", name: "Backend" } }],
		});
		// The task is read once: the project and the section its memberships name are judged
		// by the facts the task was judged by, which tell where they are.
		expect(requests(fake)).toStrictEqual(["GET /tasks/101"]);
	});

	it("fetches the project's team the whole object lacks", async () => {
		const { fake, gate } = await setupGate(TEAM_POLICY);
		await gate.execute({ method: "GET", path: "/tasks/101" });
		expect(requests(fake)).toStrictEqual(["GET /tasks/101", "GET /projects/21"]);
	});

	it("fetches a subtask's parent once, to place it and to check the reference", async () => {
		const { fake, gate } = await setupGate(PROJECT_POLICY);
		const response = await gate.execute({ method: "GET", path: "/tasks/104" });
		expect(data(response.body).parent).toMatchObject({ gid: "101", name: "T1" });
		expect(requests(fake)).toStrictEqual(["GET /tasks/104", "GET /tasks/101"]);
	});

	it("answers a member the caller selects alone as Asana does, loading the facts beside it", async () => {
		const { fake, gate } = await setupGate(PROJECT_POLICY);
		const response = await gate.execute({
			method: "GET",
			path: "/tasks/104",
			query: { opt_fields: "name,parent" },
		});
		expect(data(response.body)).toStrictEqual({
			gid: "104",
			name: "S1 subtask",
			parent: { gid: "101", resource_type: "task" },
			allowed_actions: TASK_READ,
		});
		// Selecting inside `parent` would change it; the facts come from their own request,
		// sent alongside, whose ancestors carry their placement.
		expect(requests(fake)).toStrictEqual(["GET /tasks/104", "GET /tasks/104"]);
	});

	it("reads the object afresh every time", async () => {
		const { fake, gate } = await setupGate(PROJECT_POLICY);
		const request = { method: "GET", path: "/tasks/101", query: { opt_fields: "name" } } as const;
		await gate.execute(request);
		rename(fake, "101", "T1 renamed");
		const again = await gate.execute(request);
		expect(data(again.body).name).toBe("T1 renamed");
		expect(requests(fake)).toStrictEqual(["GET /tasks/101", "GET /tasks/101"]);
	});

	it("still answers 404 for a hidden object", async () => {
		const { fake, gate } = await setupGate(PROJECT_POLICY);
		const response = await gate.execute({ method: "GET", path: "/tasks/102" });
		expect(response.status).toBe(404);
		expect(requests(fake)).toStrictEqual(["GET /tasks/102"]);
	});

	it("keeps a limit on the read, counted before anything is answered", async () => {
		const { fake, gate } = await setupGate(LIMITED);
		await expect(read(gate, "101")).resolves.toMatchObject({ status: 200 });
		const limited = await read(gate, "101");
		expect(limited.status).toBe(429);
		expect(limited.body).not.toHaveProperty("data");
		expect(requests(fake)).toStrictEqual(["GET /tasks/101", "GET /tasks/101"]);
	});

	it("keeps a confirmation of the read, asked before anything is answered", async () => {
		const { fake, gate } = await setupGate(LIMITED);
		const unconfirmed = await read(gate, "107");
		expect(unconfirmed.status).toBe(428);
		expect(unconfirmed.body).not.toHaveProperty("data");
		expect(requests(fake)).toStrictEqual(["GET /tasks/107"]);
	});

	it("is sent as usual when the caller's fields are not plain paths", async () => {
		const { fake, gate } = await setupGate(PROJECT_POLICY);
		await gate.execute({ method: "GET", path: "/tasks/101", query: { opt_fields: "this.name" } });
		expect(requests(fake)).toStrictEqual(["GET /tasks/101", "GET /tasks/101"]);
		expect(fake.calls[1]?.url.searchParams.get("opt_fields")).toMatch(/^this\.name(?:,|$)/u);
	});

	it("is sent as usual for an operation the loader does not read by", async () => {
		const { fake, gate } = await setupGate(PROJECT_POLICY);
		const response = await gate.execute({ method: "GET", path: "/project_statuses/91" });
		expect(data(response.body).resource_type).toBe("project_status");
		expect(requests(fake)).toStrictEqual([
			"GET /status_updates/91",
			"GET /projects/21",
			"GET /project_statuses/91",
		]);
	});
});

describe("a batch of reads", () => {
	it("is answered from the reads that check its actions, without sending it", async () => {
		const { fake, gate } = await setupGate(PROJECT_POLICY);
		const gids = [
			"101",
			"105",
			"107",
			"101",
			"105",
			"107",
			"101",
			"105",
			"107",
			"101",
			"105",
			"107",
		];
		const response = await gate.execute({
			method: "POST",
			path: "/batch",
			body: readsOf(gids, ["name"]),
		});
		expect(response.status).toBe(200);
		expect(items(response.body).map((result) => data(result.body as Body).gid)).toStrictEqual(gids);
		expect(items(response.body)[0]).toStrictEqual({
			status_code: 200,
			headers: {},
			body: { data: { gid: "101", name: "T1", allowed_actions: TASK_READ } },
		});
		// One read per object: the actions naming it again share it.
		expect(requests(fake)).toStrictEqual(["GET /tasks/101", "GET /tasks/105", "GET /tasks/107"]);
	});

	it("sends only its other actions, and keeps every result in its place", async () => {
		const { fake, gate } = await setupGate(`
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { project: "21" }
    allow: [task:update]
`);
		const response = await gate.execute({
			method: "POST",
			path: "/batch",
			body: {
				actions: [
					{ method: "get", relative_path: "/tasks/105", options: { fields: ["name"] } },
					{ method: "put", relative_path: "/tasks/101", data: { name: "T1 renamed" } },
					{ method: "get", relative_path: "/tasks/107", options: { fields: ["name"] } },
				],
			},
		});
		expect(items(response.body).map((result) => data(result.body as Body).name)).toStrictEqual([
			"T5 done",
			"T1 renamed",
			"T7 design",
		]);
		const batch = fake.calls.find((call) => call.url.pathname.endsWith("/batch"));
		expect(batch?.body).toMatchObject({
			actions: [{ method: "put", relative_path: "/tasks/101" }],
		});
	});
});

/** Everything is readable, but no project whose name starts with "Back" (project 21 is Backend). */
const NAMED_HIDDEN = `
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { name: { prefix: "Back" } }
    deny: [project:read]
`;

/** What GET /tasks/{gid} shows of the task's memberships when asked for `fields`. */
async function membershipsOf(gate: Gate, gid: string, fields: string): Promise<unknown> {
	const response = await gate.execute({
		method: "GET",
		path: `/tasks/${gid}`,
		query: { opt_fields: fields },
	});
	return data(response.body).memberships;
}

describe("the project and the section a task is in", () => {
	it("are judged by what placed the task, their names read from the answer, without a request for either", async () => {
		const { fake, gate } = await setupGate(NAMED_HIDDEN);
		const fields = "memberships.project.name,memberships.section.name";
		await expect(membershipsOf(gate, "101", fields)).resolves.toMatchObject([
			{ project: null, section: { gid: "31", name: "Backlog" } },
		]);
		await expect(membershipsOf(gate, "107", fields)).resolves.toMatchObject([
			{ project: { gid: "22", name: "Design System" }, section: { gid: "33", name: "Inbox" } },
		]);
		expect(requests(fake)).toStrictEqual(["GET /tasks/101", "GET /tasks/107"]);
	});

	it("are read from Asana when the answer carries no name to judge them by", async () => {
		const { fake, gate } = await setupGate(NAMED_HIDDEN);
		await expect(
			membershipsOf(gate, "101", "memberships.project.resource_type"),
		).resolves.toMatchObject([{ project: null }]);
		expect(requests(fake)).toStrictEqual(["GET /tasks/101", "GET /projects/21"]);
	});

	it("cost the items of a list no request either", async () => {
		const { fake, gate } = await setupGate(NAMED_HIDDEN);
		const response = await gate.execute({
			method: "GET",
			path: "/projects/22/tasks",
			query: { opt_fields: "memberships.project.name,memberships.section.name" },
		});
		expect(items(response.body)).toMatchObject([
			{
				gid: "107",
				memberships: [{ project: { name: "Design System" }, section: { name: "Inbox" } }],
			},
		]);
		expect(requests(fake)).toStrictEqual(["GET /projects/22", "GET /projects/22/tasks"]);
	});
});

describe("an object read to answer a request", () => {
	it("is not asked for again to place what it shows that lives in it", async () => {
		const { fake, gate } = await setupGate(PROJECT_POLICY);
		const response = await gate.execute({ method: "GET", path: "/projects/21" });
		// The project's status update lives in the project, which the read itself brought.
		expect(data(response.body).current_status_update).toMatchObject({ gid: "91" });
		expect(requests(fake).filter((request) => request === "GET /projects/21")).toHaveLength(1);
	});
});
