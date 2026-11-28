// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { expandActionPattern, expandGroup } from "../src/policy/actions.ts";
import { compilePolicy } from "../src/policy/compile.ts";
import { constraintJson } from "../src/policy/effective.ts";
import { parsePolicy } from "../src/policy/load.ts";
import { referencesOf } from "../src/policy/references.ts";
import { needsTaskChain } from "../src/policy/scope.ts";
import { type Policy, PolicyError } from "../src/policy/types.ts";
import { examplePolicy } from "./helpers/example-policy.ts";
import { CONTEXT, WORLD } from "./helpers/world.ts";

const policy = examplePolicy;

const compile = (rules: string): Policy =>
	compilePolicy(parsePolicy(`version: 1\nworkspace: "1"\nrules:\n${rules}`), CONTEXT);

const ruleText = (block: string): string =>
	`version: 1\nworkspace: "1"\nrules:\n  - where: { project: "21" }\n    ${block}\n`;

/** Parses a policy whose one rule has the scope `where`. */
const scoped = (where: string) => (): unknown =>
	parsePolicy(`version: 1\nworkspace: "1"\nrules:\n  - where: ${where}\n    allow: [read]\n`);

describe("compilePolicy", () => {
	it("governs the workspace it names, for the token's user", () => {
		expect(policy.workspace).toBe("1");
		expect(policy.workspaceName).toBe("Acme");
		expect(policy.me).toStrictEqual(WORLD.me);
	});

	it("splits allow/deny and ranks specificity", () => {
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

	it("reads scopes as sets of gids, `me` as the token's user", () => {
		expect(policy.rules.at(1)?.where.teams).toStrictEqual(new Set(["11"]));
		expect(policy.rules.at(3)?.where.sections).toStrictEqual(new Set(["32"]));
		expect(policy.rules.at(4)?.where.tags).toStrictEqual(new Set(["41"]));
		expect(policy.rules.at(7)?.where.assignees).toStrictEqual(new Set(["51"]));
		expect(policy.rules.at(7)?.where.customFields).toStrictEqual([
			{ fieldGid: "61", values: new Set(["71"]) },
		]);
	});

	it("lets `fields` grant a limited update (plus the verbs the fields stand for)", () => {
		const rule = policy.rules.at(5);
		expect(rule?.actions.has("task:update")).toBe(true);
		expect(rule?.actions.has("task:complete")).toBe(true);
		expect(rule?.actions.has("task:assign")).toBe(true);
		expect(rule?.fields?.get("task")).toStrictEqual(new Set(["completed", "assignee", "due_on"]));
	});

	it("rejects unknown resources and verbs", () => {
		expect(() => compile("  - allow: [widget:read]\n")).toThrow(/unknown resource "widget"/u);
		expect(() => compile("  - allow: [task:fly]\n")).toThrow(/unknown verb "fly"/u);
	});
});

describe("naming objects", () => {
	it("takes a gid alone wherever a scope names an object, since a name tells no object from another", () => {
		expect(scoped("{ project: Backend }")).toThrow("expected a gid in quotes");
		expect(scoped('{ tag: ["41", frozen] }')).toThrow(PolicyError);
		expect(scoped('{ custom_field: { Owner: "71" } }')).toThrow(PolicyError);
		expect(scoped('{ project: ["21", "22"], section: "32", team: "11" }')).not.toThrow();
	});

	it("names a user by gid or as `me`, not by email", () => {
		expect(scoped("{ assignee: bob@acme.test }")).toThrow("expected a gid in quotes");
		expect(scoped('{ assignee: [me, "52"], created_by: me }')).not.toThrow();
	});

	it("asks for the quotes that keep a gid from being read as a number", () => {
		expect(scoped("{ project: 21 }")).toThrow(
			'expected a gid in quotes, such as "1200000000000123"',
		);
		expect(() => parsePolicy("version: 1\nworkspace: Acme\nrules: []\n")).toThrow(PolicyError);
	});

	it("refuses a name among the values of a member that names objects", () => {
		expect(() => compile("  - apply: { task: { tags: { add: [ai-ok] } } }\n")).toThrow(
			'rules[0].apply.task.tags: "ai-ok" is no gid; tags names objects by gid, in quotes',
		);
		expect(() => compile("  - require: { task: { assignee: { in: [bob@acme.test] } } }\n")).toThrow(
			'assignee names objects by gid (a user also by "me"), in quotes',
		);
	});
});

describe("constraint values and member names", () => {
	it("takes the values of require and apply as a request sends them, `me` as the token's user", () => {
		const compiled = compile(`  - where: { project: "21" }
    allow: ["task:*"]
    require:
      task:
        tags: { not_in: ["42"] }
        assignee: { in: [me] }
        custom_fields: { "61": { in: ["71"] } }
    apply:
      task:
        tags: { add: ["41"] }
        custom_fields: { "61": "71" }
`);
		const constraints = compiled.rules.find((rule) => rule.effect === "constrain")?.constraints;
		const require = constraints?.require.get("task");
		expect(require?.get("tags")?.not_in).toStrictEqual(new Set(["42"]));
		expect(require?.get("assignee")?.in).toStrictEqual(new Set(["51"]));
		expect(require?.get("custom_fields.61")?.in).toStrictEqual(new Set(["71"]));
		const apply = constraints?.apply.get("task");
		expect(apply?.get("tags")?.add).toStrictEqual(["41"]);
		expect(apply?.get("custom_fields.61")?.default).toBe("71");
	});

	it("shows a requirement's values as a list and its patterns as written", () => {
		const compiled = compile(`  - where: { project: "21" }
    require:
      task:
        tags: { not_in: ["42"] }
        name: { matches: "^AI: " }
`);
		const require = compiled.rules.find((rule) => rule.effect === "constrain")?.constraints
			?.require;
		const shown = (key: string): string => constraintJson(require?.get("task")?.get(key));
		expect(shown("tags")).toBe('{"not_in":["42"]}');
		expect(shown("name")).toBe('{"matches":"/^AI: /u"}');
	});

	it("rejects a misspelled operator instead of reading it as a custom field", () => {
		expect(() => parsePolicy(ruleText("require: { task: { due_on: { presnt: true } } }"))).toThrow(
			PolicyError,
		);
		expect(() => parsePolicy(ruleText('apply: { task: { name: { prefx: "[AI] " } } }'))).toThrow(
			PolicyError,
		);
		expect(() =>
			parsePolicy(ruleText('require: { task: { custom_fields: { "61": { presnt: true } } } }')),
		).toThrow(PolicyError);
		expect(() =>
			parsePolicy(ruleText('require: { task: { custom_fields: { "61": { in: ["71"] } } } }')),
		).not.toThrow();
	});

	it("rejects a `fields` member the resource does not accept", () => {
		expect(() => compile("  - allow: [read]\n    fields: { task: [completd] }\n")).toThrow(
			'"completd" is not a request member of task',
		);
	});

	it("accepts the members a task's link operations change in `fields`", () => {
		const compiled = compile(
			"  - allow: [read]\n    fields: { task: [dependencies, dependents] }\n",
		);
		const rule = compiled.rules.find((one) => one.fields !== undefined);
		expect(rule?.fields?.get("task")).toStrictEqual(new Set(["dependencies", "dependents"]));
	});

	it("refuses custom_fields that mix operators with fields, rather than drop either", () => {
		expect(() =>
			parsePolicy(
				ruleText('require: { task: { custom_fields: { present: true, "61": { in: ["71"] } } } }'),
			),
		).toThrow(PolicyError);
		expect(() =>
			parsePolicy(ruleText('apply: { task: { custom_fields: { value: x, "61": "71" } } }')),
		).toThrow(PolicyError);
	});

	it("rejects a date bound that is no date when the policy loads", () => {
		expect(() =>
			parsePolicy(ruleText('require: { task: { due_on: { min: "2026-13-45" } } }')),
		).toThrow(
			"a date: YYYY-MM-DD, ISO 8601, today, now, +7d or -1d\n  → at rules[0].require.task.due_on.min",
		);
		expect(() =>
			parsePolicy(ruleText('require: { task: { due_on: { min: today, max: "+30d" } } }')),
		).not.toThrow();
	});
});

describe("parsePolicy", () => {
	it("rejects a rule without effect, another version and malformed YAML", () => {
		expect(() =>
			parsePolicy('version: 1\nworkspace: "1"\nrules:\n  - where: { project: "21" }\n'),
		).toThrow(/allow/u);
		expect(() => parsePolicy('version: 2\nworkspace: "1"\nrules: []\n')).toThrow(PolicyError);
		expect(() => parsePolicy("version: [1\n")).toThrow(/invalid YAML/u);
	});

	it("accepts a section without its project and lists of gids", () => {
		const file = parsePolicy(
			'version: 1\nworkspace: "1"\nrules:\n  - where: { section: "32", project: ["21", "22"] }\n    allow: [read]\n',
		);
		expect(file.rules[0]?.where?.project).toStrictEqual(["21", "22"]);
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

	it("lists every object the scopes name, once per rule and member", () => {
		const named = referencesOf(policy).map((r) => `${r.rule}.${r.at}=${r.gid}`);
		expect(named).toStrictEqual([
			"1.where.team=11",
			"2.where.project=21",
			"3.where.project=21",
			"3.where.section=32",
			"4.where.tag=41",
			"5.where.project=22",
			"6.where.project=23",
			"7.where.assignee=51",
			"7.where.custom_field=61",
			"9.where.subtree=900",
		]);
	});
});
