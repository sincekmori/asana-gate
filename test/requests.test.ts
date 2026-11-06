// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { GateRequest } from "../src/gate/gate.ts";
import { TOOLS } from "../src/mcp/tools.ts";
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

const attach = TOOLS.find((spec) => spec.name === "asana_create_attachment");
const createTask = TOOLS.find((spec) => spec.name === "asana_create_task");
const getUser = TOOLS.find((spec) => spec.name === "asana_get_user");

/** The request of asana_create_attachment for a link. */
function linkRequest(parent: string, name: string, policy: Policy): GateRequest {
	const request = attach?.request({ parent, url: `https://example.test/${name}`, name }, policy);
	if (request === undefined) {
		throw new Error("asana_create_attachment is missing");
	}
	return request;
}

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
		expect(fake.calls.at(-1)?.form?.name).toBe("[AI] doc");
	});
});

describe("request bodies and paths", () => {
	it("refuses a section without its project instead of creating the task elsewhere", () => {
		expect(createTask?.input.safeParse({ name: "x", section: "31" }).success).toBe(false);
		expect(
			createTask?.input.safeParse({ name: "x", projects: ["21"], section: "31" }).success,
		).toBe(true);
	});

	it("names the workspace for a task without a project or parent, an empty list included", async () => {
		const { gate } = await setupGate(POLICY);
		const sent = (input: Record<string, unknown>): unknown =>
			createTask?.request(createTask.input.parse({ name: "x", ...input }), gate.policy).body;
		expect(sent({ projects: [] })).toMatchObject({ workspace: "1" });
		expect(sent({ projects: ["21"] })).not.toHaveProperty("workspace");
		expect(sent({ parent: "101" })).not.toHaveProperty("workspace");
	});

	it("needs a user to read, since an empty one would read the list of users", () => {
		expect(getUser?.input.safeParse({ user: "" }).success).toBe(false);
		expect(getUser?.input.safeParse({ user: "me" }).success).toBe(true);
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
