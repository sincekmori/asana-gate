// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isAction } from "../src/catalog/resources.ts";
import {
	type Command,
	COMMANDS,
	commandHelp,
	findCommand,
	nounHelp,
	nouns,
	usageOf,
} from "../src/cli/commands.ts";
import { UsageError } from "../src/cli/context.ts";
import { coerce, type FlagSpec } from "../src/cli/flags.ts";
import { renderBody, renderErrors } from "../src/cli/output.ts";
import { TOOLS } from "../src/mcp/tools.ts";

/** A command that must exist. */
function command(noun: string, verb?: string): Command {
	const found = findCommand(noun, verb);
	if (found === undefined) {
		throw new Error(`no command ${noun} ${verb ?? ""}`);
	}
	return found;
}

/** A flag of a command that must exist. */
function flagOf(target: Command, name: string): FlagSpec {
	const found = target.flags.find((flag) => flag.flag === name);
	if (found === undefined) {
		throw new Error(`no flag --${name} on ${usageOf(target)}`);
	}
	return found;
}

describe("command line commands", () => {
	it("derives one command per tool that has a command-line form", () => {
		const shaped = TOOLS.filter((tool) => tool.cli !== false);
		expect(COMMANDS).toHaveLength(shaped.length);
		expect(nouns()).toStrictEqual([
			"task",
			"comment",
			"attachment",
			"project",
			"section",
			"status",
			"workspace",
			"user",
			"team",
			"tag",
			"portfolio",
			"custom-field",
			"find",
		]);
	});

	it("names positionals and flags from the tool's schema", () => {
		const update = command("task", "update");
		expect(usageOf(update)).toBe("task update <task_gid>");
		const flags = update.flags.filter((flag) => !flag.positional).map((flag) => flag.flag);
		expect(flags).toStrictEqual(
			expect.arrayContaining(["name", "notes", "assignee", "due-on", "completed", "custom-fields"]),
		);
		const section = command("task", "move").flags.find((flag) => flag.key === "section_gid");
		expect(section?.flag).toBe("section");
		expect(command("find").verb).toBe("");
	});

	it("coerces command-line values to the schema's types", async () => {
		const update = command("task", "update");
		await expect(coerce(flagOf(update, "completed"), true)).resolves.toBe(true);
		await expect(coerce(flagOf(update, "assignee"), "null")).resolves.toBeNull();
		await expect(coerce(flagOf(update, "custom-fields"), '{"1":"x"}')).resolves.toStrictEqual({
			"1": "x",
		});
		const projects = flagOf(command("task", "create"), "projects");
		await expect(coerce(projects, ["1,2", "3"])).resolves.toStrictEqual(["1", "2", "3"]);
	});

	it("writes help for nouns and verbs", () => {
		expect(nounHelp("task")).toContain("task create");
		const help = commandHelp(command("task", "create"));
		expect(help).toContain("--name <string>");
		expect(help).toContain("(required)");
		expect(help).toContain("--json");
	});
});

describe("tool declarations", () => {
	it("names the actions every tool needs and takes batch inputs as JSON, inline or from a file", async () => {
		expect(TOOLS.map((tool) => tool.needs.length)).not.toContain(0);
		expect(TOOLS.flatMap((tool) => tool.needs).filter((action) => !isAction(action))).toStrictEqual(
			[],
		);
		const tasks = flagOf(command("task", "create-many"), "tasks");
		expect(tasks.kind).toBe("json");
		await expect(coerce(tasks, '[{"name":"a"}]')).resolves.toStrictEqual([{ name: "a" }]);
		const dir = await mkdtemp(join(tmpdir(), "asana-gate-flags-"));
		const file = join(dir, "tasks.json");
		await writeFile(file, '[{"name":"b"}]');
		await expect(coerce(tasks, `@${file}`)).resolves.toStrictEqual([{ name: "b" }]);
	});

	it("reads @file relative to the -C directory and names a file it cannot read", async () => {
		const tasks = flagOf(command("task", "create-many"), "tasks");
		const dir = await mkdtemp(join(tmpdir(), "asana-gate-flags-"));
		await writeFile(join(dir, "tasks.json"), '[{"name":"c"}]');
		await expect(coerce(tasks, "@tasks.json", dir)).resolves.toStrictEqual([{ name: "c" }]);
		const missing = coerce(tasks, "@missing.json", dir);
		await expect(missing).rejects.toBeInstanceOf(UsageError);
		await expect(missing).rejects.toThrow(/^cannot read @missing\.json: /u);
	});
});

describe("output rendering", () => {
	it("renders lists as tables with a pagination hint", () => {
		const text = renderBody({
			data: [
				{
					gid: "1",
					name: "T1",
					completed: false,
					assignee: { gid: "9", name: "Me" },
					allowed_actions: ["task:read", "task:update"],
				},
				{ gid: "2", name: "T2", completed: true, assignee: null, allowed_actions: ["task:read"] },
			],
			next_page: { offset: "abc" },
		});
		expect(text).toContain("GID  NAME  COMPLETED  ASSIGNEE  ALLOWED");
		expect(text).toContain("1    T1    no         Me        read,update");
		expect(text).toContain("(more: pass --offset abc)");
	});

	it("renders objects as key/value lines and errors as one line", () => {
		const text = renderBody({
			data: {
				gid: "1",
				resource_type: "task",
				name: "T1",
				assignee: { gid: "9", name: "Me" },
				tags: [],
			},
		});
		expect(text).toBe("gid: 1\nname: T1\nassignee: Me (9)\ntags: ");
		expect(renderErrors(403, { errors: [{ message: "asana-gate: nope" }] })).toBe(
			"403 asana-gate: nope",
		);
		expect(renderBody({ data: [] })).toBe("(no results)");
		expect(renderBody({ data: {} })).toBe("ok");
	});

	it("renders an error body the way the client parses one", () => {
		expect(renderErrors(500, { errors: [{ message: "boom" }, { phrase: "x" }] })).toBe(
			"500 boom; HTTP 500",
		);
		expect(renderErrors(502, { unexpected: true })).toBe("502 HTTP 502");
	});

	it("renders a batch response as one line per action", () => {
		const text = renderBody({
			data: [
				{ status_code: 201, body: { data: { gid: "1", name: "T1" } } },
				{ status_code: 403, body: { errors: [{ message: "asana-gate: nope" }] } },
			],
		});
		expect(text).toBe("1. 201 1 T1\n2. 403 asana-gate: nope");
	});
});
