// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { data, items, setupGate } from "./helpers/gate.ts";
import { requests, TEAM_POLICY } from "./helpers/requests.ts";

/** An Asana whose typeahead ignores the memberships selections. */
const typeaheadWithoutMemberships = (path: string, field: string): boolean =>
	path.endsWith("/typeahead") && field.startsWith("memberships.");

/** Tasks in project 21's Done section are hidden. */
const SECTION_POLICY = `
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { project: "21", section: "32" }
    deny: [task:read]
`;

/** An Asana whose typeahead ignores the section of a membership. */
const typeaheadWithoutSections = (path: string, field: string): boolean =>
	path.endsWith("/typeahead") && field.endsWith("memberships.section");

describe("lists of mixed types", () => {
	it("load a result whose memberships name no section rather than take it for sectionless", async () => {
		const { fake, gate } = await setupGate(SECTION_POLICY, {
			unhonoured: typeaheadWithoutSections,
		});
		const response = await gate.execute({
			method: "GET",
			path: "/workspaces/1/typeahead",
			query: { resource_type: "task", query: "T" },
		});
		expect(items(response.body).map((task) => task.gid)).not.toContain("105");
		expect(requests(fake)).toContain("GET /tasks/105");
	});

	it("judge typeahead results by their own fields, in one request", async () => {
		const { fake, gate } = await setupGate(TEAM_POLICY);
		const response = await gate.execute({
			method: "GET",
			path: "/workspaces/1/typeahead",
			query: { resource_type: "task", query: "T" },
		});
		expect(items(response.body).map((task) => task.gid)).toStrictEqual(["101", "105", "107"]);
		expect(items(response.body)[0]).toMatchObject({ resource_type: "task", name: "T1" });
		expect(requests(fake)).toStrictEqual(["GET /workspaces/1/typeahead"]);
	});

	// Asana answers opt_fields without resource_type unless it is selected.
	it("keep typeahead results whose fields the caller chose", async () => {
		const { gate } = await setupGate(TEAM_POLICY);
		const response = await gate.execute({
			method: "GET",
			path: "/workspaces/1/typeahead",
			query: { resource_type: "task", query: "T", opt_fields: "name" },
		});
		expect(items(response.body).map((task) => task.name)).toStrictEqual([
			"T1",
			"T5 done",
			"T7 design",
		]);
	});

	it("load a result by gid when Asana leaves out what its facts need", async () => {
		const { fake, gate } = await setupGate(TEAM_POLICY, {
			unhonoured: typeaheadWithoutMemberships,
		});
		const response = await gate.execute({
			method: "GET",
			path: "/workspaces/1/typeahead",
			query: { resource_type: "task", query: "T" },
		});
		expect(items(response.body).map((task) => task.gid)).toStrictEqual(["101", "105", "107"]);
		expect(requests(fake)).toStrictEqual([
			"GET /workspaces/1/typeahead",
			"GET /tasks/101",
			"GET /tasks/102",
			"GET /tasks/103",
			"GET /tasks/105",
			"GET /tasks/107",
		]);
	});

	it("judge a portfolio's projects and portfolios by their own fields", async () => {
		const { fake, gate } = await setupGate(TEAM_POLICY);
		// Portfolio 81 holds project 22; add project 21 above it and a portfolio below.
		fake.api("POST", "/portfolios/81/addItem", { item: "21", insert_before: "22" });
		const inner = fake.api("POST", "/portfolios", { name: "Inner", workspace: "1" });
		const innerGid = String(data(inner.body).gid);
		fake.api("POST", "/portfolios/81/addItem", { item: innerGid });
		const response = await gate.execute({ method: "GET", path: "/portfolios/81/items" });
		expect(items(response.body).map((item) => item.gid)).toStrictEqual(["21", "22", innerGid]);
		// The projects' nested team is checked once for all of them.
		expect(requests(fake)).toStrictEqual([
			"GET /portfolios/81",
			"GET /portfolios/81/items",
			"GET /teams/11",
		]);
	});

	it("judge favorites of the type asked for by their own fields", async () => {
		const { fake, gate } = await setupGate(TEAM_POLICY);
		const response = await gate.execute({
			method: "GET",
			path: "/users/me/favorites",
			query: { resource_type: "project", workspace: "1" },
		});
		expect(items(response.body).map((project) => project.gid)).toStrictEqual(["21"]);
		expect(requests(fake)).toStrictEqual([
			"GET /users/me",
			"GET /users/me/favorites",
			"GET /teams/11",
		]);
	});
});
