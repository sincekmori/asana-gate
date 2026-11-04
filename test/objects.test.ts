// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { objectOperationOf, READ_OPERATIONS } from "../src/catalog/object-operations.ts";
import { type OperationId, OPERATIONS } from "../src/catalog/operations.gen.ts";
import { RESOURCES } from "../src/catalog/resources.ts";
import { resourceOfType } from "../src/gate/objects.ts";

/** The resources more than one operation reads by gid (the loader would fetch only one of them). */
const readTwice = (): string[] => {
	const reads = (Object.keys(OPERATIONS) as OperationId[])
		.map((id) => objectOperationOf(OPERATIONS[id]))
		.filter((operation) => operation?.verb === "read")
		.map((operation) => String(operation?.resource));
	return reads.filter((resource, index) => reads.indexOf(resource) !== index);
};

describe("object operations", () => {
	it("reads each resource by gid through one operation", () => {
		expect(readTwice()).toStrictEqual([]);
		expect(Object.keys(READ_OPERATIONS)).toHaveLength(40);
		expect([READ_OPERATIONS.task, READ_OPERATIONS.status_update]).toStrictEqual([
			"getTask",
			"getStatus",
		]);
	});

	it("maps a resource_type to a resource the gate can judge from a gid alone", () => {
		expect(RESOURCES.filter((resource) => resourceOfType(resource) === undefined)).toStrictEqual([
			"custom_field_setting",
			"notification",
			"event",
			"export",
			"audit_log",
			"ai_studio_usage",
			"rule",
			"reaction",
		]);
		expect(
			["project_status", "actor", "enum_option"].map((type) => resourceOfType(type)),
		).toStrictEqual(["status_update", "user", undefined]);
	});

	it("does not take a member of Object.prototype for a resource", () => {
		expect(
			["constructor", "__proto__", "toString", "hasOwnProperty"].map((type) =>
				resourceOfType(type),
			),
		).toStrictEqual([undefined, undefined, undefined, undefined]);
	});
});
