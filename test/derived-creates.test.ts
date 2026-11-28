// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { message, setupGate } from "./helpers/gate.ts";

/**
 * Projects in team Platform must be private, prefixed and described; tasks in
 * project 21 prefixed and due; portfolio 81 (Roadmap) may be copied under a
 * prefixed name.
 */
const POLICY = `
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { team: "11" }
    allow: [project:create]
    require:
      project:
        name: { prefix: "[AI] " }
        privacy_setting: { in: [private] }
        notes: true
  - where: { project: "21" }
    allow: [task:create]
    require:
      task:
        due_on: true
    apply:
      task:
        name: { prefix: "[AI] " }
  - where: { portfolio: "81" }
    allow: [portfolio:create]
    require:
      portfolio:
        name: { prefix: "[AI] " }
`;

/** The gate under {@link POLICY}, with project template 95 in team Platform and task template 96 in project 21. */
async function setup(): ReturnType<typeof setupGate> {
	const setUp = await setupGate(POLICY);
	setUp.fake.store.put({
		gid: "95",
		resource_type: "project_template",
		name: "Quarterly plan",
		team: { gid: "11", resource_type: "team" },
	});
	setUp.fake.store.put({
		gid: "96",
		resource_type: "task_template",
		name: "Bug report",
		project: { gid: "21", resource_type: "project" },
	});
	return setUp;
}

describe("objects made from a copy or a template", () => {
	it("hold an instantiated project's name and privacy to the policy, and leave the rest to the template", async () => {
		const { fake, gate } = await setup();
		const path = "/project_templates/95/instantiateProject";
		const refused = await gate.execute({
			method: "POST",
			path,
			body: { name: "Q4 plan", privacy_setting: "public_to_workspace" },
		});
		expect(refused.status).toBe(400);
		expect(message(refused.body)).toContain('name must start with "[AI] "');
		expect(message(refused.body)).toContain("privacy_setting must be one of private");
		// `notes` is the template's to bring, so its requirement does not hold the request back.
		const body = { name: "[AI] Q4 plan", privacy_setting: "private", is_strict: false };
		await expect(gate.authorize({ method: "POST", path, body })).resolves.toMatchObject({
			plan: { data: body },
		});
		expect(fake.calls.filter((call) => call.method === "POST")).toHaveLength(0);
	});

	it("shape the name a duplicate or a task from a template is given, not what its source brings", async () => {
		const { gate } = await setup();
		// `due_on` comes with the copy, so the requirement on it does not hold the request back.
		await expect(
			gate.authorize({
				method: "POST",
				path: "/tasks/101/duplicate",
				body: { name: "copy", include: ["notes"] },
			}),
		).resolves.toMatchObject({ plan: { data: { name: "[AI] copy", include: ["notes"] } } });
		await expect(
			gate.authorize({
				method: "POST",
				path: "/task_templates/96/instantiateTask",
				body: { name: "crash on save" },
			}),
		).resolves.toMatchObject({ plan: { data: { name: "[AI] crash on save" } } });
		const copies = await Promise.all(
			["/projects/21/duplicate", "/portfolios/81/duplicate"].map((path) =>
				gate.execute({ method: "POST", path, body: { name: "copy" } }),
			),
		);
		expect(copies.map((copy) => copy.status)).toStrictEqual([400, 400]);
		expect(copies.map((copy) => message(copy.body))).toStrictEqual([
			'asana-gate: the project does not satisfy the policy: name must start with "[AI] "',
			'asana-gate: the portfolio does not satisfy the policy: name must start with "[AI] "',
		]);
	});
});
