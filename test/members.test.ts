// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { ruleFor } from "../src/catalog/classification.ts";
import { updatableMembers } from "../src/catalog/members.ts";
import { type OperationId, OPERATIONS } from "../src/catalog/operations.gen.ts";

/** The members a `fields` allowlist of task may name. */
const UPDATABLE = updatableMembers("task") ?? new Set<string>();

/** The members sent by operations classified as `task:update` that a `fields` allowlist cannot name. */
const unnamable = (): string[] =>
	(Object.keys(OPERATIONS) as OperationId[])
		.filter((id) => ruleFor(id).action === "task:update")
		.flatMap((id) =>
			OPERATIONS[id].bodyParams
				.filter((member) => !UPDATABLE.has(member))
				.map((member) => `${id}: ${member}`),
		);

describe("update field allowlists", () => {
	it("can name every member an operation classified as task:update sends", () => {
		expect(unnamable()).toStrictEqual([]);
	});
});
