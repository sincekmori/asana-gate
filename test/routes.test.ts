// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { Gate } from "../src/gate/gate.ts";
import { type Fake, items, setupGate } from "./helpers/gate.ts";

const PROJECT_ONLY = `
version: 1
workspace: "1"
rules:
  - allow: [workspace:read]
  - where: { project: "21" }
    allow: [read]
`;

const TEAM_ONLY = `
version: 1
workspace: "1"
rules:
  - allow: [workspace:read, user:read]
  - where: { team: Platform }
    allow: [read]
`;

const COMPLETED_FROZEN = `
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { project: "21" }
    allow: ["task:*"]
  - where: { project: "21", completed: true }
    deny: [task:update]
`;

/** The gids of the items a list request answers with. */
async function gidsOf(gate: Gate, path: string): Promise<unknown[]> {
	const response = await gate.execute({ method: "GET", path });
	return items(response.body).map((item) => item.gid);
}

/** A `fetch` over the fake that answers every PUT with a 500 once the PUT has run. */
function failingPuts(fake: Fake): typeof globalThis.fetch {
	return async (input, init) => {
		const response = await fake.fetch(input, init);
		const failed = Response.json({ errors: [{ message: "Server Error" }] }, { status: 500 });
		return init?.method === "PUT" ? failed : response;
	};
}

describe("routes that reach the same objects", () => {
	it("filters a workspace's lists item by item, whichever path names the workspace", async () => {
		const { gate } = await setupGate(PROJECT_ONLY);
		await expect(gidsOf(gate, "/projects?workspace=1")).resolves.toStrictEqual(["21"]);
		await expect(gidsOf(gate, "/workspaces/1/projects")).resolves.toStrictEqual(["21"]);
		// Task 103 is also in project 23, which this policy does not let anyone read.
		await expect(gidsOf(gate, "/workspaces/1/tasks/search")).resolves.toStrictEqual([
			"101",
			"104",
			"105",
		]);
	});

	it("filters a user's teams like the workspace's", async () => {
		const { gate } = await setupGate(TEAM_ONLY);
		await expect(gidsOf(gate, "/workspaces/1/teams")).resolves.toStrictEqual(["11"]);
		await expect(gidsOf(gate, "/users/51/teams?organization=1")).resolves.toStrictEqual(["11"]);
	});

	it("names no object with an empty gid, `.` or `..`", async () => {
		const { gate } = await setupGate(PROJECT_ONLY);
		const responses = await Promise.all(
			["/users/.", "/users/%2E", "/tasks/.."].map((path) => gate.execute({ method: "GET", path })),
		);
		expect(responses.map((response) => response.status)).toStrictEqual([404, 404, 404]);
		await expect(gate.explain("access_request", "")).rejects.toMatchObject({ status: 404 });
		await expect(gate.explain("task", ".")).rejects.toMatchObject({ status: 404 });
	});

	it("forgets an object a write may have changed, even when Asana answers with an error", async () => {
		const { gate } = await setupGate(COMPLETED_FROZEN, { fetch: failingPuts });
		const completed = await gate.execute({
			method: "PUT",
			path: "/tasks/101",
			body: { completed: true },
		});
		expect(completed.status).toBe(500);
		// The change reached Asana: task 101 is completed now, and no longer updatable.
		await expect(
			gate.authorize({ method: "PUT", path: "/tasks/101", body: { name: "y" } }),
		).rejects.toMatchObject({ status: 403 });
	});
});
