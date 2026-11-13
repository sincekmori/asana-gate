// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { cp, rm } from "node:fs/promises";
import { basename, join } from "node:path";

import { isObject, type JsonObject, parseJsonc } from "../json.ts";
import { messageOf } from "../log.ts";
import { POLICY_FILE, PROJECT_DIR, TOKEN_FILE } from "../settings/paths.ts";
import { firstWhere, isFile, patchedJson, readIfPresent } from "../system.ts";
import { parseYaml } from "../yaml.ts";
import { type Finding, warning } from "./audit.ts";
import { UsageError } from "./context.ts";

/**
 * How a repository is wired for a coding agent: the gate as a project MCP
 * server in the file the agent reads its servers from, a copy of the skill
 * where the agent reads skills, and, where the agent honors one, a rule that
 * keeps the token file from it. The MCP server keeps every copy of the skill
 * current.
 */

const SKILL = "asana-gate";
const TOKEN_DENY = `Read(./${PROJECT_DIR}/${TOKEN_FILE})`;
/** The member every agent's MCP file lists its servers under. */
const SERVERS = "mcpServers";

/** What one agent reads. */
interface Agent {
	readonly name: string;
	/** The file its MCP servers are declared in; agents may share one. */
	readonly mcpFile: string;
	/** The directories it reads project skills from; `init` writes the first. */
	readonly skillsDirs: readonly [string, ...string[]];
	/** The file its standing instructions live in. */
	readonly instructionsFile: string;
	/** The settings file that takes a rule keeping it from the token file, when it honors one. */
	readonly tokenGuard?: string;
}

const AGENTS: readonly Agent[] = [
	{
		name: "claude-code",
		mcpFile: ".mcp.json",
		skillsDirs: [join(".claude", "skills")],
		instructionsFile: "CLAUDE.md",
		tokenGuard: join(".claude", "settings.json"),
	},
	{
		name: "vscode",
		mcpFile: ".mcp.json",
		skillsDirs: [join(".agents", "skills"), join(".github", "skills"), join(".claude", "skills")],
		instructionsFile: join(".github", "copilot-instructions.md"),
	},
	{
		name: "cursor",
		mcpFile: join(".cursor", "mcp.json"),
		skillsDirs: [join(".agents", "skills"), join(".cursor", "skills"), join(".claude", "skills")],
		instructionsFile: "AGENTS.md",
	},
];

/** The agents `init --agent` knows. */
const AGENT_NAMES = AGENTS.map((agent) => agent.name);

/** Every directory an agent may read the skill from, so that a copy anywhere is kept current. */
const SKILL_DIRS = [...new Set(AGENTS.flatMap((agent) => agent.skillsDirs))];

/** Every file an agent may start the gate from. */
const MCP_FILES = [...new Set(AGENTS.map((agent) => agent.mcpFile))];

const usage = (message: string): Error => new UsageError(message);

/** The agents the names stand for; an unknown name is a usage error. */
function agentsNamed(names: readonly string[]): Agent[] {
	return names.map((name) => {
		const agent = AGENTS.find((candidate) => candidate.name === name);
		if (agent === undefined) {
			throw usage(`unknown agent "${name}" (known: ${AGENT_NAMES.join(", ")})`);
		}
		return agent;
	});
}

/** The skill shipped in the package: `skills/asana-gate` beside `dist` (or beside `src` in a checkout). */
async function packagedSkillDir(): Promise<string> {
	const here = import.meta.dirname;
	const roots = [here, join(here, ".."), join(here, "..", "..")];
	const root = await firstWhere(roots, (dir) => isFile(join(dir, "skills", SKILL, "SKILL.md")));
	if (root === undefined) {
		throw new Error("the packaged skill is missing");
	}
	return join(root, "skills", SKILL);
}

/** A copy of the skill in the project: its directory, and the version its frontmatter carries. */
interface SkillCopy {
	readonly dir: string;
	readonly version: string;
}

/** The version in a copied SKILL.md's frontmatter, or `undefined` when no readable copy is at `dir`. */
async function copiedVersion(dir: string): Promise<string | undefined> {
	const text = await readIfPresent(join(dir, "SKILL.md"));
	const frontmatter =
		text === undefined ? undefined : /^---\r?\n(?<yaml>.*?)\r?\n---/su.exec(text)?.groups?.yaml;
	if (frontmatter === undefined) {
		return undefined;
	}
	try {
		const parsed = parseYaml(frontmatter, "SKILL.md", (message) => new Error(message));
		const metadata = isObject(parsed) && isObject(parsed.metadata) ? parsed.metadata : {};
		return typeof metadata.version === "string" ? metadata.version : undefined;
	} catch {
		return undefined;
	}
}

/** The copies of the skill in the project, wherever an agent reads them. */
async function skillCopies(projectDir: string): Promise<SkillCopy[]> {
	const copies = await Promise.all(
		SKILL_DIRS.map(async (dir) => ({
			dir: join(dir, SKILL),
			version: await copiedVersion(join(projectDir, dir, SKILL)),
		})),
	);
	return copies.filter((copy): copy is SkillCopy => copy.version !== undefined);
}

/** Replaces `target` with a fresh copy of the packaged skill at `source`, its eval cases left out. */
async function copySkill(source: string, target: string): Promise<void> {
	await rm(target, { recursive: true, force: true });
	await cp(source, target, { recursive: true, filter: (path) => basename(path) !== "evals" });
}

/** The MCP server entry that starts the gate for this project, pinned to this version. */
function serverEntry(version: string): JsonObject {
	return { type: "stdio", command: "npx", args: ["-y", `${SKILL}@${version}`, "mcp"] };
}

/** The version the gate's entry in an agent's MCP file pins, when the entry is there. */
function pinnedVersion(document: JsonObject): string | undefined {
	const servers = document[SERVERS];
	const entry = isObject(servers) && isObject(servers[SKILL]) ? servers[SKILL] : {};
	const args = Array.isArray(entry.args) ? (entry.args as unknown[]) : [];
	const spec = args.find(
		(arg): arg is string => typeof arg === "string" && arg.startsWith(`${SKILL}@`),
	);
	return spec?.slice(SKILL.length + 1);
}

/** What `init --agent` did, and what the person still has to do. */
interface Wiring {
	readonly written: string[];
	/** Per agent, the standing instructions to add and the file they belong in. */
	readonly instructions: { readonly file: string; readonly text: string }[];
	readonly notes: string[];
}

/** What an agent's standing instructions should say so that it reaches Asana only through the gate. */
function instructionsFor(agent: Agent): string {
	return [
		"## Asana",
		"",
		`Tasks for this repository live in the Asana project "<project>", reached only through asana-gate: the \`asana-gate\` MCP server in ${agent.mcpFile}, governed by ${PROJECT_DIR}/${POLICY_FILE}.`,
		`Read ${join(agent.skillsDirs[0], SKILL, "SKILL.md")} before touching Asana.`,
		`Never call the Asana API any other way, and never read ${PROJECT_DIR}/${TOKEN_FILE}.`,
	].join("\n");
}

/** Wires `projectDir` for `agents`: skill copies, MCP entries and, where honored, the token rule. */
async function wireAgents(
	projectDir: string,
	agents: readonly Agent[],
	version: string,
): Promise<Wiring> {
	const source = await packagedSkillDir();
	const skillDirs = [...new Set(agents.map((agent) => agent.skillsDirs[0]))];
	const mcpFiles = [...new Set(agents.map((agent) => agent.mcpFile))];
	const guards = [
		...new Set(agents.map((agent) => agent.tokenGuard).filter((file) => file !== undefined)),
	];
	// Every file is read and patched first, so one that cannot be parsed leaves the project as it was.
	const writes = await Promise.all([
		...mcpFiles.map((file) =>
			patchedJson(join(projectDir, file), usage, (document) => {
				const current = document[SERVERS];
				const servers = isObject(current) ? current : {};
				servers[SKILL] = serverEntry(version);
				document[SERVERS] = servers;
			}),
		),
		...guards.map((file) =>
			patchedJson(join(projectDir, file), usage, (document) => {
				const permissions = isObject(document.permissions) ? document.permissions : {};
				const deny = Array.isArray(permissions.deny) ? (permissions.deny as unknown[]) : [];
				if (!deny.includes(TOKEN_DENY)) {
					deny.push(TOKEN_DENY);
				}
				permissions.deny = deny;
				document.permissions = permissions;
			}),
		),
	]);
	await Promise.all([
		...skillDirs.map((dir) => copySkill(source, join(projectDir, dir, SKILL))),
		...writes.map((write) => write()),
	]);
	const unguarded = agents
		.filter((agent) => agent.tokenGuard === undefined)
		.map((agent) => agent.name);
	return {
		written: [...skillDirs.map((dir) => join(dir, SKILL)), ...mcpFiles, ...guards],
		instructions: agents.map((agent) => ({
			file: agent.instructionsFile,
			text: instructionsFor(agent),
		})),
		notes:
			unguarded.length === 0
				? []
				: [
						`${unguarded.join(" and ")} cannot be kept from reading files in the project, so keep the token out of it: "asana-gate token set --user" or $ASANA_ACCESS_TOKEN.`,
					],
	};
}

/** Rewrites every copy of the skill in the project that is from another version; resolves to the directories refreshed. */
async function refreshSkillCopies(projectDir: string, version: string): Promise<string[]> {
	const copies = await skillCopies(projectDir);
	const stale = copies.filter((copy) => copy.version !== version);
	if (stale.length === 0) {
		return [];
	}
	const source = await packagedSkillDir();
	await Promise.all(stale.map((copy) => copySkill(source, join(projectDir, copy.dir))));
	return stale.map((copy) => copy.dir);
}

/** One agent's MCP file as `check` sees it: the version it pins, or why it cannot be read. */
interface Pin {
	readonly file: string;
	readonly version?: string;
	readonly problem?: string;
}

async function pinOf(projectDir: string, file: string): Promise<Pin> {
	try {
		const text = await readIfPresent(join(projectDir, file));
		const document = text === undefined ? undefined : parseJsonc(text, file, usage);
		const version = isObject(document) ? pinnedVersion(document) : undefined;
		return { file, ...(version !== undefined && { version }) };
	} catch (error) {
		return { file, problem: messageOf(error) };
	}
}

/** Agent files that belong to another version of asana-gate than this one. */
async function auditAgentFiles(projectDir: string, version: string): Promise<Finding[]> {
	const [copies, pins] = await Promise.all([
		skillCopies(projectDir),
		Promise.all(MCP_FILES.map((file) => pinOf(projectDir, file))),
	]);
	return [
		...pins
			.filter((pin) => pin.problem !== undefined)
			.map((pin) => warning(`${pin.problem ?? ""}; the agent may not start the gate`)),
		...copies
			.filter((copy) => copy.version !== version)
			.map((copy) =>
				warning(
					`${copy.dir} is the skill of asana-gate ${copy.version}; this is ${version}: the MCP server refreshes it when it starts, or run "asana-gate init --agent …"`,
				),
			),
		...pins
			.filter((pin) => pin.version !== undefined && pin.version !== version)
			.map((pin) =>
				warning(
					`${pin.file} starts asana-gate ${pin.version ?? "?"}; this is ${version}: run "asana-gate init --agent …" to update it`,
				),
			),
	];
}

export { AGENT_NAMES, agentsNamed, auditAgentFiles, refreshSkillCopies, wireAgents };
export type { Agent };
