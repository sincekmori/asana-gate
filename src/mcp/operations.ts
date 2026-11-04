// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { CLASSIFICATION } from "../catalog/classification.ts";
import { type OperationId, OPERATIONS } from "../catalog/operations.gen.ts";
import { RESOURCE_VERBS, type Resource } from "../catalog/resources.ts";

/** Operation summary derived from its id: `getTasksForProject` → "Get tasks for project". */
function titleOf(operationId: string): string {
	const words = operationId
		.replaceAll(/(?<upper>[A-Z])/gu, " $<upper>")
		.toLowerCase()
		.trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Operations Asana's documentation deprecates in favour of another one,
 * which its OpenAPI definition does not mark: the project memberships and
 * project statuses, superseded by memberships and status updates.
 */
const SUPERSEDED: Partial<Record<OperationId, OperationId>> = {
	getProjectMembership: "getMembership",
	getProjectMembershipsForProject: "getMemberships",
	createProjectStatusForProject: "createStatusForObject",
	getProjectStatus: "getStatus",
	getProjectStatusesForProject: "getStatusesForObject",
	deleteProjectStatus: "deleteStatus",
};

/** One operation as `asana_operations` lists it. */
function describeOperation(operationId: OperationId): Record<string, unknown> {
	const spec = OPERATIONS[operationId];
	const rule = CLASSIFICATION[operationId];
	const use = SUPERSEDED[operationId];
	return {
		operation_id: operationId,
		method: spec.method,
		path: spec.path,
		summary: titleOf(operationId),
		group: spec.tag,
		action: rule.action ?? "(each batched action is checked on its own)",
		scope: rule.scope,
		path_params: spec.pathParams,
		query_params: spec.queryParams,
		body_params: spec.bodyParams,
		...((spec.deprecated || use !== undefined) && { deprecated: true }),
		...(use !== undefined && { use }),
	};
}

/** What `asana_operations` asks for. */
interface OperationsQuery {
	readonly search?: string;
	readonly resource?: Resource;
	readonly limit?: number;
}

/** The operations matching a query, with the action vocabulary. */
function listOperations(query: OperationsQuery): Record<string, unknown> {
	const needle = query.search?.toLowerCase();
	const ids = (Object.keys(OPERATIONS) as OperationId[]).filter((id) => {
		const spec = OPERATIONS[id];
		const haystack = `${id} ${spec.path} ${spec.tag}`.toLowerCase();
		return (
			(needle === undefined || haystack.includes(needle)) &&
			(query.resource === undefined || CLASSIFICATION[id].resource === query.resource)
		);
	});
	return {
		total: ids.length,
		operations: ids.slice(0, query.limit ?? 100).map((id) => describeOperation(id)),
		actions: RESOURCE_VERBS,
	};
}

export { listOperations };
export type { OperationsQuery };
