// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { stringOf } from "../src/json.ts";
import { instructionsFor } from "../src/mcp/instructions.ts";
import { WORLD } from "./helpers/fake-resolver.ts";
import { data, setupGate } from "./helpers/gate.ts";

const HEADER = 'version: 1\nworkspace: "1"\nrules:\n';

/** Policies that show the token's user differently through `GET /users/me`. */
const POLICIES = {
	"everything readable": `${HEADER}  - allow: [read]\n`,
	"only a project readable": `${HEADER}  - allow: [workspace:read]\n  - where: { project: "21" }\n    allow: [read]\n`,
	"users readable, the workspace not": `${HEADER}  - allow: [user:read]\n`,
	"email redacted": `${HEADER}  - allow: [read]\n    redact: { user: [email] }\n`,
	"name redacted": `${HEADER}  - allow: [read]\n    redact: { user: [name] }\n`,
};

/** The members of the token's user an agent is shown: by `GET /users/me`, and by the server's instructions. */
async function shownUnder(policy: string): Promise<{ read: string[]; told: string[] }> {
	const { gate } = await setupGate(policy);
	const response = await gate.execute({
		method: "GET",
		path: "/users/me",
		query: { opt_fields: "name,email" },
	});
	const me = response.status === 200 ? data(response.body) : {};
	const instructions = instructionsFor(gate.policy);
	return {
		read: [stringOf(me.name), stringOf(me.email)].filter((value) => value !== undefined),
		// The instructions quote the name and give the email as it is.
		told: [WORLD.me.name, WORLD.me.email].filter((value) =>
			instructions.includes(value === WORLD.me.name ? JSON.stringify(value) : value),
		),
	};
}

describe("the instructions about the token's user", () => {
	it.each([
		["everything readable", [WORLD.me.name, WORLD.me.email]],
		["only a project readable", []],
		["users readable, the workspace not", []],
		["email redacted", [WORLD.me.name]],
		["name redacted", [WORLD.me.email]],
	] as const)("tell what GET /users/me shows when %s", async (name, shown) => {
		await expect(shownUnder(POLICIES[name])).resolves.toStrictEqual({
			read: shown,
			told: shown,
		});
	});

	it.each(Object.keys(POLICIES) as (keyof typeof POLICIES)[])(
		"always give the user's gid and the workspace when %s",
		async (name) => {
			const { gate } = await setupGate(POLICIES[name]);
			expect(instructionsFor(gate.policy)).toContain(
				`gid ${WORLD.me.gid}), in the workspace "Acme" (gid 1)`,
			);
		},
	);
});
