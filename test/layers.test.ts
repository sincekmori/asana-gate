// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { policyWarnings } from "../src/cli/audit.ts";
import { compilePolicies, type PolicySource } from "../src/policy/compile.ts";
import { constraintsFor } from "../src/policy/effective.ts";
import {
	type Facts,
	grantedActions,
	isAllowed,
	isVisible,
	workspaceFacts,
} from "../src/policy/evaluate.ts";
import { fieldAllowlist } from "../src/policy/fields.ts";
import { parsePolicy } from "../src/policy/load.ts";
import { type Policy, ruleLabel } from "../src/policy/types.ts";
import { EXAMPLE, taskIn } from "./helpers/example-policy.ts";
import { CONTEXT } from "./helpers/world.ts";

/** A bound on the example policy: no deletes, Backend read-only but for completing in Done, one field in Design System. */
const USER = `
version: 1
rules:
  - allow: ["*"]
  - deny: [task:delete]
  - where: { project: "21" }
    deny: [modify]
  - where: { project: "21", section: "32" }
    allow: [task:complete]
  - where: { project: "22" }
    allow: [task:update]
    fields: { task: [completed] }
  - confirm: [task:create]
`;

const ALL_READ = "version: 1\nworkspace: '1'\nrules: [{ allow: [read] }]\n";
const ALL_READ_BOUND = "version: 1\nrules: [{ allow: [read] }]\n";
const TASK_READ = "version: 1\nworkspace: '1'\nrules: [{ allow: [task:read] }]\n";
const TASK_READ_BOUND = "version: 1\nrules: [{ allow: [task:read] }]\n";
const TEAM_READ = "version: 1\nworkspace: '1'\nrules: [{ allow: [team:read] }]\n";

const BASE_WITH_APPLY = `
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { project: "21" }
    apply: { task: { name: { prefix: "[project] " } } }
`;

/** A file that applies a prefix of its own in project 21. */
const applying = (label: string): string => `
version: 1
rules:
  - where: { project: "21" }
    apply: { task: { name: { prefix: "[${label}] " } } }
`;

const source = (text: string, role: PolicySource["role"], path = `${role}.yaml`): PolicySource => ({
	file: parsePolicy(text, path),
	path,
	role,
});

/** The example policy bounded by {@link USER}. */
const bounded = compilePolicies(
	[source(EXAMPLE, "project", "policy.yaml"), source(USER, "user")],
	CONTEXT,
);

const confirmers = (policy: Policy, facts: Facts, action: "task:create"): string[] =>
	(constraintsFor(policy, facts).confirm.get(action) ?? []).map((rule) => ruleLabel(policy, rule));

const appliedTo = (policy: Policy, facts: Facts): string =>
	JSON.stringify([...(constraintsFor(policy, facts).apply.get("task") ?? [])]);

/** What `check` warns about a policy made of the one project file `text`. */
function warningsOf(text: string): string[] {
	const policy = compilePolicies([source(text, "project")], CONTEXT);
	return policyWarnings(policy).map((finding) => finding.text);
}

/** A rule allowing every section action everywhere, and the start of a rule scoped to project 21 (Backend). */
const EVERYWHERE = '  - allow: ["section:*"]\n';
const IN_BACKEND = '  - where: { project: "21" }\n';

/** Whether a policy made of the one project file with `rules` could ever allow deleting a section. */
function grantsDelete(rules: string): boolean {
	const text = `version: 1\nworkspace: "1"\nrules:\n${rules}`;
	const policy = compilePolicies([source(text, "project")], CONTEXT);
	return grantedActions(policy).has("section:delete");
}

const describeLayers = (policy: Policy): string[] =>
	policy.layers.map((layer) => `${layer.role}:${layer.otherWorkspace ?? ""}`);

/** Which of task, project and team the policy lets a workspace-level object of that type be read as. */
const readable = (policy: Policy): string =>
	(["task", "project", "team"] as const)
		.filter((resource) => isVisible(policy, workspaceFacts("1"), resource))
		.join(",");

describe("policy files bound each other", () => {
	it("allows what every file allows: the narrower read wins whichever file holds it", () => {
		const first = compilePolicies(
			[source(ALL_READ, "project"), source(TASK_READ_BOUND, "user")],
			CONTEXT,
		);
		const second = compilePolicies(
			[source(TASK_READ, "project"), source(ALL_READ_BOUND, "user")],
			CONTEXT,
		);
		expect(readable(first)).toBe("task");
		expect(readable(second)).toBe("task");
		expect([...grantedActions(first)]).toStrictEqual(["task:read"]);
	});

	it("allows nothing when the files allow nothing in common", () => {
		const policy = compilePolicies(
			[source(TEAM_READ, "project"), source(TASK_READ_BOUND, "user")],
			CONTEXT,
		);
		expect(readable(policy)).toBe("");
		expect(grantedActions(policy).size).toBe(0);
		expect(policyWarnings(policy).map((finding) => finding.text)).toContain(
			"the policy files allow no action in common; every request will be refused",
		);
	});

	it("does not count as granted what a deny over the same scope takes back", () => {
		// In one rule, or in two over the same scope however each names it, the deny wins wherever the allow applies.
		expect(grantsDelete(`${EVERYWHERE}    deny: [section:delete]\n`)).toBe(false);
		expect(grantsDelete(`${EVERYWHERE}  - deny: [section:delete]\n`)).toBe(false);
		expect(
			grantsDelete(
				`${IN_BACKEND}    allow: ["section:*"]\n  - where: { project: "21" }\n    deny: [section:delete]\n`,
			),
		).toBe(false);
		// The user's file denies deleting tasks everywhere, so the files together never allow it.
		expect(grantedActions(bounded).has("task:delete")).toBe(false);
	});

	it("counts as granted what a deny over another scope leaves standing", () => {
		// A narrower allow grants the action again, and a narrower deny leaves the wider allow elsewhere.
		expect(
			grantsDelete(
				`${EVERYWHERE}  - deny: [section:delete]\n${IN_BACKEND}    allow: [section:delete]\n`,
			),
		).toBe(true);
		expect(grantsDelete(`${EVERYWHERE}${IN_BACKEND}    deny: [section:delete]\n`)).toBe(true);
	});

	it("does not count as granted a read that only a filter allows, which never decides one", () => {
		const text =
			"version: 1\nworkspace: '1'\nrules:\n  - where: { tag: '41' }\n    allow: [task:read, task:update]\n";
		const policy = compilePolicies([source(text, "project")], CONTEXT);
		expect([...grantedActions(policy)]).toStrictEqual(["task:update"]);
	});

	it("lets each file decide by its own most specific rule before the answers are combined", () => {
		const policy = bounded;
		expect(isAllowed(policy, taskIn("21", "31"), "task:delete")).toBe(false);
		expect(isAllowed(policy, taskIn("21", "31"), "task:update")).toBe(false);
		expect(isAllowed(policy, taskIn("21", "31"), "task:complete")).toBe(false);
		expect(isAllowed(policy, taskIn("21", "32"), "task:complete")).toBe(true);
		expect(isVisible(policy, taskIn("23"), "task")).toBe(false);
	});

	it("intersects the updatable members and adds up the constraints", () => {
		const policy = bounded;
		expect(fieldAllowlist(policy, taskIn("22"), "task")).toStrictEqual(new Set(["completed"]));
		expect(fieldAllowlist(policy, taskIn("21"), "task")).toBeUndefined();
		expect(confirmers(policy, taskIn("21"), "task:create")).toStrictEqual(["user rules[5]"]);
		expect(describeLayers(policy)).toStrictEqual(["user:", "project:"]);
	});

	it("lets the stronger file win an apply at equal specificity", () => {
		const policy = compilePolicies(
			[
				source(BASE_WITH_APPLY, "project"),
				source(applying("user"), "user"),
				source(applying("managed"), "managed"),
			],
			CONTEXT,
		);
		expect(appliedTo(policy, taskIn("21"))).toContain("[managed] ");
		expect(appliedTo(policy, taskIn("21"))).not.toContain("[user] ");
		expect(policy.layers.map((layer) => layer.role)).toStrictEqual(["user", "project", "managed"]);
	});

	it("keeps a file that names another workspace out of force, even one this token cannot see", () => {
		const policy = compilePolicies(
			[
				source(EXAMPLE, "project"),
				source('version: 1\nworkspace: "2"\nrules: [{ deny: ["*"] }]\n', "user"),
				source('version: 1\nworkspace: "1"\nrules: [{ allow: ["*"] }]\n', "managed"),
			],
			CONTEXT,
		);
		expect(describeLayers(policy)).toStrictEqual(["user:2", "project:", "managed:"]);
		expect(isAllowed(policy, taskIn("21"), "task:update")).toBe(true);
		expect(policyWarnings(policy).map((finding) => finding.text)).toContain(
			"user.yaml governs workspace 2, not Acme (1), so it is not in force",
		);
	});

	it("warns when the workspace itself cannot be read, which requests starting from it need", () => {
		const unreadable =
			"workspace:read is not allowed at workspace level, so the requests that start from the workspace (workspace-wide lists and searches, typeahead, users) answer 404";
		expect(warningsOf(TASK_READ)).toContain(unreadable);
		expect(warningsOf(ALL_READ)).not.toContain(unreadable);
	});

	it("insists that the first policy file names its workspace", () => {
		expect(() =>
			compilePolicies([source("version: 1\nrules: []\n", "project", "p.yaml")], CONTEXT),
		).toThrow("p.yaml: this policy must name its workspace");
	});
});
