// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import * as z from "zod";

import type { GateRequest } from "../src/gate/gate.ts";
import { type AnyToolSpec, type ToolRequest, TOOLS } from "../src/mcp/tools.ts";
import type { Policy } from "../src/policy/types.ts";
import { message, setupGate } from "./helpers/gate.ts";

const POLICY = `
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { project: "21" }
    allow: ["task:*", attachment:create]
    forbid: { attachment: [url] }
  - where: { project: "22" }
    allow: [attachment:create]
    apply: { attachment: { name: { prefix: "[AI] " } } }
`;

/** A tool that must exist. */
function toolNamed(name: string): AnyToolSpec {
	const found = TOOLS.find((spec) => spec.name === name);
	if (found === undefined) {
		throw new Error(`${name} is missing`);
	}
	return found;
}

/** What a tool's input schema holds against `input`; nothing when it takes it. */
function problemsOf(name: string, input: unknown): string {
	const parsed = toolNamed(name).input.safeParse(input);
	return parsed.success ? "" : z.prettifyError(parsed.error);
}

/** The request a tool makes of `input`. */
function requestOf(name: string, input: unknown, policy: Policy): ToolRequest {
	const spec = toolNamed(name);
	return spec.request(spec.input.parse(input), policy);
}

/** The request of asana_create_attachment for a link. */
const linkRequest = (parent: string, name: string, policy: Policy): GateRequest =>
	requestOf(
		"asana_create_attachment",
		{ parent, url: `https://example.test/${name}`, name },
		policy,
	);

/** The status of a GET of `path`. */
async function statusOf(
	gate: Awaited<ReturnType<typeof setupGate>>["gate"],
	path: string,
): Promise<number> {
	const response = await gate.execute({ method: "GET", path });
	return response.status;
}

describe("attachments", () => {
	it("checks the members the form carries", async () => {
		const { gate } = await setupGate(POLICY);
		const response = await gate.execute(linkRequest("101", "exfil", gate.policy));
		expect(response.status).toBe(400);
		expect(message(response.body)).toContain("url may not be set");
	});

	it("sends the members as the policy shaped them", async () => {
		const { fake, gate } = await setupGate(POLICY);
		const response = await gate.execute(linkRequest("107", "doc", gate.policy));
		expect(response.status).toBe(201);
		expect(fake.calls.find((call) => call.method === "POST")?.form?.name).toBe("[AI] doc");
	});
});

describe("request bodies and paths", () => {
	it("refuses a section without its project instead of creating the task elsewhere", () => {
		expect(problemsOf("asana_create_task", { name: "x", section: "31" })).toContain(
			"section needs projects",
		);
		expect(problemsOf("asana_create_task", { name: "x", projects: ["21"], section: "31" })).toBe(
			"",
		);
	});

	it("names the workspace for a task without a project or parent, an empty list included", async () => {
		const { gate } = await setupGate(POLICY);
		const sent = (input: Record<string, unknown>): unknown =>
			requestOf("asana_create_task", { name: "x", ...input }, gate.policy).body;
		expect(sent({ projects: [] })).toMatchObject({ workspace: "1" });
		expect(sent({ projects: ["21"] })).not.toHaveProperty("workspace");
		expect(sent({ parent: "101" })).not.toHaveProperty("workspace");
	});

	it("needs a user to read, since an empty one would read the list of users", () => {
		expect(problemsOf("asana_get_user", { user: "" })).not.toBe("");
		expect(problemsOf("asana_get_user", { user: "me" })).toBe("");
	});

	it("refuses a member an input does not declare, in a batch item too, instead of dropping it", () => {
		expect(problemsOf("asana_create_comment", { task_gid: "101", parent_comment: "9" })).toContain(
			'Unrecognized key: "parent_comment"',
		);
		expect(problemsOf("asana_create_tasks", { tasks: [{ name: "x", bogus: 1 }] })).toContain(
			'Unrecognized key: "bogus"',
		);
		expect(problemsOf("asana_create_tasks", { tasks: [{ name: "x" }] })).toBe("");
	});

	it("sends a search filter under the dotted name Asana gives it", async () => {
		const { gate } = await setupGate(POLICY);
		const sent = requestOf(
			"asana_search_tasks",
			{
				created_by_any: ["me"],
				due_on: "2026-11-30",
				due_on_before: "2026-12-01",
				is_subtask: true,
			},
			gate.policy,
		);
		expect(sent.query).toStrictEqual({
			"created_by.any": "me",
			due_on: "2026-11-30",
			"due_on.before": "2026-12-01",
			is_subtask: "true",
		});
	});

	it("writes records in one batch, an action per record", async () => {
		const { gate } = await setupGate(POLICY);
		const records = [
			{ name: "a", table: "71" },
			{ name: "b", table: "71", custom_fields: { "5": "x" } },
		];
		expect(requestOf("asana_create_records", { records }, gate.policy)).toStrictEqual({
			method: "POST",
			path: "/batch",
			body: {
				actions: records.map((data) => ({ method: "post", relative_path: "/records", data })),
			},
		});
		const renamed = requestOf(
			"asana_update_records",
			{ records: [{ record_gid: "81", name: "c" }] },
			gate.policy,
		);
		expect(renamed.body).toStrictEqual({
			actions: [{ method: "put", relative_path: "/records/81", data: { name: "c" } }],
		});
	});

	it("reads the notifications and the teams of a user in the governed workspace", async () => {
		const { gate } = await setupGate(POLICY);
		expect(requestOf("asana_list_notifications", { limit: 5 }, gate.policy)).toStrictEqual({
			method: "GET",
			path: "/users/me/notifications",
			query: { workspace: "1", limit: "5" },
		});
		expect(requestOf("asana_list_user_teams", { user: "me" }, gate.policy)).toStrictEqual({
			method: "GET",
			path: "/users/me/teams",
			query: { organization: "1" },
		});
	});

	it("reads a task and a project with the parts asked for, and alone otherwise", async () => {
		const { gate } = await setupGate(POLICY);
		expect(requestOf("asana_get_task", { task_gid: "101" }, gate.policy).include).toStrictEqual({});
		const task = requestOf(
			"asana_get_task",
			{ task_gid: "101", include_comments: true, comment_limit: 3 },
			gate.policy,
		);
		expect(task.include).toStrictEqual({
			comments: {
				method: "GET",
				path: "/tasks/101/stories",
				query: { resource_subtype: "comment_added", sort_ascending: "false", limit: "3" },
			},
		});
		const project = requestOf(
			"asana_get_project",
			{ project_gid: "21", include_sections: true, include_task_counts: true },
			gate.policy,
		);
		expect(project.include).toStrictEqual({
			sections: { method: "GET", path: "/projects/21/sections", query: { limit: "100" } },
			task_counts: requestOf("asana_get_project_task_counts", { project_gid: "21" }, gate.policy),
		});
	});

	it("reads Asana's { data, options } envelope, and refuses other envelopes", async () => {
		const { gate } = await setupGate(POLICY);
		const enveloped = await gate.execute({
			method: "POST",
			path: "/tasks",
			body: { data: { name: "x", projects: ["21"] }, options: { fields: ["name"] } },
		});
		expect(enveloped.status).toBe(201);
		const odd = await gate.execute({
			method: "POST",
			path: "/tasks",
			body: { data: { name: "x", projects: ["21"] }, extra: true },
		});
		expect(odd.status).toBe(400);
	});

	it("answers a malformed path like an unknown route", async () => {
		const { gate } = await setupGate(POLICY);
		const paths = ["/tasks/%E0%A4%A", "/tasks/\uD800", "https://", "/tasks/%"];
		const statuses = await Promise.all(paths.map((path) => statusOf(gate, path)));
		expect(statuses).toStrictEqual([404, 404, 404, 404]);
	});
});
