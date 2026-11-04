// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { CLASSIFICATION, ruleFor } from "../src/catalog/classification.ts";
import { type OperationId, OPERATIONS } from "../src/catalog/operations.gen.ts";
import { EXPLICIT_ONLY_ACTIONS, isAction, type Resource } from "../src/catalog/resources.ts";
import type { FactsLoader } from "../src/gate/facts.ts";
import { createPlanContext } from "../src/gate/plan.ts";
import { compilePolicy } from "../src/policy/compile.ts";
import { workspaceFacts } from "../src/policy/evaluate.ts";
import { parsePolicy } from "../src/policy/load.ts";
import { fakeResolver } from "./helpers/fake-resolver.ts";

/** Operations whose classification does not name a valid action (the batch endpoint has none by design). */
const invalidActions = (): string[] =>
	Object.entries(CLASSIFICATION)
		.filter(
			([id, rule]) =>
				id !== "createBatchRequest" && (rule.action === undefined || !isAction(rule.action)),
		)
		.map(([id]) => id);

const EXPORTING = [
	"createOrganizationExport",
	"getOrganizationExport",
	"getAuditLogEvents",
	"createGraphExport",
	"createResourceExport",
	"createWebhook",
	"updateWebhook",
] as const;

/** Data-exporting operations whose action a group or wildcard could grant. */
const notExplicitOnly = (): string[] =>
	EXPORTING.filter((id) => {
		const rule = CLASSIFICATION[id];
		return rule.action === undefined || !EXPLICIT_ONLY_ACTIONS.has(rule.action);
	});

/** `<action> <scope>` of each operation. */
const summaries = (ids: readonly OperationId[]): Record<string, string> =>
	Object.fromEntries(
		ids.map((id) => [id, `${CLASSIFICATION[id].action ?? "-"} ${CLASSIFICATION[id].scope}`]),
	);

/**
 * Plans every operation with a `params` that records what is read, and
 * returns the reads of path parameters the operation does not declare.
 */
async function undeclaredParamReads(): Promise<string[]> {
	const policy = await compilePolicy(
		parsePolicy('version: 1\nworkspace: "1"\nrules:\n  - allow: ["*"]\n'),
		fakeResolver,
	);
	const loaded = (type: Resource | undefined, gid: string): unknown => ({
		type,
		object: { gid },
		facts: workspaceFacts(policy.workspace),
	});
	const loader = {
		load: (type: Resource, gid: string) => Promise.resolve(loaded(type, gid)),
		probe: (gid: string, types: readonly Resource[]) => Promise.resolve(loaded(types[0], gid)),
		loadRef: () => Promise.resolve(),
	} as unknown as FactsLoader;
	const reads = await Promise.all(
		(Object.keys(OPERATIONS) as OperationId[]).map(async (operationId) => {
			const spec = OPERATIONS[operationId];
			const read = new Set<string>();
			const params = new Proxy<Record<string, string>>(
				{},
				{
					get(_target, key): string {
						read.add(String(key));
						return "1";
					},
				},
			);
			const context = createPlanContext({
				operationId,
				spec,
				params,
				query: {},
				body: {},
				policy,
				loader,
				postProcess: (_response, body) => Promise.resolve(body),
				planner: (ctx) => ruleFor(ctx.operationId).plan(ctx),
			});
			// Most plans end in a refusal (no body, no query); only the reads matter.
			await Promise.allSettled([ruleFor(operationId).plan(context)]);
			const declared: readonly string[] = spec.pathParams;
			return [...read]
				.filter((key) => !declared.includes(key))
				.map((key) => `${operationId}: ${key}`);
		}),
	);
	return reads.flat();
}

describe("classification", () => {
	it("covers every operation of the OpenAPI definition, and nothing else", () => {
		expect(Object.keys(CLASSIFICATION).toSorted()).toStrictEqual(
			Object.keys(OPERATIONS).toSorted(),
		);
	});

	it("names a valid action for every operation except the batch endpoint", () => {
		expect(invalidActions()).toStrictEqual([]);
		expect(CLASSIFICATION.createBatchRequest.resource).toBeUndefined();
		expect(CLASSIFICATION.createBatchRequest.scope).toBe("batch");
	});

	it("keeps the data-exporting operations behind explicit-only actions", () => {
		expect(notExplicitOnly()).toStrictEqual([]);
	});

	it("classifies a plain read, update or delete of one object from its path, unless told otherwise", () => {
		expect(
			summaries([
				"getTask",
				"updateStory",
				"deleteWebhook",
				"updateWebhook",
				"getUser",
				"updateWorkspace",
				"getJob",
				"updateProject",
				"getProjectStatus",
				"updateEnumOption",
			]),
		).toStrictEqual({
			getTask: "task:read path",
			updateStory: "story:update path",
			deleteWebhook: "webhook:delete path",
			updateWebhook: "webhook:update path",
			getUser: "user:read workspace",
			updateWorkspace: "workspace:update workspace",
			getJob: "job:read workspace",
			updateProject: "project:update path",
			getProjectStatus: "status_update:read path",
			updateEnumOption: "custom_field:update workspace",
		});
	});

	it("keeps the action and scope of operations that share a planner", () => {
		expect(
			summaries([
				"getUser",
				"updateUserForWorkspace",
				"getTeamsForUser",
				"getFavoritesForUser",
				"getUserTaskListForUser",
				"instantiateProject",
				"projectSaveAsTemplate",
			]),
		).toStrictEqual({
			getUser: "user:read workspace",
			updateUserForWorkspace: "user:update workspace",
			getTeamsForUser: "team:read filter",
			getFavoritesForUser: "user:read filter",
			getUserTaskListForUser: "user_task_list:read workspace",
			instantiateProject: "project:create path",
			projectSaveAsTemplate: "project_template:create path",
		});
	});

	it("reads only the path parameters each operation declares", async () => {
		await expect(undeclaredParamReads()).resolves.toStrictEqual([]);
	});
});
