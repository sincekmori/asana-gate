// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { policyWarnings } from "../src/cli/audit.ts";
import { compilePolicies, type NameResolver, type PolicySource } from "../src/policy/compile.ts";
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
import { fakeResolver } from "./helpers/fake-resolver.ts";

/** A bound on the example policy: no deletes, Backend read-only but for completing in Done, one field in Design System. */
const USER = `
version: 1
rules:
  - allow: ["*"]
  - deny: [task:delete]
  - where: { project: "21" }
    deny: [modify]
  - where: { project: "21", section: "Done" }
    allow: [task:complete]
  - where: { project: "22" }
    allow: [task:update]
    fields: { task: [completed] }
  - confirm: [task:create]
`;

const ALL_READ = "version: 1\nworkspace: Acme\nrules: [{ allow: [read] }]\n";
const ALL_READ_BOUND = "version: 1\nrules: [{ allow: [read] }]\n";
const TASK_READ = "version: 1\nworkspace: Acme\nrules: [{ allow: [task:read] }]\n";
const TASK_READ_BOUND = "version: 1\nrules: [{ allow: [task:read] }]\n";
const TEAM_READ = "version: 1\nworkspace: Acme\nrules: [{ allow: [team:read] }]\n";

const BASE_WITH_APPLY = `
version: 1
workspace: Acme
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
	fakeResolver,
);

/** A resolver that also knows a second workspace. */
const twoWorkspaces: NameResolver = {
	...fakeResolver,
	workspace: (ref) =>
		ref === "Beta" ? Promise.resolve({ gid: "2", name: "Beta" }) : fakeResolver.workspace(ref),
};

const confirmers = (policy: Policy, facts: Facts, action: "task:create"): string[] =>
	(constraintsFor(policy, facts).confirm.get(action) ?? []).map((rule) => ruleLabel(policy, rule));

const appliedTo = (policy: Policy, facts: Facts): string =>
	JSON.stringify([...(constraintsFor(policy, facts).apply.get("task") ?? [])]);

const describeLayers = (policy: Policy): string[] =>
	policy.layers.map((layer) => `${layer.role}:${layer.otherWorkspace ?? ""}`);

/** Which of task, project and team the policy lets a workspace-level object of that type be read as. */
const readable = (policy: Policy): string =>
	(["task", "project", "team"] as const)
		.filter((resource) => isVisible(policy, workspaceFacts("1"), resource))
		.join(",");

describe("policy files bound each other", () => {
	it("allows what every file allows: the narrower read wins whichever file holds it", async () => {
		const first = await compilePolicies(
			[source(ALL_READ, "project"), source(TASK_READ_BOUND, "user")],
			fakeResolver,
		);
		const second = await compilePolicies(
			[source(TASK_READ, "project"), source(ALL_READ_BOUND, "user")],
			fakeResolver,
		);
		expect(readable(first)).toBe("task");
		expect(readable(second)).toBe("task");
		expect([...grantedActions(first)]).toStrictEqual(["task:read"]);
	});

	it("allows nothing when the files allow nothing in common", async () => {
		const policy = await compilePolicies(
			[source(TEAM_READ, "project"), source(TASK_READ_BOUND, "user")],
			fakeResolver,
		);
		expect(readable(policy)).toBe("");
		expect(grantedActions(policy).size).toBe(0);
		expect(policyWarnings(policy).map((finding) => finding.text)).toContain(
			"the policy files allow no action in common; every request will be refused",
		);
	});

	it("lets each file decide by its own most specific rule before the answers are combined", async () => {
		const policy = await bounded;
		expect(isAllowed(policy, taskIn("21", "31"), "task:delete")).toBe(false);
		expect(isAllowed(policy, taskIn("21", "31"), "task:update")).toBe(false);
		expect(isAllowed(policy, taskIn("21", "31"), "task:complete")).toBe(false);
		expect(isAllowed(policy, taskIn("21", "32"), "task:complete")).toBe(true);
		expect(isVisible(policy, taskIn("23"), "task")).toBe(false);
	});

	it("intersects the updatable members and adds up the constraints", async () => {
		const policy = await bounded;
		expect(fieldAllowlist(policy, taskIn("22"), "task")).toStrictEqual(new Set(["completed"]));
		expect(fieldAllowlist(policy, taskIn("21"), "task")).toBeUndefined();
		expect(confirmers(policy, taskIn("21"), "task:create")).toStrictEqual(["user rules[5]"]);
		expect(describeLayers(policy)).toStrictEqual(["user:", "project:"]);
	});

	it("lets the stronger file win an apply at equal specificity", async () => {
		const policy = await compilePolicies(
			[
				source(BASE_WITH_APPLY, "project"),
				source(applying("user"), "user"),
				source(applying("managed"), "managed"),
			],
			fakeResolver,
		);
		expect(appliedTo(policy, taskIn("21"))).toContain("[managed] ");
		expect(appliedTo(policy, taskIn("21"))).not.toContain("[user] ");
		expect(policy.layers.map((layer) => layer.role)).toStrictEqual(["user", "project", "managed"]);
	});

	it("keeps a file that names another workspace out of force", async () => {
		const policy = await compilePolicies(
			[
				source(EXAMPLE, "project"),
				source('version: 1\nworkspace: Beta\nrules: [{ deny: ["*"] }]\n', "user"),
			],
			twoWorkspaces,
		);
		expect(describeLayers(policy)).toStrictEqual(["user:Beta", "project:"]);
		expect(isAllowed(policy, taskIn("21"), "task:update")).toBe(true);
		expect(policyWarnings(policy).map((finding) => finding.text)).toContain(
			'user.yaml governs workspace "Beta", not Acme, so it is not in force',
		);
	});

	it("insists that the first policy file names its workspace", async () => {
		await expect(
			compilePolicies([source("version: 1\nrules: []\n", "project", "p.yaml")], fakeResolver),
		).rejects.toThrow("p.yaml: this policy must name its workspace");
	});
});
