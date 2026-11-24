// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { askFor, parseSelection } from "../src/gate/selection.ts";
import { type Body, data, items, setupGate } from "./helpers/gate.ts";
import { fieldsSentTo, PROJECT_POLICY } from "./helpers/requests.ts";

const TASK_READ = ["task:read"];

/** {@link PROJECT_POLICY}, and tasks may be created in project 21. */
const WRITING = `${PROJECT_POLICY}  - where: { project: "21" }\n    allow: [task:create]\n`;

describe("the fields a response keeps", () => {
	it("are the name alone in a list the caller names no fields for", async () => {
		const { fake, gate } = await setupGate(PROJECT_POLICY);
		const response = await gate.execute({ method: "GET", path: "/projects/21/tasks" });
		// The gate asked where every task is, to judge it, and answers none of that.
		expect(fieldsSentTo(fake, "/projects/21/tasks")).toContain("memberships.project");
		expect(items(response.body)).toStrictEqual([
			{ gid: "101", name: "T1", allowed_actions: TASK_READ },
			{ gid: "105", name: "T5 done", allowed_actions: TASK_READ },
		]);
	});

	it("are the caller's in a list, as Asana answers them alone", async () => {
		const { gate } = await setupGate(PROJECT_POLICY);
		const response = await gate.execute({
			method: "GET",
			path: "/projects/22/tasks",
			query: { opt_fields: "completed,assignee.name" },
		});
		expect(items(response.body)).toStrictEqual([
			{
				gid: "107",
				completed: false,
				assignee: { gid: "51", name: "Me" },
				allowed_actions: TASK_READ,
			},
		]);
	});

	it("are those a list of its type shows by default, asked for with what the facts need", () => {
		const shown = ["text", "resource_subtype", "created_at", "created_by", "type"];
		const asked = askFor({ kind: "list", type: "story" }, [], () => ["target"]);
		expect(asked).toStrictEqual({
			optFields: [...shown, "target"],
			response: { kind: "list", type: "story", selection: parseSelection(shown) },
		});
	});

	it("name the type in a list of mixed types whose objects share their facts as well", () => {
		const facts = { workspace: "1", branches: [] };
		const asked = askFor({ kind: "list", type: "mixed", facts }, ["name"], () => ["workspace"]);
		// Shared facts spare what the objects' own would need, not the type each one is told by.
		expect(asked.optFields).toStrictEqual(["name", "resource_type"]);
	});

	it("name the type of each object in a list of mixed types", async () => {
		const { gate } = await setupGate(PROJECT_POLICY);
		const response = await gate.execute({
			method: "GET",
			path: "/workspaces/1/typeahead",
			query: { resource_type: "task", query: "T1" },
		});
		expect(items(response.body)).toStrictEqual([
			{ gid: "101", name: "T1", resource_type: "task", allowed_actions: TASK_READ },
		]);
	});

	it("are the caller's in the object a write answers, and the whole object without any", async () => {
		const { gate } = await setupGate(WRITING);
		const create = (query: Record<string, string>): ReturnType<typeof gate.execute> =>
			gate.execute({
				method: "POST",
				path: "/tasks",
				body: { name: "new", projects: ["21"] },
				query,
			});
		const named = await create({ opt_fields: "name" });
		expect(data(named.body)).toStrictEqual({
			gid: data(named.body).gid,
			name: "new",
			allowed_actions: ["task:read", "task:create"],
		});
		const whole = await create({});
		expect(data(whole.body)).toMatchObject({ resource_type: "task", notes: "" });
	});

	it("are kept in each action of a batch", async () => {
		const { gate } = await setupGate(PROJECT_POLICY);
		const response = await gate.execute({
			method: "POST",
			path: "/batch",
			body: { actions: [{ method: "get", relative_path: "/projects/22/tasks" }] },
		});
		expect(items(response.body).map((result) => (result.body as Body).data)).toStrictEqual([
			[{ gid: "107", name: "T7 design", allowed_actions: TASK_READ }],
		]);
	});

	it("are everything Asana sends when the caller's fields are not plain paths", async () => {
		const { gate } = await setupGate(PROJECT_POLICY);
		const response = await gate.execute({
			method: "GET",
			path: "/projects/22/tasks",
			query: { opt_fields: "this.name" },
		});
		// What Asana answers for such a field is not known, so nothing is cut.
		expect(items(response.body)[0]).toHaveProperty("memberships");
	});
});
