// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { applyApplication, checkRequirement } from "../src/policy/constraints.ts";
import { parseDuration, resolveDateBound } from "../src/policy/durations.ts";

const NOW = new Date("2026-11-03T12:00:00.000Z");

const checkAt = (value: string, bound: Record<string, string>): string[] =>
	checkRequirement(value, bound, { verb: "create", now: NOW });

describe("durations and date bounds", () => {
	it("parses durations", () => {
		expect(parseDuration("30m")).toBe(1_800_000);
		expect(parseDuration("7d")).toBe(604_800_000);
		expect(parseDuration("soon")).toBeUndefined();
	});

	it("resolves absolute and relative date bounds", () => {
		expect(resolveDateBound("today", NOW)).toBe(Date.UTC(2026, 10, 3));
		expect(resolveDateBound("+1d", NOW)).toBe(NOW.getTime() + 86_400_000);
		expect(resolveDateBound("2026-12-24", NOW)).toBe(Date.UTC(2026, 11, 24));
		expect(resolveDateBound("whenever", NOW)).toBeUndefined();
	});
});

describe("checkRequirement", () => {
	it("treats `present` differently on create and update", () => {
		expect(checkRequirement(undefined, { present: true }, { verb: "create" })).toStrictEqual([
			"is required",
		]);
		expect(checkRequirement(undefined, { present: true }, { verb: "update" })).toStrictEqual([]);
		expect(checkRequirement("", { present: true }, { verb: "update" })).toStrictEqual([
			"cannot be cleared",
		]);
		expect(checkRequirement("x", { present: true }, { verb: "update" })).toStrictEqual([]);
	});

	it("checks text operators", () => {
		const requirement = { prefix: "[AI] ", maxLength: 12, notMatches: /secret/iu };
		expect(checkRequirement("[AI] hello", requirement, { verb: "create" })).toStrictEqual([]);
		expect(checkRequirement("hello", requirement, { verb: "create" })).toStrictEqual([
			'must start with "[AI] "',
		]);
		expect(checkRequirement("[AI] a SECRET plan", requirement, { verb: "create" })).toHaveLength(2);
	});

	it("checks value sets against references, lists and scalars", () => {
		const requirement = { in: new Set(["51", "me"]) };
		expect(checkRequirement("51", requirement, { verb: "create" })).toStrictEqual([]);
		expect(checkRequirement({ gid: "52" }, requirement, { verb: "create" })).toStrictEqual([
			"must be one of 51, me",
		]);
		expect(checkRequirement(["51", "52"], requirement, { verb: "create" })).toHaveLength(1);
	});

	it("checks numeric and date bounds", () => {
		expect(checkRequirement(3, { min: 1, max: 5 }, { verb: "create", now: NOW })).toStrictEqual([]);
		expect(checkRequirement(9, { max: 5 }, { verb: "create", now: NOW })).toStrictEqual([
			"must be at most 5",
		]);
		expect(
			checkRequirement("2026-11-10", { min: "today" }, { verb: "create", now: NOW }),
		).toStrictEqual([]);
		expect(
			checkRequirement("2026-10-01", { min: "today" }, { verb: "create", now: NOW }),
		).toStrictEqual(["must be on or after today"]);
	});

	it("compares a date-only member with relative bounds by calendar day", () => {
		expect(checkAt("2026-11-10", { min: "+7d" })).toStrictEqual([]);
		expect(checkAt("2026-11-09", { min: "+7d" })).toStrictEqual(["must be on or after +7d"]);
		expect(checkAt("2026-11-03", { min: "now" })).toStrictEqual([]);
		expect(checkAt("2026-11-02", { min: "-1d" })).toStrictEqual([]);
		expect(checkAt("2026-11-03", { max: "today" })).toStrictEqual([]);
	});

	it("keeps the time of day of an instant", () => {
		expect(checkAt("2026-11-03T11:00:00.000Z", { min: "now" })).toStrictEqual([
			"must be on or after now",
		]);
	});
});

describe("applyApplication", () => {
	it("fills defaults only when the member is empty, and forces values always", () => {
		expect(applyApplication(undefined, { default: "me" }, "create")).toBe("me");
		expect(applyApplication("bob", { default: "me" }, "create")).toBe("bob");
		expect(applyApplication(undefined, { default: "me" }, "update")).toBeUndefined();
		expect(applyApplication("bob", { value: "me" }, "update")).toBe("me");
	});

	it("adds prefixes and suffixes without duplicating them", () => {
		expect(applyApplication("hello", { prefix: "[AI] " }, "create")).toBe("[AI] hello");
		expect(applyApplication("[AI] hello", { prefix: "[AI] " }, "update")).toBe("[AI] hello");
		expect(applyApplication(undefined, { suffix: "!" }, "create")).toBe("!");
	});

	it("adds list members on create, and on update only when the list is sent", () => {
		expect(applyApplication(["1"], { add: ["1", "2"] }, "create")).toStrictEqual(["1", "2"]);
		expect(applyApplication(undefined, { add: ["2"] }, "create")).toStrictEqual(["2"]);
		expect(applyApplication(undefined, { add: ["2"] }, "update")).toBeUndefined();
	});
});
