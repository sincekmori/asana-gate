// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import { parseArgs } from "node:util";

import { isAbsent } from "../asana/errors.ts";
import { collect, type Named, named } from "../gate/identity.ts";
import { POLICY_FILE, PROJECT_DIR } from "../settings/paths.ts";
import { isFile } from "../system.ts";
import { AGENT_NAMES, agentsNamed, wireAgents } from "./agent.ts";
import { loadCliSettings, TOKEN_OPTIONS, UsageError, usageRows } from "./context.ts";
import { type CommandContext, connect } from "./session.ts";
import {
	MAX_LISTED,
	PROJECT_GITIGNORE,
	PROJECT_SETTINGS,
	renderPolicy,
	USER_SETTINGS,
	writeFiles,
} from "./skeleton.ts";

const INIT_OPTIONS = {
	workspace: {
		type: "string",
		short: "w",
		placeholder: "<gid>",
		description: "Workspace gid (required when the token sees several)",
	},
	agent: {
		type: "string",
		multiple: true,
		placeholder: "<name>",
		description: `Also wire the project for an agent (repeatable): ${AGENT_NAMES.join(", ")}`,
	},
	user: {
		type: "boolean",
		default: false,
		description: "Initialize ~/.asana-gate instead of the current project",
	},
	force: { type: "boolean", default: false, description: "Overwrite existing files" },
	...TOKEN_OPTIONS,
} as const;

const USAGE = `Usage: asana-gate init [options]

Create the project's .asana-gate directory: a policy skeleton for the
workspace, a settings file and a .gitignore. Files that exist are kept unless
--force. With --user, set up ~/.asana-gate (your defaults for every project)
instead.

Options:
${usageRows(INIT_OPTIONS)}`;

/** How many workspaces `init` lists when it asks which one. */
const MAX_WORKSPACES = 100;

/** The workspace to set up: the one `gid` names, or the only one the token sees. */
function chooseWorkspace(workspaces: readonly Named[], gid: string | undefined): Named {
	const matching = gid === undefined ? workspaces : workspaces.filter((w) => w.gid === gid);
	const [first, second] = matching;
	if (first !== undefined && second === undefined) {
		return first;
	}
	const problem = gid === undefined ? "pass --workspace <gid>" : `no workspace ${gid}`;
	const list = workspaces.map((w) => `  ${w.gid}  ${w.name}`).join("\n");
	const seen =
		workspaces.length >= MAX_WORKSPACES
			? `the first ${workspaces.length} of the workspaces the token sees`
			: `the token sees ${workspaces.length} workspaces`;
	throw new UsageError(`${problem}; ${seen}:\n${list}`);
}

/** No teams: the workspace is not an organization (only those have teams); other failures propagate. */
function noTeams(error: unknown): Named[] {
	if (isAbsent(error)) {
		return [];
	}
	throw error;
}

/** Looks at the workspace and renders the policy skeleton for it. */
async function surveyedPolicy(context: CommandContext, gid: string | undefined): Promise<string> {
	const { client } = context;
	const workspaces = await collect(
		client,
		{ path: "/workspaces", query: { opt_fields: ["name"] }, max: MAX_WORKSPACES },
		named,
	);
	// The list shows at most a page; a workspace beyond it is still found by its gid.
	const beyond =
		gid !== undefined &&
		workspaces.length >= MAX_WORKSPACES &&
		!workspaces.some((workspace) => workspace.gid === gid);
	const workspace = beyond
		? await client
				.get<Record<string, unknown>>(`/workspaces/${encodeURIComponent(gid)}`, {
					opt_fields: ["name"],
				})
				.then((found) => named(found) ?? chooseWorkspace(workspaces, gid))
				.catch(() => chooseWorkspace(workspaces, gid))
		: chooseWorkspace(workspaces, gid);
	const [teams, projects] = await Promise.all([
		collect(
			client,
			{
				path: `/workspaces/${workspace.gid}/teams`,
				query: { opt_fields: ["name"] },
				max: MAX_LISTED,
			},
			named,
		).catch((error: unknown) => noTeams(error)),
		collect(
			client,
			{
				path: `/workspaces/${workspace.gid}/projects`,
				query: { opt_fields: ["name"], archived: false },
				max: MAX_LISTED,
			},
			named,
		),
	]);
	console.log(`workspace ${workspace.name} (${workspace.gid})`);
	return renderPolicy(workspace, teams, projects);
}

async function runInit(argv: readonly string[], version: string): Promise<number> {
	const { values } = parseArgs({ args: [...argv], options: INIT_OPTIONS, strict: true });
	if (values.help === true) {
		console.log(USAGE);
		return 0;
	}
	const agents = agentsNamed(values.agent ?? []);
	if (agents.length > 0 && values.user) {
		throw new UsageError("--agent wires a project, not ~/.asana-gate; drop --user");
	}
	const loaded = await loadCliSettings(values);
	const root = loaded.projectDir ?? process.cwd();
	const dir = values.user ? loaded.home : join(root, PROJECT_DIR);
	const files = new Map<string, string>();
	if (values.force || !(await isFile(join(dir, POLICY_FILE)))) {
		files.set(POLICY_FILE, await surveyedPolicy(await connect(loaded), values.workspace));
	}
	files.set("settings.yaml", values.user ? USER_SETTINGS : PROJECT_SETTINGS);
	if (!values.user) {
		files.set(".gitignore", PROJECT_GITIGNORE);
	}
	// Your home directory's files are yours alone; a project's are shared like its code.
	const written = await writeFiles(dir, files, { force: values.force, ownerOnly: values.user });
	for (const [file, status] of written) {
		console.log(`${status} ${file}`);
	}
	if (agents.length > 0) {
		const wiring = await wireAgents(root, agents, {
			version,
			tokenEnv: loaded.settings.token.env,
		});
		for (const file of wiring.written) {
			console.log(`wrote ${file}`);
		}
		for (const note of wiring.notes) {
			console.log(`note: ${note}`);
		}
		for (const { file, text } of wiring.instructions) {
			console.log(`\nAdd to ${file}:\n\n${text}`);
		}
	}
	return 0;
}

export { runInit };
