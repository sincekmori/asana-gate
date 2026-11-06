// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { fakeResolver } from "./helpers/fake-resolver.ts";
import { data, message, setupGate } from "./helpers/gate.ts";

const POLICY = `
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { project: "21" }
    allow: ["task:*", story:create]
    require:
      task:
        name: { prefix: "[AI] ", max_length: 40 }
        due_on: { present: true, min: "2026-01-01" }
        custom_fields: { Owner: { in: [AI] } }
    apply:
      task:
        name: { prefix: "[AI] " }
        tags: { add: ["41"] }
        custom_fields: { Owner: AI }
    forbid: { task: [html_notes] }
    limit: { "task:create": { max: 2, per: 1h } }
    confirm: [task:delete]
  - where: { project: "22" }
    allow: [read, task:create]
    redact: { task: [notes] }
  - where: { project: "21", completed: true }
    deny: [task:update]
  - where: { project: "22", created_by: me }
    allow: [task:delete]
  - where: { task: "103" }
    deny: ["*"]
`;

function setup(): ReturnType<typeof setupGate> {
	return setupGate(POLICY);
}

describe("constraints in the gate", () => {
	it("completes a create request with defaults, prefixes and list members", async () => {
		const { fake, gate } = await setup();
		const response = await gate.execute({
			method: "POST",
			path: "/tasks",
			body: { name: "write docs", projects: ["21"], due_on: "2026-12-01" },
		});
		expect(response.status).toBe(201);
		const gid = String(data(response.body).gid);
		expect(fake.store.get("task", gid)?.name).toBe("[AI] write docs");
		expect(fake.store.get("task", gid)?.tags).toStrictEqual([{ gid: "41", resource_type: "tag" }]);
		// The option name in the policy is sent as the option gid Asana expects.
		expect(fake.calls.at(-1)?.body).toMatchObject({ custom_fields: { "61": "71" } });
	});

	it("accepts the enum option gid where the policy names the option", async () => {
		const { gate } = await setup();
		const response = await gate.execute({
			method: "POST",
			path: "/tasks",
			body: { name: "x", projects: ["21"], due_on: "2026-12-01", custom_fields: { "61": "71" } },
		});
		expect(response.status).toBe(201);
	});

	it("does not shape bodies that describe something other than the resource", async () => {
		const { gate } = await setup();
		// A duplicate's body (name, include) cannot carry `due_on`, which project 21 requires.
		const duplicate = await gate.authorize({
			method: "POST",
			path: "/tasks/101/duplicate",
			body: { name: "copy", include: ["notes"] },
		});
		expect(duplicate.plan.data).toBeUndefined();
		// Followers are checked against a field allowlist but not completed by `apply`.
		const followers = await gate.authorize({
			method: "POST",
			path: "/tasks/101/addFollowers",
			body: { followers: ["52"] },
		});
		expect(followers.plan.data).toBeUndefined();
		expect(followers.plan.checks[0]?.fields?.keys).toStrictEqual(["followers"]);
	});

	it("refuses a create request that misses a required member or breaks a rule", async () => {
		const { gate } = await setup();
		const missing = await gate.execute({
			method: "POST",
			path: "/tasks",
			body: { name: "x", projects: ["21"] },
		});
		expect(missing.status).toBe(400);
		expect(message(missing.body)).toContain("due_on is required");
		const forbidden = await gate.execute({
			method: "POST",
			path: "/tasks",
			body: { name: "x", projects: ["21"], due_on: "2026-12-01", html_notes: "<body/>" },
		});
		expect(message(forbidden.body)).toContain("html_notes may not be set");
		const wrongOwner = await gate.execute({
			method: "POST",
			path: "/tasks",
			body: { name: "x", projects: ["21"], due_on: "2026-12-01", custom_fields: { "61": "Human" } },
		});
		expect(message(wrongOwner.body)).toContain('custom field "Owner" must be one of AI');
	});

	it("shapes updates too, and keeps required members from being cleared", async () => {
		const { fake, gate } = await setup();
		await expect(
			gate.execute({ method: "PUT", path: "/tasks/101", body: { name: "renamed" } }),
		).resolves.toMatchObject({
			status: 200,
		});
		expect(fake.store.get("task", "101")?.name).toBe("[AI] renamed");
		const cleared = await gate.execute({
			method: "PUT",
			path: "/tasks/101",
			body: { due_on: null },
		});
		expect(cleared.status).toBe(400);
		expect(message(cleared.body)).toContain("due_on cannot be cleared");
	});

	it("redacts members from responses", async () => {
		const { gate } = await setup();
		const response = await gate.execute({ method: "GET", path: "/tasks/107" });
		expect(response.status).toBe(200);
		expect(data(response.body)).not.toHaveProperty("notes");
		expect(data(response.body).name).toBe("T7 design");
	});

	it("caps how often an action runs in a scope", async () => {
		const { gate } = await setup();
		const body = { name: "x", projects: ["21"], due_on: "2026-12-01" };
		await expect(gate.execute({ method: "POST", path: "/tasks", body })).resolves.toMatchObject({
			status: 201,
		});
		await expect(gate.execute({ method: "POST", path: "/tasks", body })).resolves.toMatchObject({
			status: 201,
		});
		const third = await gate.execute({ method: "POST", path: "/tasks", body });
		expect(third.status).toBe(429);
		expect(message(third.body)).toContain("task:create is limited to 2 per 1h");
	});

	it("asks for confirmation before confirmed actions", async () => {
		const { fake, gate } = await setup();
		const unasked = await gate.execute({ method: "DELETE", path: "/tasks/101" });
		expect(unasked.status).toBe(428);
		const declined = await gate.execute(
			{ method: "DELETE", path: "/tasks/101" },
			{ confirm: () => Promise.resolve(false) },
		);
		expect(declined.status).toBe(403);
		expect(fake.store.get("task", "101")).toBeDefined();
		const asked: string[] = [];
		const accepted = await gate.execute(
			{ method: "DELETE", path: "/tasks/101" },
			{
				confirm: (pending) => {
					asked.push(...pending.map((p) => `${p.action} ${p.gid} ${String(p.name)}`));
					return Promise.resolve(true);
				},
			},
		);
		expect(accepted.status).toBe(200);
		expect(asked).toStrictEqual(["task:delete 101 T1"]);
	});

	it("checks permissions before constraints, so a refusal reveals nothing", async () => {
		const { gate } = await setup();
		const body = { html_notes: "<body/>" };
		const hidden = await gate.execute({ method: "PUT", path: "/tasks/103", body });
		expect(hidden.status).toBe(404);
		expect(message(hidden.body)).toBe("task: Not a recognized ID: 103");
		const denied = await gate.execute({ method: "PUT", path: "/tasks/105", body });
		expect(denied.status).toBe(403);
	});

	it("shapes every create and update the same way, whatever the operation", async () => {
		const { gate } = await setupGate(`
version: 1
workspace: "1"
rules:
  - allow: [read, tag:create, task:update]
    require: { tag: { name: { prefix: "ai-" } } }
    fields: { task: [completed] }
`);
		const tag = { method: "POST", path: "/workspaces/1/tags", body: { name: "x" } } as const;
		await expect(gate.authorize(tag)).rejects.toMatchObject({ status: 400 });
		await expect(gate.authorize(tag)).rejects.toThrow("must start with");
		const followers = await gate.execute({
			method: "POST",
			path: "/tasks/101/addFollowers",
			body: { followers: ["52"] },
		});
		expect(followers.status).toBe(403);
		expect(message(followers.body)).toContain("updating task.followers is not permitted");
	});

	it("filters on the object's state", async () => {
		const { gate } = await setup();
		await expect(
			gate.execute({ method: "PUT", path: "/tasks/105", body: { name: "x" } }),
		).resolves.toMatchObject({
			status: 403,
		});
		await expect(gate.execute({ method: "DELETE", path: "/tasks/107" })).resolves.toMatchObject({
			status: 403,
		});
		const mine = await gate.execute({
			method: "POST",
			path: "/tasks",
			body: { name: "mine", projects: ["22"] },
		});
		const gid = String(data(mine.body).gid);
		await expect(gate.execute({ method: "DELETE", path: `/tasks/${gid}` })).resolves.toMatchObject({
			status: 200,
		});
	});
});

describe("users in constraints and scopes", () => {
	const ASSIGNED_TO_ME = `
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { project: "21" }
    allow: [task:create]
    require: { task: { assignee: { in: [me] } } }
`;

	it("compares an assignee by the user it names, however the request names them", async () => {
		const { gate } = await setupGate(ASSIGNED_TO_ME);
		const create = (assignee: string): Promise<{ status: number }> =>
			gate.execute({
				method: "POST",
				path: "/tasks",
				body: { name: "x", projects: ["21"], assignee },
			});
		const responses = await Promise.all(
			["me", "51", "me@acme.test", "bob@acme.test", "52"].map((who) => create(who)),
		);
		expect(responses.map((response) => response.status)).toStrictEqual([201, 201, 201, 400, 400]);
	});

	it("does not take an unassigned task for the token's user when that user has no email", async () => {
		const policy = `
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { project: "21" }
    allow: [task:create]
  - where: { project: "21", assignee: me }
    deny: [task:create]
`;
		const { gate } = await setupGate(policy, {
			resolver: { ...fakeResolver, me: () => Promise.resolve({ gid: "51", name: "Me" }) },
		});
		await expect(
			gate.authorize({ method: "POST", path: "/tasks", body: { name: "x", projects: ["21"] } }),
		).resolves.toBeDefined();
		await expect(
			gate.authorize({
				method: "POST",
				path: "/tasks",
				body: { name: "x", projects: ["21"], assignee: "me" },
			}),
		).rejects.toMatchObject({ status: 403 });
	});
});
