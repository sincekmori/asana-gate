// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { TOOLS } from "../src/mcp/tools.ts";
import { callTool as call, connectMcp as setup } from "./helpers/mcp.ts";
import { fieldsSentTo } from "./helpers/requests.ts";

/** The instructions a client gets from a server under `policy` (the helper's default when absent). */
async function instructionsUnder(policy?: string): Promise<string> {
	const { client, close } = await setup(policy);
	const instructions = client.getInstructions() ?? "";
	await close();
	return instructions;
}

describe("mcp server", () => {
	it("lists the curated tools the policy could allow, in their order, then the generic ones", async () => {
		const { client, close } = await setup();
		const { tools } = await client.listTools();
		await close();
		const names = tools.map((t) => t.name);
		const curated = names.slice(0, -3);
		expect(names.slice(-3)).toStrictEqual([
			"asana_request",
			"asana_operations",
			"asana_allowed_actions",
		]);
		expect(curated).toStrictEqual(
			TOOLS.map((t) => t.name).filter((name) => curated.includes(name)),
		);
		expect(curated).toStrictEqual(
			expect.arrayContaining([
				"asana_get_task",
				"asana_create_task",
				"asana_create_tasks",
				"asana_delete_task",
				"asana_create_comment",
			]),
		);
		expect(curated).not.toContain("asana_create_project");
		expect(curated).not.toContain("asana_add_tag_to_task");
	});

	it("annotates read-only and destructive tools", async () => {
		const { client, close } = await setup();
		const { tools } = await client.listTools();
		await close();
		expect(tools.find((t) => t.name === "asana_get_task")?.annotations?.readOnlyHint).toBe(true);
		expect(tools.find((t) => t.name === "asana_delete_task")?.annotations?.destructiveHint).toBe(
			true,
		);
	});

	it("returns gated objects with allowed_actions as structured content", async () => {
		const { client, close } = await setup();
		const result = await call(client, "asana_get_task", { task_gid: "101" });
		await close();
		expect(result.isError).toBeUndefined();
		const { data } = result.structuredContent as { data: Record<string, unknown> };
		expect(data.name).toBe("T1");
		expect(data.allowed_actions).toContain("task:update");
	});

	it("reports refusals as tool errors shaped like Asana responses", async () => {
		const { client, close } = await setup();
		const hidden = await call(client, "asana_get_task", { task_gid: "102" });
		expect(hidden.isError).toBe(true);
		expect(hidden.content[0]?.text).toContain("task: Not a recognized ID: 102");
		const refused = await call(client, "asana_update_task", { task_gid: "105", completed: true });
		await close();
		expect(refused.isError).toBe(true);
		expect(refused.structuredContent?.status).toBe(403);
	});

	it("refuses an argument a tool does not declare, by name, instead of running without it", async () => {
		const { client, fake, close } = await setup();
		// Without the argument this is a top-level comment the policy allows: not what was asked.
		const reply = await call(client, "asana_create_comment", {
			task_gid: "101",
			text: "a reply",
			parent_comment: "9",
		});
		const generic = await call(client, "asana_request", {
			method: "POST",
			path: "/tasks/101/stories",
			data: { text: "a reply" },
		});
		await close();
		expect(reply.isError).toBe(true);
		expect(reply.content[0]?.text).toContain('Unrecognized key: "parent_comment"');
		expect(generic.isError).toBe(true);
		expect(generic.content[0]?.text).toContain('Unrecognized key: "data"');
		expect(fake.calls.map((sent) => sent.method)).not.toContain("POST");
	});

	it("counts a project's tasks without being told which counts to ask Asana for", async () => {
		const { client, fake, close } = await setup();
		const counted = await call(client, "asana_get_project_task_counts", { project_gid: "21" });
		await close();
		expect(fieldsSentTo(fake, "/task_counts")).toContain("num_incomplete_tasks");
		const { data } = counted.structuredContent as { data: Record<string, unknown> };
		expect(data.num_tasks).toBeTypeOf("number");
	});

	it("reads a task with its comments and its subtasks in one call", async () => {
		const { client, close } = await setup();
		const read = await call(client, "asana_get_task", {
			task_gid: "101",
			include_comments: true,
			include_subtasks: true,
		});
		await close();
		const { data } = read.structuredContent as { data: Record<string, { gid: string }[]> };
		expect(data.comments?.map((comment) => comment.gid)).toStrictEqual(["501"]);
		expect(data.subtasks?.map((subtask) => subtask.gid)).toStrictEqual(["104"]);
	});

	it("serves the generic request tool", async () => {
		const { client, close } = await setup();
		const sections = await call(client, "asana_request", {
			method: "GET",
			path: "/projects/21/sections",
		});
		await close();
		expect(sections.isError).toBeUndefined();
		expect((sections.structuredContent as { data: unknown[] }).data).toHaveLength(2);
	});

	it("marks the operations Asana's documentation deprecates, naming their successors", async () => {
		const { client, close } = await setup();
		const listed = await call(client, "asana_operations", { search: "getProjectMembership" });
		const body = listed.structuredContent as {
			operations: { operation_id: string; deprecated?: boolean; use?: string }[];
		};
		expect(
			body.operations
				.map((op) => [op.operation_id, op.deprecated, op.use])
				.toSorted((a, b) => String(a[0]).localeCompare(String(b[0]))),
		).toStrictEqual([
			["getProjectMembership", true, "getMembership"],
			["getProjectMembershipsForProject", true, "getMemberships"],
		]);
		await close();
	});

	it("serves the catalog and per-object explanations", async () => {
		const { client, close } = await setup();
		const operations = await call(client, "asana_operations", { search: "stories", limit: 3 });
		const body = operations.structuredContent as {
			total: number;
			operations: { action: string }[];
		};
		expect(body.total).toBeGreaterThanOrEqual(9);
		expect(body.operations[0]?.action).toMatch(/^story:/u);
		const allowed = await call(client, "asana_allowed_actions", {
			resource_type: "task",
			gid: "105",
		});
		const explanation = allowed.structuredContent as {
			allowed_actions: string[];
			denied_actions: string[];
		};
		expect(explanation.denied_actions).toContain("task:update");
		expect(explanation.allowed_actions).toContain("task:delete");
		const invisible = await call(client, "asana_allowed_actions", {
			resource_type: "task",
			gid: "102",
		});
		await close();
		expect(invisible.isError).toBe(true);
	});

	it("tells the constraints in force where an object is, as the policy writes them", async () => {
		const { client, close } = await setup(`
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { project: "21" }
    allow: ["task:*"]
    require:
      task:
        name: { prefix: "[AI] ", not_matches: secret }
        custom_fields: { "61": { in: ["71"] } }
    apply: { task: { tags: { add: ["41"] } } }
    forbid: { task: [html_notes] }
    limit: { "task:create": { max: 2, per: 1h } }
    confirm: [task:delete]
  - where: { project: "22" }
    redact: { task: [notes] }
`);
		const constraintsAt = async (gid: string): Promise<unknown> => {
			const answer = await call(client, "asana_allowed_actions", { resource_type: "project", gid });
			return answer.structuredContent?.constraints;
		};
		// What a task made or changed in the project meets, as a request sends it.
		await expect(constraintsAt("21")).resolves.toStrictEqual({
			require: {
				task: {
					name: [{ prefix: "[AI] ", not_matches: "/secret/u" }],
					"custom_fields.61": [{ in: ["71"] }],
				},
			},
			apply: { task: { tags: { add: ["41"] } } },
			forbid: { task: ["html_notes"] },
			limit: { "task:create": [{ max: 2, per: "1h" }] },
			confirm: ["task:delete"],
		});
		await expect(constraintsAt("22")).resolves.toStrictEqual({ redact: { task: ["notes"] } });
		// Where no constraint is in force, the answer names none.
		await expect(constraintsAt("23")).resolves.toBeUndefined();
		await close();
	});

	it("tells the agent whom it acts as, showing the user's name and email as the policy would", async () => {
		const scoped = `version: 1\nworkspace: "1"\nrules:\n  - allow: [workspace:read]\n  - where: { project: "21" }\n    allow: [read]\n`;
		const workspace = 'in the workspace "Acme" (gid 1)';
		await expect(instructionsUnder()).resolves.toContain(
			`the access token belongs to ("Me", me@acme.test, gid 51), ${workspace}`,
		);
		await expect(instructionsUnder(scoped)).resolves.toContain(
			`the access token belongs to (gid 51), ${workspace}`,
		);
		await expect(
			instructionsUnder(`${scoped}  - allow: [user:read]\n    redact: { user: [email] }\n`),
		).resolves.toContain(`the access token belongs to ("Me", gid 51), ${workspace}`);
	});
});
