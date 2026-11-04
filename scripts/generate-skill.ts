import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { format } from "oxfmt";

import manifest from "../package.json" with { type: "json" };
import { BATCH_LIMIT } from "../src/asana/client.ts";
import { RESOURCE_VERBS, RESOURCES, type Resource } from "../src/catalog/resources.ts";
import { COMMANDS, usageOf } from "../src/cli/commands.ts";
import { flagForm, flagNotes, type FlagSpec, flagsOf } from "../src/cli/flags.ts";
import { type AnyToolSpec, TOOLS } from "../src/mcp/tools.ts";

// Generates the Agent Skill under skills/asana-gate from the code and the
// README, so that what agents learn about asana-gate cannot drift from what
// it does: SKILL.md carries the prose of scripts/skill/SKILL.template.md
// with the tool and resource tables filled in, and references/ holds the
// README's policy, MCP and command-line sections plus a tool reference
// derived from the tool definitions. A test fails when the committed files
// differ from this output:
//
//   pnpm generate-skill

const { version } = manifest;
const ROOT = join(import.meta.dirname, "..");
const SKILL_DIR = join(ROOT, "skills", "asana-gate");

// One sentence per line; the folded YAML scalar joins them with spaces. The
// description is what makes an agent reach for the skill, so it names every
// situation the skill covers.
const DESCRIPTION_SENTENCES = [
	"Operate Asana through asana-gate, the policy gateway that puts a declarative YAML policy in front of the Asana REST API for AI agents, as MCP tools (asana_*) and the asana-gate command line.",
	"Use this whenever a task touches asana-gate in any way: writing or fixing a policy (where/allow/deny scopes, constraints such as required members, title prefixes, rate limits and confirmations), running asana-gate commands, calling its MCP tools, reading its refusals (404 Not a recognized ID, 403 asana-gate:, 400 does not satisfy the policy, 428 confirmation, 429 limit), configuring .asana-gate settings or the cache, or deciding what an agent may do in Asana.",
	"Also applies when the user mentions allowed_actions, an Asana policy, the gate, or an MCP server for Asana without naming asana-gate.",
];

/** Each tool's command, for the tools that have one. */
const COMMAND_OF = new Map(COMMANDS.map((command) => [command.spec, command]));

/** The command-line form of a tool, when it has one. */
function commandOf(spec: AnyToolSpec): string | undefined {
	const command = COMMAND_OF.get(spec);
	return command === undefined ? undefined : `asana-gate ${usageOf(command)}`;
}

function toolsTable(): string {
	const rows = TOOLS.map((spec) => {
		const command = commandOf(spec);
		const shell = command === undefined ? "—" : `\`${command}\``;
		return `| \`${spec.name}\` | ${shell} | ${spec.description} |`;
	});
	return ["| Tool | Command line | What it does |", "| --- | --- | --- |", ...rows].join("\n");
}

const code = (word: string): string => `\`${word}\``;

/** Resources grouped by their verbs, in catalog order. */
function resourceTable(): string {
	const groups = new Map<string, Resource[]>();
	for (const resource of RESOURCES) {
		const key = RESOURCE_VERBS[resource].join(" ");
		groups.set(key, [...(groups.get(key) ?? []), resource]);
	}
	const rows = [...groups].map(
		([verbs, resources]) =>
			`| ${resources.map((r) => code(r)).join(" ")} | ${verbs
				.split(" ")
				.map((v) => code(v))
				.join(" ")} |`,
	);
	return ["| Resource | Verbs |", "| --- | --- |", ...rows].join("\n");
}

function flagRow(flag: FlagSpec): string {
	const form = `\`${flagForm(flag)}\`${flag.positional ? " (positional)" : ""}`;
	const meaning = [flag.description, ...flagNotes(flag)].filter((part) => part !== "").join("; ");
	return `| \`${flag.key}\` | ${form} | ${flag.required ? "yes" : "no"} | ${meaning} |`;
}

function toolsReference(): string {
	const sections = TOOLS.map((spec) => {
		const command = commandOf(spec);
		const marks = [
			spec.readOnly === true ? "read-only" : "",
			spec.destructive === true ? "destructive" : "",
		].filter((mark) => mark !== "");
		const flags = COMMAND_OF.get(spec)?.flags ?? flagsOf(spec);
		return [
			`## \`${spec.name}\` — ${spec.title}${marks.length > 0 ? ` (${marks.join(", ")})` : ""}`,
			"",
			spec.description,
			"",
			command === undefined
				? "No command-line form: use `asana-gate api` or the tool."
				: `Command line: \`${command}\``,
			"",
			...(flags.length > 0
				? [
						"| Input | Command-line form | Required | Meaning |",
						"| --- | --- | --- | --- |",
						...flags.map((flag) => flagRow(flag)),
					]
				: ["No inputs."]),
			"",
		].join("\n");
	});
	return sections.join("\n");
}

/** The README section under `heading`, up to (not including) `until`. */
function readmeSection(readme: string, heading: string, until: string): string {
	const start = readme.indexOf(`\n## ${heading}\n`);
	const end = readme.indexOf(`\n## ${until}\n`, start + 1);
	if (start === -1 || end === -1) {
		throw new Error(`README section "${heading}" (until "${until}") not found`);
	}
	return readme.slice(start + 1, end + 1);
}

async function formatted(name: string, text: string): Promise<string> {
	const result = await format(name, text);
	if (result.errors.length > 0) {
		throw new Error(`${name}: ${result.errors.map((error) => error.message).join("; ")}`);
	}
	return result.code;
}

/** Every file of the skill, keyed by its path under skills/asana-gate. */
async function renderSkillFiles(): Promise<Map<string, string>> {
	const [template, readme] = await Promise.all([
		readFile(join(import.meta.dirname, "skill", "SKILL.template.md"), "utf8"),
		readFile(join(ROOT, "README.md"), "utf8"),
	]);
	if (DESCRIPTION_SENTENCES.join(" ").length > 1024) {
		throw new Error("SKILL.md description over the 1024-character cap");
	}
	const fromReadme = `<!-- Generated by scripts/generate-skill.ts from the asana-gate README (version ${version}); edit the README instead. -->\n\n`;
	const skill = template
		.replace("{{DESCRIPTION}}", DESCRIPTION_SENTENCES.join("\n  "))
		.replace("{{VERSION}}", version)
		.replaceAll("{{BATCH_LIMIT}}", String(BATCH_LIMIT))
		.replace("{{TOOLS_TABLE}}", toolsTable())
		.replace("{{RESOURCE_TABLE}}", resourceTable());
	const tools = `<!-- Generated by scripts/generate-skill.ts from src/mcp/tools.ts (version ${version}); do not edit by hand. -->\n\n# asana-gate tools\n\nEvery curated MCP tool, its inputs and its command-line form.\n\n${toolsReference()}`;
	const files = new Map<string, string>([
		["SKILL.md", skill],
		["references/policy.md", fromReadme + readmeSection(readme, "Policy", "MCP server")],
		["references/mcp.md", fromReadme + readmeSection(readme, "MCP server", "CLI")],
		["references/cli.md", fromReadme + readmeSection(readme, "CLI", "Keeping up with Asana's API")],
		["references/tools.md", tools],
	]);
	const entries = await Promise.all(
		[...files].map(async ([path, text]) => [path, await formatted(path, text)] as const),
	);
	return new Map(entries);
}

if (process.argv[1] === import.meta.filename) {
	const files = await renderSkillFiles();
	await mkdir(join(SKILL_DIR, "references"), { recursive: true });
	await Promise.all([...files].map(([path, text]) => writeFile(join(SKILL_DIR, path), text)));
	console.log(`wrote ${files.size} files to ${SKILL_DIR}`);
}

export default renderSkillFiles;
