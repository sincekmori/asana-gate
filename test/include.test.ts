// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { answer, type ToolRequest } from "../src/mcp/tools.ts";
import { type Body, data, setupGate } from "./helpers/gate.ts";
import { requests } from "./helpers/requests.ts";

const READ = `
version: 1
workspace: "1"
rules:
  - allow: [read]
`;

/** Tasks and projects, but neither the comments nor the counts that hang on them. */
const BARE = `
version: 1
workspace: "1"
rules:
  - allow: [workspace:read, task:read]
`;

/** Task `gid` with its comments and its subtasks. */
const withParts = (gid: string): ToolRequest => ({
	method: "GET",
	path: `/tasks/${gid}`,
	include: {
		comments: { method: "GET", path: `/tasks/${gid}/stories` },
		subtasks: { method: "GET", path: `/tasks/${gid}/subtasks` },
	},
});

describe("included requests", () => {
	it("joins the data of each to the request's own, under its key", async () => {
		const { gate } = await setupGate(READ);
		const response = await answer(gate, withParts("101"));
		const task = data(response.body);
		expect(response.status).toBe(200);
		expect(task.name).toBe("T1");
		expect((task.comments as Body[]).map((comment) => comment.text)).toStrictEqual(["hello"]);
		expect((task.subtasks as Body[]).map((subtask) => subtask.gid)).toStrictEqual(["104"]);
		// Each part went through the gate like a request of its own.
		expect((task.subtasks as Body[])[0]?.allowed_actions).toContain("task:read");
	});

	it("answers null for a part the policy refuses, and the rest as asked", async () => {
		const { fake, gate } = await setupGate(BARE);
		const response = await answer(gate, withParts("101"));
		const task = data(response.body);
		expect(response.status).toBe(200);
		expect(task.comments).toBeNull();
		expect((task.subtasks as Body[]).map((subtask) => subtask.gid)).toStrictEqual(["104"]);
		expect(requests(fake)).not.toContain("GET /tasks/101/stories");
	});

	it("asks for no part of a request that is refused", async () => {
		const { fake, gate } = await setupGate(READ);
		const response = await answer(gate, withParts("999"));
		expect(response.status).toBe(404);
		expect(requests(fake).filter((sent) => sent.includes("/999/"))).toStrictEqual([]);
	});
});
