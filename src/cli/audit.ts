// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { EXPLICIT_ONLY_ACTIONS, verbOf } from "../catalog/resources.ts";
import type { FactsLoader } from "../gate/facts.ts";
import { type AsanaObject, refsOf, stringOf } from "../gate/objects.ts";
import { messageOf } from "../log.ts";
import {
	type Branch,
	grantedActions,
	isFilterRule,
	isVisible,
	workspaceFacts,
} from "../policy/evaluate.ts";
import { type Reference, referencesOf } from "../policy/references.ts";
import { type Policy, ruleLabel } from "../policy/types.ts";
import { exposureOf, statIfPresent, unwritableFile } from "../system.ts";
import type { CommandContext } from "./session.ts";
import { tokenFileWarning } from "./token.ts";

/** What `check` audits: the policy's claims against Asana, and the environment the gate runs in. */

/** Something `check` found: a problem fails the command, a warning does not. */
interface Finding {
	readonly level: "problem" | "warning";
	readonly text: string;
}

const problem = (text: string): Finding => ({ level: "problem", text });
const warning = (text: string): Finding => ({ level: "warning", text });

/** Rules that say less than they seem to. */
function policyWarnings(policy: Policy): Finding[] {
	const findings: Finding[] = [];
	const granted = grantedActions(policy);
	const explicit = [...granted].filter((action) => EXPLICIT_ONLY_ACTIONS.has(action));
	if (explicit.length > 0) {
		findings.push(warning(`explicit-only actions granted: ${explicit.join(", ")}`));
	}
	for (const rule of policy.rules) {
		if (isFilterRule(rule) && [...rule.actions].some((action) => verbOf(action) === "read")) {
			findings.push(
				warning(
					`${ruleLabel(policy, rule)} allows read through a tag/assignee/custom_field filter; filters never make objects visible, so that part has no effect`,
				),
			);
		}
	}
	if (granted.size > 0 && !isVisible(policy, workspaceFacts(policy.workspace), "workspace")) {
		findings.push(
			warning(
				"workspace:read is not allowed at workspace level, so the requests that start from the workspace (workspace-wide lists and searches, typeahead, users) answer 404",
			),
		);
	}
	if (granted.size === 0) {
		findings.push(
			warning(
				policy.layers.length > 1
					? "the policy files allow no action in common; every request will be refused"
					: "no rule allows anything; every request will be refused",
			),
		);
	}
	for (const layer of policy.layers) {
		if (layer.otherWorkspace !== undefined) {
			findings.push(
				warning(
					`${layer.file} governs workspace ${layer.otherWorkspace}, not ${policy.workspaceName} (${policy.workspace}), so it is not in force`,
				),
			);
		}
	}
	return findings;
}

/** Whether a section sits in one of the projects of the rule naming it (a rule without projects takes any). */
function inRuleProject(policy: Policy, reference: Reference, branches: readonly Branch[]): boolean {
	const projects = policy.rules.find(
		(rule) => rule.layer === reference.layer && rule.index === reference.rule,
	)?.where.projects;
	return (
		projects === undefined ||
		branches.some((branch) => branch.project !== undefined && projects.has(branch.project))
	);
}

/** The policy whose claims are audited, and what reads Asana for it. */
interface Audit {
	readonly policy: Policy;
	readonly loader: FactsLoader;
	readonly client: CommandContext["client"];
}

/**
 * The `values` custom field `field` cannot hold, each with why: no option of
 * an enum field, no user of a people field, no object of a type a reference
 * field takes. A field of any other type holds a text, which nothing checks.
 */
async function unheld(audit: Audit, field: string, values: readonly string[]): Promise<string[]> {
	const definition = await audit.client.get<AsanaObject>(
		`/custom_fields/${encodeURIComponent(field)}`,
		{ opt_fields: ["resource_subtype", "enum_options.name"] },
	);
	const subtype = stringOf(definition.resource_subtype);
	if (subtype === "enum" || subtype === "multi_enum") {
		const options = refsOf(definition.enum_options);
		const listed = options.map((option) => `${option.gid} ${option.name ?? ""}`).join(", ");
		return values
			.filter((value) => !options.some((option) => option.gid === value))
			.map((value) => `${JSON.stringify(value)} is none of the field's options (${listed})`);
	}
	const types =
		subtype === "people" ? (["user"] as const) : await audit.loader.referenceTypes(field);
	if (types === undefined) {
		return [];
	}
	// By its gid: Asana also answers a user by `me` or an email, which no field holds.
	const found = await Promise.all(values.map((value) => audit.loader.probe(value, types)));
	return values
		.filter((value, index) => found[index]?.object.gid !== value)
		.map((value) => `${JSON.stringify(value)} names nothing the field holds`);
}

/** What is wrong with one object the policy names: gone, elsewhere, misplaced, or unable to hold a value. */
async function faultsOf(audit: Audit, reference: Reference): Promise<string[]> {
	const { policy } = audit;
	const loaded = await audit.loader.load(reference.resource, reference.gid);
	if (loaded === undefined) {
		return ["not found (deleted, or not visible to this token)"];
	}
	if (reference.resource !== "user" && loaded.facts.workspace !== policy.workspace) {
		return [`in another workspace (${loaded.facts.workspace}), so the rule never applies`];
	}
	if (
		reference.resource === "section" &&
		!inRuleProject(policy, reference, loaded.facts.branches)
	) {
		return ["not a section of the rule's project, so the rule never applies"];
	}
	const { values = [] } = reference;
	return values.length === 0 ? [] : unheld(audit, reference.gid, values);
}

/** Checks every object the policy names against Asana, and reports what is wrong with each. */
async function auditReferences(audit: Audit): Promise<{ checked: number; findings: Finding[] }> {
	const references = referencesOf(audit.policy);
	const faults = await Promise.all(
		references.map(async (reference) => {
			try {
				return await faultsOf(audit, reference);
			} catch (error) {
				return [`could not be checked (${messageOf(error)})`];
			}
		}),
	);
	const findings = references.flatMap((reference, index) => {
		const rule = ruleLabel(audit.policy, { index: reference.rule, layer: reference.layer });
		return (faults[index] ?? []).map((fault) =>
			problem(`${rule}.${reference.at} ${reference.gid}: ${fault}`),
		);
	});
	return { checked: references.length, findings };
}

/** The log file as the process found it, and the token and log files' permissions. */
async function auditEnvironment(context: CommandContext): Promise<Finding[]> {
	const findings: Finding[] = [];
	// Opening the log stream fails later than it returns, so the file is probed here too.
	const { file } = context.log;
	const logProblem =
		context.log.problem ?? (typeof file === "string" ? await unwritableFile(file) : undefined);
	if (logProblem !== undefined) {
		findings.push(
			warning(`log: ${file ?? ""} cannot be opened (${logProblem}); warnings reach stderr only`),
		);
	}
	// Created owner-only, but one that was there already keeps its mode.
	const logInfo = typeof file === "string" ? await statIfPresent(file) : undefined;
	const logExposure = typeof file === "string" ? exposureOf(file, logInfo?.mode) : undefined;
	if (logExposure !== undefined) {
		findings.push(warning(`log: ${logExposure}`));
	}
	const token = tokenFileWarning(context.token);
	if (token !== undefined) {
		findings.push(warning(`token: ${token}`));
	}
	return findings;
}

export { auditEnvironment, auditReferences, policyWarnings, warning };
export type { Finding };
