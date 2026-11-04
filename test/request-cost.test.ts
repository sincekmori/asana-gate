// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { AsanaClient } from "../src/asana/client.ts";
import { FactsLoader } from "../src/gate/facts.ts";
import { Gate } from "../src/gate/gate.ts";
import { compilePolicy } from "../src/policy/compile.ts";
import { parsePolicy } from "../src/policy/load.ts";
import { createFakeAsana } from "./helpers/fake-asana.ts";
import { fakeResolver } from "./helpers/fake-resolver.ts";
import { type Fake, items, setupGate } from "./helpers/gate.ts";
import {
	fieldsSentTo,
	PROJECT_POLICY,
	requests,
	TEAM_POLICY,
	tracked,
} from "./helpers/requests.ts";

/** A gate over the fake whose requests go through {@link tracked}. */
async function trackedGate(
	policy: string,
	failing?: ReadonlySet<string>,
): Promise<{ fake: Fake; gate: Gate; concurrency: number[] }> {
	const fake = createFakeAsana();
	const { fetch, concurrency } = tracked(fake.fetch, failing);
	const client = new AsanaClient({ token: "t", fetch, maxRetries: 0 });
	const compiled = await compilePolicy(parsePolicy(policy), fakeResolver);
	return { fake, gate: new Gate({ client, policy: compiled }), concurrency };
}

/** The task members a policy reading nothing but placement does not need. */
const TASK_ATTRIBUTES = [
	"tags",
	"assignee",
	"completed",
	"created_by",
	"created_at",
	"due_on",
	"due_at",
	"custom_fields.gid",
	"custom_fields.display_value",
];

describe("a task's team", () => {
	it("is read from the membership, without fetching the project", async () => {
		const { fake, gate } = await setupGate(TEAM_POLICY);
		const response = await gate.execute({ method: "GET", path: "/projects/21/tasks" });
		expect(items(response.body).map((task) => task.gid)).toStrictEqual(["101", "105"]);
		expect(requests(fake)).toStrictEqual(["GET /projects/21", "GET /projects/21/tasks"]);
		expect(fieldsSentTo(fake, "/projects/21/tasks")).toStrictEqual(
			expect.arrayContaining(["memberships.project.team", "parent.memberships.project.team"]),
		);
	});

	it("is read from the project when Asana leaves it out of the membership", async () => {
		const { fake, gate } = await setupGate(TEAM_POLICY, {
			unhonoured: (_path, field) => field.endsWith("memberships.project.team"),
		});
		const response = await gate.execute({ method: "GET", path: "/projects/21/tasks" });
		expect(items(response.body).map((task) => task.gid)).toStrictEqual(["101", "105"]);
		expect(requests(fake)).toStrictEqual([
			"GET /projects/21",
			"GET /projects/21/tasks",
			"GET /projects/23",
		]);
	});

	it("is neither asked for nor looked up when no rule names a team", async () => {
		const { fake, gate } = await setupGate(PROJECT_POLICY);
		const response = await gate.execute({ method: "GET", path: "/projects/21/tasks" });
		expect(items(response.body).map((task) => task.gid)).toStrictEqual(["101", "105"]);
		expect(requests(fake)).toStrictEqual(["GET /projects/21", "GET /projects/21/tasks"]);
		expect(fieldsSentTo(fake, "/projects/21/tasks")).not.toContain("memberships.project.team");
	});
});

describe("the task members the gate asks for", () => {
	it("are only those the policy's rules read", async () => {
		const { fake, gate } = await setupGate(PROJECT_POLICY);
		await gate.execute({ method: "GET", path: "/projects/21/tasks" });
		const sent = fieldsSentTo(fake, "/projects/21/tasks");
		expect(sent).toStrictEqual(
			expect.arrayContaining([
				"name",
				"workspace",
				"parent",
				"memberships.project",
				"memberships.section",
			]),
		);
		for (const member of TASK_ATTRIBUTES) {
			expect(sent).not.toContain(member);
		}
	});

	it.each([
		["tag: ai-ok", ["tags"]],
		["assignee: me", ["assignee"]],
		["custom_field: { Owner: AI }", ["custom_fields.gid", "custom_fields.enum_value.gid"]],
		["completed: true", ["completed"]],
		["created_by: me", ["created_by"]],
		["created_within: 7d", ["created_at"]],
		["overdue: true", ["due_on", "due_at"]],
	])("include what `where: { %s }` reads", async (where, members) => {
		const { fake, gate } = await setupGate(`
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { ${where} }
    deny: [task:delete]
`);
		await gate.execute({ method: "GET", path: "/projects/21/tasks" });
		expect(fieldsSentTo(fake, "/projects/21/tasks")).toStrictEqual(expect.arrayContaining(members));
	});

	it("are all asked for when explain shows every fact", async () => {
		const fake = createFakeAsana();
		const policy = await compilePolicy(parsePolicy(PROJECT_POLICY), fakeResolver);
		const client = new AsanaClient({ token: "t", fetch: fake.fetch, maxRetries: 0 });
		const loader = new FactsLoader({ client, policy, allFacts: true });
		const loaded = await loader.load("task", "107");
		expect(loaded?.facts).toMatchObject({
			tags: new Set(["41"]),
			assignee: "51",
			state: { createdBy: "52", completed: false },
			branches: [{ team: "11", project: "22" }],
		});
		expect(requests(fake)).toStrictEqual(["GET /tasks/107"]);
		expect(fieldsSentTo(fake, "/tasks/107")).toStrictEqual(
			expect.arrayContaining([...TASK_ATTRIBUTES, "memberships.project.team"]),
		);
	});
});

describe("probing an object of unknown type", () => {
	// GET /events tries project, task, goal, portfolio and section, in that order.
	it("tries the first type alone and the others at once", async () => {
		const { fake, gate, concurrency } = await trackedGate(PROJECT_POLICY);
		await gate.execute({ method: "GET", path: "/events", query: { resource: "31" } });
		expect(requests(fake).slice(0, 5)).toStrictEqual([
			"GET /projects/31",
			"GET /tasks/31",
			"GET /goals/31",
			"GET /portfolios/31",
			"GET /sections/31",
		]);
		expect(concurrency.slice(0, 5)).toStrictEqual([1, 1, 2, 3, 4]);
	});

	it("costs one request when the first type is the object's", async () => {
		const { fake, gate } = await trackedGate(PROJECT_POLICY);
		await gate.execute({ method: "GET", path: "/events", query: { resource: "21" } });
		expect(requests(fake)).toStrictEqual(["GET /projects/21", "GET /events"]);
	});

	it("ignores an error of a type after the one that exists", async () => {
		const { gate } = await trackedGate(PROJECT_POLICY, new Set(["/goals/101"]));
		const response = await gate.execute({
			method: "GET",
			path: "/events",
			query: { resource: "101" },
		});
		expect(response.status).toBe(412);
	});

	it("fails on an error of a type before the one that exists", async () => {
		const { gate } = await trackedGate(PROJECT_POLICY, new Set(["/goals/31"]));
		const response = await gate.execute({
			method: "GET",
			path: "/events",
			query: { resource: "31" },
		});
		expect(response.status).toBe(500);
	});
});
