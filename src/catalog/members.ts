// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { type OperationId, OPERATIONS } from "./operations.gen.ts";
import type { Resource } from "./resources.ts";
import { RESPONSE_SCHEMAS, SCHEMAS } from "./schemas.gen.ts";

/** The create and update operations whose request bodies describe a resource's writable members. */
const WRITE_OPERATIONS: Partial<Record<Resource, readonly OperationId[]>> = {
	task: ["createTask", "updateTask"],
	project: ["createProject", "updateProject"],
	section: ["createSectionForProject", "updateSection"],
	story: ["createStoryForTask", "updateStory"],
	attachment: ["createAttachmentForObject"],
	tag: ["createTagForWorkspace", "updateTag"],
	portfolio: ["createPortfolio", "updatePortfolio"],
	goal: ["createGoal", "updateGoal"],
	status_update: ["createStatusForObject"],
	project_brief: ["createProjectBrief", "updateProjectBrief"],
	custom_field: ["createCustomField", "updateCustomField"],
	team: ["createTeam", "updateTeam"],
	webhook: ["createWebhook", "updateWebhook"],
	membership: ["createMembership", "updateMembership"],
	allocation: ["createAllocation", "updateAllocation"],
	budget: ["createBudget", "updateBudget"],
	rate: ["createRate", "updateRate"],
	role: ["createRole", "updateRole"],
	record: ["createRecord", "updateRecord"],
	table: ["createTable", "updateTable"],
	ooo_entry: ["createOooEntry", "updateOooEntry"],
	time_tracking_category: ["createTimeTrackingCategory", "updateTimeTrackingCategory"],
	time_tracking_entry: ["createTimeTrackingEntry", "updateTimeTrackingEntry"],
	timesheet_approval_status: ["createTimesheetApprovalStatus", "updateTimesheetApprovalStatus"],
	goal_relationship: ["updateGoalRelationship"],
	project_portfolio_setting: ["updateProjectPortfolioSetting"],
	user: ["updateUser"],
};

/**
 * The request members a resource's create and update operations accept, from
 * the OpenAPI snapshot; `undefined` when the resource has no write operation.
 */
function requestMembers(resource: Resource): ReadonlySet<string> | undefined {
	const operations = WRITE_OPERATIONS[resource];
	if (operations === undefined) {
		return undefined;
	}
	return new Set(operations.flatMap((id) => OPERATIONS[id].bodyParams));
}

/** The response members of a resource's objects, from the OpenAPI snapshot; `undefined` when unknown. */
function responseMembers(resource: Resource): ReadonlySet<string> | undefined {
	const operations = WRITE_OPERATIONS[resource] ?? [];
	const names = new Set<string>();
	for (const id of operations) {
		const schema = RESPONSE_SCHEMAS[id];
		if (schema !== null) {
			const shape = SCHEMAS[schema];
			for (const member of Object.keys(shape)) {
				names.add(member);
			}
		}
	}
	return names.size > 0 ? names : undefined;
}

export { requestMembers, responseMembers };
