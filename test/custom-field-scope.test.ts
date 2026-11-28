// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { data, type Fake, setupGate } from "./helpers/gate.ts";

/** Tasks of project 21 may be changed, but not deleted where custom field `field` holds `value`. */
const policyFor = (field: string, value: string): string => `
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { project: "21" }
    allow: ["task:*"]
  - where: { project: "21", custom_field: { "${field}": "${value}" } }
    deny: [task:delete]
`;

/** The first object a fresh fake makes takes this gid. */
const NEW_FIELD = "1001";

/** Sets option 71 of custom field 61 on task 101. */
function choose(fake: Fake): void {
	fake.api("PUT", "/tasks/101", { custom_fields: { "61": "71" } });
}

/** Makes a custom field of `subtype` and sets it on task 101; the field's gid. */
function hold(fake: Fake, subtype: string, value: unknown): string {
	const field = fake.api("POST", "/custom_fields", {
		workspace: "1",
		name: "Field",
		resource_subtype: subtype,
		input_restrictions: ["task", "project"],
	});
	const gid = String(data(field.body).gid);
	fake.api("PUT", "/tasks/101", { custom_fields: { [gid]: value } });
	return gid;
}

/** Whether the gate refuses to delete task 101 (403) once `prepare` has set its fields. */
async function refusesDelete(policy: string, prepare: (fake: Fake) => void): Promise<boolean> {
	const { fake, gate } = await setupGate(policy);
	prepare(fake);
	const response = await gate.execute({ method: "DELETE", path: "/tasks/101" });
	return response.status === 403;
}

describe("a custom field scope", () => {
	it("tells the option a task holds by its gid, not by its name", async () => {
		await expect(refusesDelete(policyFor("61", "71"), choose)).resolves.toBe(true);
		// Option 71 is called AI: a name tells no option from another, so it matches nothing.
		await expect(refusesDelete(policyFor("61", "AI"), choose)).resolves.toBe(false);
		await expect(refusesDelete(policyFor("61", "72"), choose)).resolves.toBe(false);
	});

	it("tells the objects a reference field holds by their gids, not by their names", async () => {
		const refer = (fake: Fake): void => {
			expect(hold(fake, "reference", ["105", "21"])).toBe(NEW_FIELD);
		};
		await expect(refusesDelete(policyFor(NEW_FIELD, "105"), refer)).resolves.toBe(true);
		await expect(refusesDelete(policyFor(NEW_FIELD, "T5 done"), refer)).resolves.toBe(false);
	});

	it("tells a field that holds no object by its text", async () => {
		const write = (fake: Fake): void => {
			expect(hold(fake, "text", "ready")).toBe(NEW_FIELD);
		};
		await expect(refusesDelete(policyFor(NEW_FIELD, "ready"), write)).resolves.toBe(true);
		await expect(refusesDelete(policyFor(NEW_FIELD, "other"), write)).resolves.toBe(false);
	});
});
