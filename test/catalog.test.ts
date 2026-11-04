// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { JSON_SCHEMA_FILES, jsonSchemaOf } from "../scripts/generate-schema.ts";
import { parseAsanaChange, parseRetryAfter } from "../src/asana/headers.ts";
import { RESOURCES } from "../src/catalog/resources.ts";
import { RESPONSE_SCHEMAS, SCHEMAS } from "../src/catalog/schemas.gen.ts";
import { reliedMembers, requiredFields, responseSchemaOf } from "../src/gate/facts.ts";

type Shape = Record<string, Record<string, null> | null>;

/** Operations whose response schema the snapshot does not describe. */
const undescribedOperations = (): string[] =>
	Object.entries(RESPONSE_SCHEMAS)
		.filter(([, schema]) => schema !== null && !(schema in SCHEMAS))
		.map(([id]) => id);

/** Resources the gate reads fields of without naming a response schema. */
const unnamedResources = (): string[] =>
	RESOURCES.filter(
		(resource) => responseSchemaOf(resource) === undefined && requiredFields(resource).length > 0,
	);

const shapeOf = (schema: string): Shape => SCHEMAS[schema as keyof typeof SCHEMAS];

/** Read members missing from their schema. */
const missingMembers = (): string[] =>
	reliedMembers()
		.filter(({ schema, member }) => !(member in shapeOf(schema)))
		.map(({ schema, member, resource }) => `${schema}.${member} (read for ${resource})`);

/** Nested read members missing from their member's shape; `parent` is a compact task in the schema and is verified live instead. */
const missingNestedMembers = (): string[] =>
	reliedMembers()
		.filter((m) => m.nested !== undefined && m.member !== "parent")
		.filter(({ schema, member, nested }) => !(String(nested) in (shapeOf(schema)[member] ?? {})))
		.map(({ schema, member, nested }) => `${schema}.${member}.${String(nested)}`);

describe("openapi snapshots", () => {
	it("records a response schema for every operation that returns objects", () => {
		expect(undescribedOperations()).toStrictEqual([]);
	});

	it("names a response schema for every resource whose objects the gate reads", () => {
		expect(unnamedResources()).toStrictEqual([]);
	});

	it("still describes every member the gate reads to place objects", () => {
		expect(missingMembers()).toStrictEqual([]);
	});

	it("still describes the nested members the gate reads", () => {
		expect(missingNestedMembers()).toStrictEqual([]);
	});
});

describe("shipped json schemas", () => {
	it.each(JSON_SCHEMA_FILES)("%s matches the schema generated from the code", async (file) => {
		const committed = await readFile(join(import.meta.dirname, "..", file), "utf8");
		const generated = JSON.stringify(jsonSchemaOf(file));
		expect(JSON.parse(committed)).toStrictEqual(JSON.parse(generated));
	});
});

describe("asana headers", () => {
	it("parses Asana-Change announcements", () => {
		const changes = parseAsanaChange(
			"name=new_user_task_lists;info=https://forum.asana.com/t/1, name=new_goal_memberships;info=https://forum.asana.com/t/2;affected=true",
		);
		expect(changes).toStrictEqual([
			{ name: "new_user_task_lists", info: "https://forum.asana.com/t/1", affected: false },
			{ name: "new_goal_memberships", info: "https://forum.asana.com/t/2", affected: true },
		]);
		expect(parseAsanaChange(null)).toStrictEqual([]);
	});

	it("parses Retry-After in seconds and as a date", () => {
		expect(parseRetryAfter("7")).toBe(7);
		expect(parseRetryAfter(null)).toBeUndefined();
		expect(parseRetryAfter("nonsense")).toBeUndefined();
		const soon = parseRetryAfter(new Date(Date.now() + 30_000).toUTCString());
		expect(soon).toBeGreaterThan(20);
		expect(soon).toBeLessThanOrEqual(30);
	});

	it("reads a blank, fractional or negative Retry-After as no header", () => {
		expect(["", "  ", "1.5", "-1", "10s"].map((value) => parseRetryAfter(value))).toStrictEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		]);
		expect(parseRetryAfter(" 3 ")).toBe(3);
		expect(parseRetryAfter("Sun, 06 Nov 1994 08:49:37 GMT")).toBe(0);
	});
});
