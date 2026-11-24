// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import manifest from "../package.json" with { type: "json" };
import { agentsNamed, auditAgentFiles, refreshSkillCopies, wireAgents } from "../src/cli/agent.ts";
import { parseJsonc } from "../src/json.ts";

const { version } = manifest;

/** The variable the token is read from. */
const TOKEN_ENV = "ASANA_ACCESS_TOKEN";
/** The gate the tests wire projects to. */
const GATE = { version, tokenEnv: TOKEN_ENV };

/** A project wired for Claude Code and VS Code. */
async function wired(): Promise<string> {
	const project = await mkdtemp(join(tmpdir(), "asana-gate-agent-"));
	await wireAgents(project, agentsNamed(["claude-code", "vscode"]), GATE);
	return project;
}

/** A JSON file as the agents read it: comments and trailing commas allowed. */
const readJson = async (file: string): Promise<Record<string, unknown>> =>
	parseJsonc(await readFile(file, "utf8"), file, (message) => new Error(message)) as Record<
		string,
		unknown
	>;

describe("agent wiring", () => {
	it("writes the skill copies, the one server entry both agents read and the token rules", async () => {
		const project = await mkdtemp(join(tmpdir(), "asana-gate-agent-"));
		const agents = agentsNamed(["claude-code", "vscode"]);
		const { written, notes } = await wireAgents(project, agents, GATE);
		const mcp = (await readJson(join(project, ".mcp.json"))) as {
			mcpServers: { "asana-gate": { args: string[] } };
		};
		const settings = await readJson(join(project, ".claude", "settings.json"));
		expect(written).toStrictEqual([
			join(".claude", "skills", "asana-gate"),
			join(".agents", "skills", "asana-gate"),
			".mcp.json",
			join(".claude", "settings.json"),
		]);
		expect(mcp.mcpServers["asana-gate"].args).toContain(`asana-gate@${version}`);
		expect(settings).toStrictEqual({
			permissions: { deny: ["Read(./.asana-gate/token)", "Read(~/.asana-gate/token)"] },
			sandbox: { credentials: { envVars: [{ name: TOKEN_ENV, mode: "deny" }] } },
		});
		// Claude Code is told what turns the rules on for its commands, the others that nothing keeps them from the project's files.
		expect(notes).toStrictEqual([
			expect.stringContaining("/sandbox"),
			expect.stringMatching(/^vscode cannot be kept from reading files in the project/u),
		]);
		const copy = await readFile(
			join(project, ".agents", "skills", "asana-gate", "SKILL.md"),
			"utf8",
		);
		expect(copy).toContain(`version: "${version}"`);
	});

	it("audits a copy from another version and refreshes it when the server starts", async () => {
		const project = await wired();
		await expect(auditAgentFiles(project, version)).resolves.toStrictEqual([]);
		const copy = join(project, ".claude", "skills", "asana-gate", "SKILL.md");
		const text = await readFile(copy, "utf8");
		await writeFile(copy, text.replace(`version: "${version}"`, 'version: "0.0.0-old"'));
		await expect(auditAgentFiles(project, version)).resolves.toMatchObject([
			{ level: "warning", text: expect.stringContaining("0.0.0-old") as string },
		]);
		await expect(refreshSkillCopies(project, version)).resolves.toStrictEqual([
			join(".claude", "skills", "asana-gate"),
		]);
		await expect(readFile(copy, "utf8")).resolves.toContain(`version: "${version}"`);
	});

	it("audits and refreshes a skill copy whose frontmatter has CRLF line endings", async () => {
		const project = await wired();
		const copy = join(project, ".claude", "skills", "asana-gate", "SKILL.md");
		const text = await readFile(copy, "utf8");
		await writeFile(
			copy,
			text.replace(`version: "${version}"`, 'version: "0.0.0-old"').replaceAll("\n", "\r\n"),
		);
		await expect(auditAgentFiles(project, version)).resolves.toMatchObject([
			{ level: "warning", text: expect.stringContaining("0.0.0-old") as string },
		]);
		await expect(refreshSkillCopies(project, version)).resolves.toStrictEqual([
			join(".claude", "skills", "asana-gate"),
		]);
	});

	it("wires and audits a .mcp.json written with comments and trailing commas", async () => {
		const project = await mkdtemp(join(tmpdir(), "asana-gate-agent-"));
		const file = join(project, ".mcp.json");
		await writeFile(
			file,
			'{\n  // mine\n  "mcpServers": { "other": { "url": "http://x/*y*/" }, },\n  /* end */\n}\n',
		);
		await wireAgents(project, agentsNamed(["vscode"]), GATE);
		const document = (await readJson(file)) as { mcpServers: Record<string, unknown> };
		expect(Object.keys(document.mcpServers)).toStrictEqual(["other", "asana-gate"]);
		expect(document.mcpServers.other).toStrictEqual({ url: "http://x/*y*/" });
		const written = await readFile(file, "utf8");
		// The server entry is added in place: the file's comments stay.
		expect(written).toContain("// mine");
		expect(written).toContain("/* end */");
		await writeFile(file, written.replace("{", "{ // pinned\n"));
		await expect(auditAgentFiles(project, version)).resolves.toStrictEqual([]);
	});

	it("leaves the project as it was when an agent file cannot be parsed, and check says so", async () => {
		const project = await mkdtemp(join(tmpdir(), "asana-gate-agent-"));
		await writeFile(join(project, ".mcp.json"), "{ not json");
		await expect(wireAgents(project, agentsNamed(["claude-code"]), GATE)).rejects.toThrow(
			/\.mcp\.json/u,
		);
		await expect(readdir(project)).resolves.toStrictEqual([".mcp.json"]);
		await expect(auditAgentFiles(project, version)).resolves.toMatchObject([
			{ level: "warning", text: expect.stringMatching(/^\.mcp\.json.*may not start/u) as string },
		]);
	});

	it("adds the token rules to Claude Code's settings once, beside what is there", async () => {
		const project = await mkdtemp(join(tmpdir(), "asana-gate-agent-"));
		const file = join(project, ".claude", "settings.json");
		const masked = { name: TOKEN_ENV, mode: "mask" };
		await mkdir(join(project, ".claude"));
		await writeFile(
			file,
			JSON.stringify({
				permissions: { deny: ["Read(./.env)"] },
				sandbox: { enabled: true, credentials: { envVars: [masked] } },
			}),
		);
		const agents = agentsNamed(["claude-code"]);
		await wireAgents(project, agents, GATE);
		await wireAgents(project, agents, GATE);
		await expect(readJson(file)).resolves.toStrictEqual({
			permissions: {
				deny: ["Read(./.env)", "Read(./.asana-gate/token)", "Read(~/.asana-gate/token)"],
			},
			// A project's `mask` entry does nothing in Claude Code, so the variable is denied beside it.
			sandbox: {
				enabled: true,
				credentials: { envVars: [masked, { name: TOKEN_ENV, mode: "deny" }] },
			},
		});
	});

	it("rejects an agent it does not know", () => {
		expect(() => agentsNamed(["emacs"])).toThrow(/unknown agent "emacs"/u);
	});
});
