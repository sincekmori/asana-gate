// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { matchRoute, normalizePath } from "../src/gate/router.ts";

describe("matchRoute", () => {
	it("matches the operations of one path by method", () => {
		expect(matchRoute("GET", "/tasks/123")).toMatchObject({
			operationId: "getTask",
			params: { task_gid: "123" },
		});
		expect(matchRoute("PUT", "/tasks/123")).toMatchObject({ operationId: "updateTask" });
		expect(matchRoute("DELETE", "/tasks/123")).toMatchObject({ operationId: "deleteTask" });
		expect(matchRoute("POST", "/tasks/9/addProject")).toMatchObject({
			operationId: "addProjectForTask",
		});
	});

	it("extracts several path parameters and literal segments", () => {
		expect(matchRoute("GET", "/workspaces/1/tasks/search")).toMatchObject({
			operationId: "searchTasksForWorkspace",
		});
		expect(matchRoute("GET", "/workspaces/1/tasks/custom_id/ABC-1")).toMatchObject({
			operationId: "getTaskForCustomID",
			params: { workspace_gid: "1", custom_id: "ABC-1" },
		});
		expect(matchRoute("GET", "/users/me")).toMatchObject({
			operationId: "getUser",
			params: { user_gid: "me" },
		});
	});

	it("tolerates the API prefix, a full URL, query strings and trailing slashes", () => {
		expect(matchRoute("GET", "/api/1.0/tasks/1?opt_fields=name")).toMatchObject({
			operationId: "getTask",
		});
		expect(matchRoute("GET", "https://app.asana.com/api/1.0/projects/2/")).toMatchObject({
			operationId: "getProject",
		});
		expect(normalizePath("tasks/1")).toBe("/tasks/1");
	});

	it("returns undefined for unknown routes and methods", () => {
		expect(matchRoute("GET", "/nonexistent")).toBeUndefined();
		expect(matchRoute("PATCH", "/tasks/1")).toBeUndefined();
	});
});
