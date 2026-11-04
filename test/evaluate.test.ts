// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { taskState } from "../src/gate/facts.ts";
import { compilePolicy } from "../src/policy/compile.ts";
import { constraintsFor } from "../src/policy/effective.ts";
import {
	allowedActions,
	decide,
	EMPTY,
	type Facts,
	isAllowed,
	isVisible,
	workspaceFacts,
} from "../src/policy/evaluate.ts";
import { fieldAllowlist } from "../src/policy/fields.ts";
import { parsePolicy } from "../src/policy/load.ts";
import { stateMatches } from "../src/policy/state.ts";
import { examplePolicy, tagged, taskIn } from "./helpers/example-policy.ts";
import { fakeResolver } from "./helpers/fake-resolver.ts";

const policyPromise = examplePolicy;

describe("evaluation", () => {
	it("applies the workspace-wide read rule to objects nowhere else mentioned", async () => {
		const policy = await policyPromise;
		expect(isVisible(policy, workspaceFacts("1"), "tag")).toBe(true);
		expect(isAllowed(policy, workspaceFacts("1"), "tag:create")).toBe(false);
		expect(isVisible(policy, workspaceFacts("other"), "tag")).toBe(false);
	});

	it("lets a project-level rule grant the project's verbs", async () => {
		const policy = await policyPromise;
		expect(isAllowed(policy, taskIn("21", "31"), "task:update")).toBe(true);
		expect(isAllowed(policy, taskIn("21", "31"), "task:delete")).toBe(true);
		expect(isAllowed(policy, taskIn("21", "31"), "story:create")).toBe(true);
	});

	it("lets the more specific section-level deny win over the project-level allow", async () => {
		const policy = await policyPromise;
		expect(isAllowed(policy, taskIn("21", "32"), "task:update")).toBe(false);
		expect(isAllowed(policy, taskIn("21", "32"), "task:delete")).toBe(false);
		expect(isAllowed(policy, taskIn("21", "32"), "task:complete")).toBe(true);
	});

	it("gives team-level write to projects of the team, nothing more", async () => {
		const policy = await policyPromise;
		expect(isAllowed(policy, taskIn("22"), "task:create")).toBe(true);
		expect(isAllowed(policy, taskIn("22"), "task:delete")).toBe(false);
	});

	it("hides what a scoped deny-all covers, even from the workspace read", async () => {
		const policy = await policyPromise;
		expect(isVisible(policy, taskIn("23"), "task")).toBe(false);
		expect(allowedActions(policy, taskIn("23"), "task")).toStrictEqual([]);
	});

	it("requires every project of a multi-homed task to allow an action", async () => {
		const policy = await policyPromise;
		const both: Facts = {
			...taskIn("21"),
			branches: [...taskIn("21").branches, ...taskIn("22").branches],
		};
		expect(isAllowed(policy, both, "task:update")).toBe(true);
		expect(isAllowed(policy, both, "task:delete")).toBe(false);
		const withSecret: Facts = {
			...taskIn("21"),
			branches: [...taskIn("21").branches, ...taskIn("23").branches],
		};
		expect(isVisible(policy, withSecret, "task")).toBe(false);
	});

	it("treats cross-cutting rules as filters ranked by their hierarchy level", async () => {
		const policy = await policyPromise;
		const taggedTask = taskIn("22", undefined, { tags: new Set(["41"]) });
		expect(isAllowed(policy, taskIn("22"), "task:update")).toBe(true);
		expect(fieldAllowlist(policy, taskIn("22"), "task")).toStrictEqual(
			new Set(["completed", "assignee", "due_on"]),
		);
		// The tag rule sits at workspace level, so the project-level allowlist still wins.
		expect(fieldAllowlist(policy, taggedTask, "task")).toStrictEqual(
			new Set(["completed", "assignee", "due_on"]),
		);
		// Whereas a task in the Secret project stays hidden whatever its tags say.
		expect(isVisible(policy, tagged("23", "41"), "task")).toBe(false);
	});

	it("matches assignee and custom field predicates together, below hierarchical rules", async () => {
		const policy = await policyPromise;
		const fields: ReadonlyMap<string, ReadonlySet<string>> = new Map([
			["61", new Set(["71", "AI"])],
		]);
		const unhomed = (assignee: string, customFields = fields): Facts => ({
			workspace: "1",
			branches: [{ portfolios: EMPTY, taskChain: ["5"], unhomed: true }],
			tags: EMPTY,
			assignee,
			customFields,
		});
		expect(isAllowed(policy, unhomed("51"), "task:complete")).toBe(true);
		expect(
			decide(policy, unhomed("51"), "task:complete").branches[0]?.winners.map((r) => r.index),
		).toStrictEqual([7]);
		expect(isAllowed(policy, unhomed("52"), "task:complete")).toBe(false);
		const noFields: ReadonlyMap<string, ReadonlySet<string>> = new Map();
		expect(isAllowed(policy, unhomed("51", noFields), "task:complete")).toBe(false);
		// Inside a project the project-level rule is more specific than the cross-cutting one.
		const mine = taskIn("22", undefined, { assignee: "51", customFields: fields });
		expect(
			decide(policy, mine, "task:complete").branches[0]?.winners.map((r) => r.index),
		).toStrictEqual([5]);
	});

	it("handles unhomed tasks and subtrees", async () => {
		const policy = await policyPromise;
		const unhomed: Facts = {
			workspace: "1",
			branches: [{ portfolios: EMPTY, taskChain: ["5"], unhomed: true }],
		};
		expect(isAllowed(policy, unhomed, "task:create")).toBe(true);
		expect(isAllowed(policy, unhomed, "task:update")).toBe(false);
		expect(isAllowed(policy, unhomed, "story:update")).toBe(false);
		const deep: Facts = {
			...unhomed,
			branches: [{ portfolios: EMPTY, taskChain: ["5", "900"], unhomed: true }],
		};
		expect(isAllowed(policy, deep, "story:update")).toBe(true);
	});

	it("never lets a tag, assignee or custom field rule make an object visible, but lets it hide one", async () => {
		const policy = await compilePolicy(
			parsePolicy(
				'version: 1\nworkspace: Acme\nrules:\n  - where: { tag: ai-ok }\n    allow: [task:read, task:update]\n  - where: { project: "22" }\n    allow: [read]\n  - where: { project: "22", tag: frozen }\n    deny: [task:read]\n',
			),
			fakeResolver,
		);
		expect(isVisible(policy, tagged("21", "41"), "task")).toBe(false);
		expect(isVisible(policy, taskIn("22"), "task")).toBe(true);
		expect(isAllowed(policy, tagged("22", "41"), "task:update")).toBe(true);
		expect(isVisible(policy, tagged("22", "42"), "task")).toBe(false);
	});

	it("intersects field allowlists across branches", async () => {
		const policy = await compilePolicy(
			parsePolicy(
				`version: 1\nworkspace: Acme\nrules:\n  - where: { project: "21" }\n    allow: [read]\n    fields: { task: [name, due_on] }\n  - where: { project: "22" }\n    allow: [read]\n    fields: { task: [due_on] }\n`,
			),
			fakeResolver,
		);
		const both: Facts = {
			...taskIn("21"),
			branches: [...taskIn("21").branches, ...taskIn("22").branches],
		};
		expect(fieldAllowlist(policy, both, "task")).toStrictEqual(new Set(["due_on"]));
		expect(fieldAllowlist(policy, taskIn("21"), "task")).toStrictEqual(new Set(["name", "due_on"]));
	});

	it("does not let a `fields` allow narrow an equally specific unrestricted allow", async () => {
		const policy = await compilePolicy(
			parsePolicy(
				`version: 1\nworkspace: Acme\nrules:\n  - where: { project: "21" }\n    allow: [read, task:update]\n  - where: { project: "21" }\n    allow: [read]\n    fields: { task: [completed] }\n`,
			),
			fakeResolver,
		);
		expect(fieldAllowlist(policy, taskIn("21"), "task")).toBeUndefined();
	});

	it("lets deny, confirm and limit wildcards cover the explicit-only actions", async () => {
		const policy = await compilePolicy(
			parsePolicy(
				`version: 1\nworkspace: Acme\nrules:\n  - allow: [read, webhook:create, export:create]\n    confirm: ["*"]\n    limit: { "*:create": { max: 1, per: 1h } }\n  - where: { project: "21" }\n    deny: [modify]\n`,
			),
			fakeResolver,
		);
		expect(isAllowed(policy, taskIn("21"), "webhook:create")).toBe(false);
		expect(isAllowed(policy, taskIn("22"), "webhook:create")).toBe(true);
		const effective = constraintsFor(policy, taskIn("22"));
		expect(effective.confirm.has("export:create")).toBe(true);
		expect(effective.limits.has("webhook:create")).toBe(true);
	});

	it("judges due-date filters by the due time when the task has one", () => {
		const state = taskState({ due_on: "2026-11-04", due_at: "2026-11-04T09:00:00.000Z" });
		expect(state.dueOn).toBe("2026-11-04T09:00:00.000Z");
		const facts: Facts = { ...taskIn("21"), state };
		expect(stateMatches({ overdue: true }, facts, Date.parse("2026-11-04T12:00:00.000Z"))).toBe(
			true,
		);
		const soon = Date.parse("2026-11-04T08:30:00.000Z");
		expect(stateMatches({ dueWithinMs: 3_600_000 }, facts, soon)).toBe(true);
	});
});
