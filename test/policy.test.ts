// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { expandActionPattern, expandGroup } from "../src/policy/actions.ts";
import { compilePolicy } from "../src/policy/compile.ts";
import { parsePolicy } from "../src/policy/load.ts";
import { referencesOf } from "../src/policy/references.ts";
import { needsTaskChain } from "../src/policy/scope.ts";
import { PolicyError } from "../src/policy/types.ts";
import { examplePolicy } from "./helpers/example-policy.ts";
import { fakeResolver, WORLD } from "./helpers/fake-resolver.ts";

const policyPromise = examplePolicy;

describe("compilePolicy", () => {
	it("resolves the workspace and the token's user", async () => {
		const policy = await policyPromise;
		expect(policy.workspace).toBe("1");
		expect(policy.me).toStrictEqual(WORLD.me);
	});

	it("splits allow/deny and ranks specificity", async () => {
		const policy = await policyPromise;
		expect(
			policy.rules.map(
				(r) => `${r.index}:${r.effect}:${r.specificity.level}.${r.specificity.cross}`,
			),
		).toStrictEqual([
			"0:allow:0.0",
			"1:allow:1.0",
			"2:allow:2.0",
			"3:deny:3.0",
			"4:allow:0.1",
			"5:allow:2.0",
			"6:deny:2.0",
			"7:allow:0.2",
			"8:allow:1.0",
			"9:allow:4.0",
		]);
		expect(needsTaskChain(policy)).toBe(true);
	});

	it("resolves the names used in scopes", async () => {
		const policy = await policyPromise;
		expect(policy.rules.at(1)?.where.teams).toStrictEqual(new Set(["11"]));
		expect(policy.rules.at(3)?.where.sections).toStrictEqual(new Set(["32"]));
		expect(policy.rules.at(4)?.where.tags).toStrictEqual(new Set(["41"]));
		expect(policy.rules.at(7)?.where.assignees).toStrictEqual(new Set(["51"]));
		expect(policy.rules.at(7)?.where.customFields).toStrictEqual([
			{ fieldGid: "61", values: new Set(["AI", "71"]) },
		]);
	});

	it("lets `fields` grant a limited update (plus the verbs the fields stand for)", async () => {
		const policy = await policyPromise;
		const rule = policy.rules.at(5);
		expect(rule?.actions.has("task:update")).toBe(true);
		expect(rule?.actions.has("task:complete")).toBe(true);
		expect(rule?.actions.has("task:assign")).toBe(true);
		expect(rule?.fields?.get("task")).toStrictEqual(new Set(["completed", "assignee", "due_on"]));
	});

	it("rejects unknown names, resources and verbs", async () => {
		await expect(
			compilePolicy(
				parsePolicy(
					"version: 1\nworkspace: Acme\nrules:\n  - where: { project: Nope }\n    allow: [read]\n",
				),
				fakeResolver,
			),
		).rejects.toThrow(/project "Nope" was not found/u);
		await expect(
			compilePolicy(
				parsePolicy("version: 1\nworkspace: Acme\nrules:\n  - allow: [widget:read]\n"),
				fakeResolver,
			),
		).rejects.toThrow(/unknown resource "widget"/u);
		await expect(
			compilePolicy(
				parsePolicy("version: 1\nworkspace: Acme\nrules:\n  - allow: [task:fly]\n"),
				fakeResolver,
			),
		).rejects.toThrow(/unknown verb "fly"/u);
	});
});

const compile = (rules: string): ReturnType<typeof compilePolicy> =>
	compilePolicy(parsePolicy(`version: 1\nworkspace: Acme\nrules:\n${rules}`), fakeResolver);

const ruleText = (block: string): string =>
	`version: 1\nworkspace: Acme\nrules:\n  - where: { project: "21" }\n    ${block}\n`;

describe("constraint values and member names", () => {
	it("resolves the names in require and apply values to the gids Asana expects", async () => {
		const policy = await compile(`  - where: { project: "21" }
    allow: ["task:*"]
    require:
      task:
        tags: { not_in: [frozen] }
        assignee: { in: [me] }
        custom_fields: { Owner: { in: [AI] } }
    apply:
      task:
        tags: { add: [ai-ok] }
        custom_fields: { Owner: AI }
`);
		const constraints = policy.rules.find((rule) => rule.effect === "constrain")?.constraints;
		const require = constraints?.require.get("task");
		expect(require?.get("tags")?.notIn).toStrictEqual(new Set(["frozen", "42"]));
		expect(require?.get("assignee")?.in).toStrictEqual(new Set(["me", "51"]));
		expect(require?.get("custom_fields.61")?.in).toStrictEqual(new Set(["AI", "71"]));
		const apply = constraints?.apply.get("task");
		expect(apply?.get("tags")?.add).toStrictEqual(["41"]);
		expect(apply?.get("custom_fields.61")?.default).toBe("71");
	});

	it("rejects a misspelled operator instead of reading it as a nested name", () => {
		expect(() => parsePolicy(ruleText("require: { task: { due_on: { presnt: true } } }"))).toThrow(
			PolicyError,
		);
		expect(() => parsePolicy(ruleText('apply: { task: { name: { prefx: "[AI] " } } }'))).toThrow(
			PolicyError,
		);
		expect(() =>
			parsePolicy(ruleText("require: { task: { custom_fields: { Owner: { presnt: true } } } }")),
		).toThrow(PolicyError);
		expect(() =>
			parsePolicy(ruleText("require: { task: { custom_fields: { Owner: { in: [AI] } } } }")),
		).not.toThrow();
	});

	it("rejects a `fields` member the resource does not accept", async () => {
		await expect(compile(`  - allow: [read]\n    fields: { task: [completd] }\n`)).rejects.toThrow(
			'"completd" is not a request member of task',
		);
	});
});

describe("parsePolicy", () => {
	it("rejects a section name without a project, and a rule without effect", () => {
		expect(() =>
			parsePolicy(
				"version: 1\nworkspace: x\nrules:\n  - where: { section: Done }\n    allow: [read]\n",
			),
		).toThrow(PolicyError);
		expect(() =>
			parsePolicy("version: 1\nworkspace: x\nrules:\n  - where: { project: p }\n"),
		).toThrow(/allow/u);
		expect(() => parsePolicy("version: 2\nworkspace: x\nrules: []\n")).toThrow(PolicyError);
		expect(() => parsePolicy("version: [1\n")).toThrow(/invalid YAML/u);
	});

	it("accepts section gids without a project and lists of references", () => {
		const file = parsePolicy(
			'version: 1\nworkspace: x\nrules:\n  - where: { section: "123", project: [a, b] }\n    allow: [read]\n',
		);
		expect(file.rules[0]?.where?.project).toStrictEqual(["a", "b"]);
	});
});

describe("action patterns", () => {
	it("expands groups by verb tier", () => {
		expect(expandGroup("read")).toContain("task:read");
		expect(expandGroup("read")).not.toContain("audit_log:read");
		expect(expandGroup("write")).toContain("task:complete");
		expect(expandGroup("write")).not.toContain("task:delete");
		expect(expandGroup("admin")).toContain("task:delete");
	});

	it("expands modify to every verb but read, so a scope can be frozen without being hidden", () => {
		expect(expandGroup("modify")).not.toContain("task:read");
		expect(expandGroup("modify")).toContain("task:delete");
		expect(expandGroup("modify")).toContain("project:manage_members");
	});

	it("covers the explicit-only actions with groups and wildcards when restricting", () => {
		expect(expandActionPattern("*:create")).not.toContain("webhook:create");
		expect(expandActionPattern("*:create", { grant: false })).toContain("webhook:create");
		expect(expandActionPattern("modify", { grant: false })).toContain("export:create");
		expect(expandActionPattern("*", { grant: false })).toContain("audit_log:read");
		expect(expandActionPattern("export:*", { grant: false })).toStrictEqual(["export:create"]);
	});

	it("expands wildcards without the explicit-only actions, which must be literal", () => {
		expect(expandGroup("admin")).not.toContain("webhook:create");
		expect(expandActionPattern("webhook:*")).toStrictEqual(["webhook:read", "webhook:delete"]);
		expect(expandActionPattern("*:delete")).toContain("project:delete");
		expect(expandActionPattern("webhook:create")).toStrictEqual(["webhook:create"]);
		expect(() => expandActionPattern("nonsense")).toThrow(PolicyError);
	});

	it("lists every object the scopes name, once per rule and member", async () => {
		const policy = await policyPromise;
		const named = referencesOf(policy).map((r) => `${r.rule}.${r.member}=${r.gid}`);
		expect(named).toStrictEqual([
			"1.team=11",
			"2.project=21",
			"3.project=21",
			"3.section=32",
			"4.tag=41",
			"5.project=22",
			"6.project=23",
			"7.assignee=51",
			"7.custom_field=61",
			"9.subtree=900",
		]);
	});
});
