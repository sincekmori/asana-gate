// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import * as z from "zod";

import type { HttpMethod } from "../src/catalog/operation-spec.ts";
import { type OperationId, OPERATIONS } from "../src/catalog/operations.gen.ts";
import type { GateRequest } from "../src/gate/gate.ts";
import { isObject } from "../src/gate/objects.ts";
import { matchRoute } from "../src/gate/router.ts";
import { TOOLS } from "../src/mcp/tools.ts";
import type { Policy } from "../src/policy/types.ts";

const POLICY: Policy = {
	workspace: "1",
	workspaceName: "Acme",
	me: { gid: "51" },
	layers: [{ file: "policy", role: "project" }],
	rules: [],
};

/**
 * Members the live API accepts though Asana's definition does not list them:
 * `tag` anchors a task list (Asana's own 400 names it), and `memberships`
 * places a new task in a section.
 */
const UNLISTED: Partial<Record<OperationId, readonly string[]>> = {
	getTasks: ["tag"],
	createTask: ["memberships"],
};

interface JsonSchema {
	readonly type?: string;
	readonly format?: string;
	readonly pattern?: string;
	readonly enum?: readonly unknown[];
	readonly anyOf?: readonly JsonSchema[];
	readonly items?: JsonSchema;
	readonly properties?: Readonly<Record<string, JsonSchema>>;
}

/** A value of a tool's input JSON Schema with every optional member given. */
function sampleOf(schema: JsonSchema, name = ""): unknown {
	const branch = schema.anyOf?.find((option) => option.type !== "null") ?? schema;
	if (branch.enum !== undefined) {
		return branch.enum[0];
	}
	switch (branch.type) {
		case "string": {
			if (branch.format === "uri") {
				return "https://example.test/";
			}
			if (branch.pattern === undefined) {
				return name;
			}
			return branch.pattern.includes("{4}") ? "2026-11-04" : "101";
		}
		case "integer":
		case "number": {
			return 1;
		}
		case "boolean": {
			return true;
		}
		case "array": {
			return [sampleOf(branch.items ?? {}, name)];
		}
		case "object": {
			const members = Object.entries(branch.properties ?? {});
			return Object.fromEntries(members.map(([key, member]) => [key, sampleOf(member, key)]));
		}
		default: {
			return null;
		}
	}
}

/** The members of one request its operation does not declare, or why it is no operation's. */
function undeclared(method: string, path: string, members: readonly string[]): string[] {
	const match = matchRoute(method.toUpperCase() as HttpMethod, path);
	if (match === undefined) {
		return [`${method} ${path}: no operation`];
	}
	const { operationId } = match;
	const spec = OPERATIONS[operationId];
	const declared = new Set([
		...spec.queryParams,
		...spec.bodyParams,
		...(UNLISTED[operationId] ?? []),
	]);
	return members
		.filter((member) => !declared.has(member))
		.map((member) => `${operationId}: ${member}`);
}

/** The requests a tool sends for a full input: itself, or the actions of its batch. */
function sentBy(request: GateRequest): { method: string; path: string; members: string[] }[] {
	const body = isObject(request.body) ? request.body : {};
	if (request.path !== "/batch") {
		return [{ ...request, members: [...Object.keys(request.query ?? {}), ...Object.keys(body)] }];
	}
	const actions: unknown[] = Array.isArray(body.actions) ? body.actions : [];
	return actions
		.filter((action) => isObject(action))
		.map((action) => ({
			method: String(action.method),
			path: String(action.relative_path),
			members: Object.keys(isObject(action.data) ? action.data : {}),
		}));
}

/** Per tool, what its requests send that the catalog does not state. */
function drift(): string[] {
	return TOOLS.flatMap((spec) => {
		const input = spec.input.parse(
			sampleOf(z.toJSONSchema(spec.input, { io: "input" }) as JsonSchema),
		);
		const request = spec.request(input, POLICY);
		const operation = matchRoute(request.method, request.path)?.operationId;
		return [
			...(operation === spec.operation ? [] : [`${spec.name}: sends ${String(operation)}`]),
			...sentBy(request).flatMap(({ method, path, members }) =>
				undeclared(method, path, members).map((problem) => `${spec.name}: ${problem}`),
			),
		];
	});
}

describe("curated tools", () => {
	it("send their operation, with the members the catalog states", () => {
		expect(drift()).toStrictEqual([]);
	});
});
