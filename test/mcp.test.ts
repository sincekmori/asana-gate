// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { TOOLS } from "../src/mcp/tools.ts";
import { callTool as call, connectMcp as setup } from "./helpers/mcp.ts";

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
});
