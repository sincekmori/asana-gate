// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import type { PendingConfirmation } from "../src/gate/errors.ts";
import { type Body, message, setupGate } from "./helpers/gate.ts";

const POLICY = `
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { project: "21" }
    allow: ["task:*"]
    require: { task: { due_on: true } }
    apply:
      task:
        name: { prefix: "[AI] " }
        notes: { value: "forced" }
        tags: { add: ["41"] }
        due_on: { default: "2026-12-31" }
    limit: { "task:create": { max: 3, per: 1h } }
  - where: { task: "103" }
    deny: ["*"]
`;

const create = (name: string): Body => ({
	method: "post",
	relative_path: "/tasks",
	data: { name, projects: ["21"] },
});

/** The actions of the last `POST /batch` the fake received. */
function sentActions(calls: { url: URL; body?: unknown }[]): Body[] {
	const batch = calls.findLast((call) => call.url.pathname.endsWith("/batch"));
	return ((batch?.body as Body | undefined)?.actions ?? []) as Body[];
}

describe("batch", () => {
	it("sends each write as the policy shaped it, like a single request", async () => {
		const { fake, gate } = await setupGate(POLICY);
		const response = await gate.execute({
			method: "POST",
			path: "/batch",
			body: { actions: [create("one")] },
		});
		expect(response.status).toBe(200);
		expect(sentActions(fake.calls)[0]?.data).toStrictEqual({
			name: "[AI] one",
			projects: ["21"],
			notes: "forced",
			tags: ["41"],
			due_on: "2026-12-31",
		});
	});

	it("counts each action of a batch against a limit", async () => {
		const { gate } = await setupGate(POLICY);
		const tooMany = await gate.execute({
			method: "POST",
			path: "/batch",
			body: { actions: [create("a"), create("b"), create("c"), create("d")] },
		});
		expect(tooMany.status).toBe(429);
		const two = await gate.execute({
			method: "POST",
			path: "/batch",
			body: { actions: [create("a"), create("b")] },
		});
		expect(two.status).toBe(200);
		const third = await gate.execute({
			method: "POST",
			path: "/batch",
			body: { actions: [create("c")] },
		});
		expect(third.status).toBe(200);
		const fourth = await gate.execute({ method: "POST", path: "/tasks", body: create("d").data });
		expect(fourth.status).toBe(429);
	});

	it("names the refused action", async () => {
		const { gate } = await setupGate(POLICY);
		const refused = await gate.execute({
			method: "POST",
			path: "/batch",
			body: {
				actions: [
					{ relative_path: "/tasks/101", method: "get" },
					{ relative_path: "/tasks/103", method: "get" },
				],
			},
		});
		expect(refused.status).toBe(404);
		expect(message(refused.body)).toBe("actions[1]: task: Not a recognized ID: 103");
	});

	it("merges a read's opt_fields into options.fields", async () => {
		const { fake, gate } = await setupGate(POLICY);
		await gate.execute({
			method: "POST",
			path: "/batch",
			body: {
				actions: [
					{
						relative_path: "/projects/21/tasks",
						method: "get",
						data: { opt_fields: "name,notes", limit: 5 },
					},
				],
			},
		});
		const [action] = sentActions(fake.calls);
		expect(action?.data).toStrictEqual({ limit: 5 });
		const fields = (action?.options as Body | undefined)?.fields as string[];
		expect(fields).toContain("notes");
		expect(fields).toContain("memberships.project");
	});
});

const CONFIRMED = `
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { project: "21" }
    allow: ["task:*"]
    limit: { "task:delete": { max: 1, per: 1h } }
    confirm: [task:delete]
`;

/** A person who takes a moment to say yes. */
async function slow(): Promise<boolean> {
	await delay(10);
	return true;
}

describe("limits and confirmations", () => {
	it("takes a limit's slot before asking, so concurrent confirmations cannot exceed it", async () => {
		const { gate } = await setupGate(CONFIRMED);
		const results = await Promise.all([
			gate.execute({ method: "DELETE", path: "/tasks/101" }, { confirm: slow }),
			gate.execute({ method: "DELETE", path: "/tasks/105" }, { confirm: slow }),
		]);
		expect(results.map((result) => result.status).toSorted((a, b) => a - b)).toStrictEqual([
			200, 429,
		]);
	});

	it("gives the slot back when the person declines", async () => {
		const { gate } = await setupGate(CONFIRMED);
		const asked: PendingConfirmation[][] = [];
		const declined = await gate.execute(
			{ method: "DELETE", path: "/tasks/101" },
			{
				confirm: (pending) => {
					asked.push([...pending]);
					return Promise.resolve(false);
				},
			},
		);
		expect(declined.status).toBe(403);
		expect(asked).toHaveLength(1);
		const accepted = await gate.execute(
			{ method: "DELETE", path: "/tasks/101" },
			{ confirm: () => Promise.resolve(true) },
		);
		expect(accepted.status).toBe(200);
	});
});
