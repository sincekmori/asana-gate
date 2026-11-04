// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import manifest from "../package.json" with { type: "json" };
import { agentsNamed, auditAgentFiles, refreshSkillCopies, wireAgents } from "../src/cli/agent.ts";

const { version } = manifest;

/** A project wired for Claude Code and VS Code. */
async function wired(): Promise<string> {
	const project = await mkdtemp(join(tmpdir(), "asana-gate-agent-"));
	await wireAgents(project, agentsNamed(["claude-code", "vscode"]), version);
	return project;
}

const readJson = async (file: string): Promise<Record<string, unknown>> =>
	JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;

describe("agent wiring", () => {
	it("writes the skill copies, the server entries and the token rule", async () => {
		const project = await wired();
		const mcp = (await readJson(join(project, ".mcp.json"))) as {
			mcpServers: { "asana-gate": { args: string[] } };
		};
		const vscode = (await readJson(join(project, ".vscode", "mcp.json"))) as {
			servers: Record<string, unknown>;
		};
		const settings = (await readJson(join(project, ".claude", "settings.json"))) as {
			permissions: { deny: string[] };
		};
		expect(mcp.mcpServers["asana-gate"].args).toContain(`asana-gate@${version}`);
		expect(Object.keys(vscode.servers)).toStrictEqual(["asana-gate"]);
		expect(settings.permissions.deny).toStrictEqual(["Read(./.asana-gate/token)"]);
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

	it("wires and audits a VS Code mcp.json written with comments and trailing commas", async () => {
		const project = await mkdtemp(join(tmpdir(), "asana-gate-agent-"));
		await mkdir(join(project, ".vscode"));
		const file = join(project, ".vscode", "mcp.json");
		await writeFile(
			file,
			'{\n  // mine\n  "servers": { "other": { "url": "http://x/*y*/" }, },\n  /* end */\n}\n',
		);
		await wireAgents(project, agentsNamed(["vscode"]), version);
		const document = (await readJson(file)) as { servers: Record<string, unknown> };
		expect(Object.keys(document.servers)).toStrictEqual(["other", "asana-gate"]);
		expect(document.servers.other).toStrictEqual({ url: "http://x/*y*/" });
		const written = await readFile(file, "utf8");
		await writeFile(file, written.replace("{", "{ // pinned\n"));
		await expect(auditAgentFiles(project, version)).resolves.toStrictEqual([]);
	});

	it("leaves the project as it was when an agent file cannot be parsed, and check says so", async () => {
		const project = await mkdtemp(join(tmpdir(), "asana-gate-agent-"));
		await writeFile(join(project, ".mcp.json"), "{ not json");
		await expect(wireAgents(project, agentsNamed(["claude-code"]), version)).rejects.toThrow(
			/\.mcp\.json/u,
		);
		await expect(readdir(project)).resolves.toStrictEqual([".mcp.json"]);
		await expect(auditAgentFiles(project, version)).resolves.toMatchObject([
			{ level: "warning", text: expect.stringMatching(/^\.mcp\.json.*may not start/u) as string },
		]);
	});

	it("rejects an agent it does not know", () => {
		expect(() => agentsNamed(["emacs"])).toThrow(/unknown agent "emacs"/u);
	});
});
