// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { AsanaClient } from "../src/asana/client.ts";
import { auditReferences } from "../src/cli/audit.ts";
import { FactsLoader } from "../src/gate/facts.ts";
import { compilePolicy } from "../src/policy/compile.ts";
import { parsePolicy } from "../src/policy/load.ts";
import { type Reference, referencesOf } from "../src/policy/references.ts";
import { createFakeAsana } from "./helpers/fake-asana.ts";
import type { Fake } from "./helpers/gate.ts";
import { CONTEXT } from "./helpers/world.ts";

/** A policy of workspace 1 that allows reading, with `rules` after that. */
const withRules = (rules: string): string => `
version: 1
workspace: "1"
rules:
  - allow: [read]
${rules}`;

/** A rule that names objects in its scope and in its constraints. */
const CONSTRAINED = `
  - where: { project: "21", custom_field: { "61": ["71", "72"] } }
    allow: [task:create]
    require: { task: { assignee: { in: [me, "52"] }, custom_fields: { "61": { not_in: ["72"] } } } }
    apply: { task: { tags: { add: ["41"] }, projects: { default: ["21"] }, name: { prefix: "x" } } }
    fields: { task: [name] }
`;

/** A rule whose scope expects custom field 1001 to hold one of `values`. */
const holding = (values: string): string => `
  - where: { project: "21", custom_field: { "1001": [${values}] } }
    deny: [task:delete]
`;

/** What `check` says of a value custom field 1001 cannot hold. */
const unheld = (value: string): string[] => [
	`rules[1].where.custom_field 1001: "${value}" names nothing the field holds`,
];

/** Where a rule names an object, and the values it writes for a custom field. */
const described = (reference: Reference): string =>
	[reference.at, reference.resource, reference.gid, ...(reference.values ?? [])].join(" ");

/** Makes a custom field of `subtype` in the fake; it takes gid 1001, the first a fresh fake gives. */
const field =
	(subtype: string) =>
	(fake: Fake): void => {
		fake.api("POST", "/custom_fields", {
			workspace: "1",
			name: "Field",
			resource_subtype: subtype,
			input_restrictions: ["task"],
		});
	};

/** What `check` finds wrong with the objects `rules` name, in a fresh fake Asana once `prepare` has run. */
async function problems(rules: string, prepare?: (fake: Fake) => void): Promise<string[]> {
	const fake = createFakeAsana();
	prepare?.(fake);
	const client = new AsanaClient({ token: "test-token", fetch: fake.fetch, maxRetries: 0 });
	const policy = compilePolicy(parsePolicy(withRules(rules)), CONTEXT);
	const loader = new FactsLoader({ client, policy });
	const { findings } = await auditReferences({ policy, loader, client });
	return findings.map((finding) => finding.text);
}

describe("the objects a policy names", () => {
	it("are those of a scope and of the constraints, a custom field with the values written for it", () => {
		const policy = compilePolicy(parsePolicy(withRules(CONSTRAINED)), CONTEXT);
		expect(referencesOf(policy).map((reference) => described(reference))).toStrictEqual([
			"where.project project 21",
			"where.custom_field custom_field 61 71 72",
			"require.task.custom_fields custom_field 61 72",
			"require.task.assignee user 51",
			"require.task.assignee user 52",
			"apply.task.tags tag 41",
			"apply.task.projects project 21",
		]);
	});

	it("exist where the policy says, or check reports them", async () => {
		await expect(problems(CONSTRAINED)).resolves.toStrictEqual([]);
		// A tag's gid where a project is named, a user nobody is, a section of another project.
		const rules = `
  - where: { project: "41" }
    allow: [task:create]
    require: { task: { assignee: { in: ["59"] } } }
    apply: { task: { tags: { add: ["21"] } } }
  - where: { project: "22", section: "31" }
    deny: [task:update]
`;
		await expect(problems(rules)).resolves.toStrictEqual([
			"rules[1].where.project 41: not found (deleted, or not visible to this token)",
			"rules[1].require.task.assignee 59: not found (deleted, or not visible to this token)",
			"rules[1].apply.task.tags 21: not found (deleted, or not visible to this token)",
			"rules[2].where.section 31: not a section of the rule's project, so the rule never applies",
		]);
	});

	it("hold the values written for them: an enum field its options, by gid", async () => {
		const rules = `
  - where: { project: "21", custom_field: { "61": [AI, "71"] } }
    deny: [task:delete]
    apply: { task: { custom_fields: { "61": "73" } } }
`;
		await expect(problems(rules)).resolves.toStrictEqual([
			'rules[1].where.custom_field 61: "AI" is none of the field\'s options (71 AI, 72 Human)',
			'rules[1].apply.task.custom_fields 61: "73" is none of the field\'s options (71 AI, 72 Human)',
		]);
	});

	it("hold the values written for them: a people field users, a reference field what it takes, any other a text", async () => {
		// A user by gid: Asana answers `me` too, but a field holds the gid.
		await expect(problems(holding('"52", me'), field("people"))).resolves.toStrictEqual(
			unheld("me"),
		);
		// The field takes tasks: 105 is one, 21 is a project.
		await expect(problems(holding('"105", "21"'), field("reference"))).resolves.toStrictEqual(
			unheld("21"),
		);
		await expect(problems(holding("ready, 3"), field("text"))).resolves.toStrictEqual([]);
	});
});
