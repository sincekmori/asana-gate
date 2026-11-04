// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { EXPLICIT_ONLY_ACTIONS, verbOf } from "../catalog/resources.ts";
import type { FactsLoader, Loaded } from "../gate/facts.ts";
import { messageOf } from "../log.ts";
import { type Branch, grantedActions, isFilterRule } from "../policy/evaluate.ts";
import { type Reference, referencesOf } from "../policy/references.ts";
import type { CompiledRule, Policy } from "../policy/types.ts";
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

/** The rules once each: a file rule compiles to statements that share its index and scope. */
function fileRules(policy: Policy): CompiledRule[] {
	return [...new Map(policy.rules.map((rule) => [rule.index, rule])).values()];
}

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
					`rules[${rule.index}] allows read through a tag/assignee/custom_field filter; filters never make objects visible, so that part has no effect`,
				),
			);
		}
	}
	if (granted.size === 0) {
		findings.push(warning("no rule allows anything; every request will be refused"));
	}
	for (const rule of fileRules(policy)) {
		for (const predicate of rule.where.customFields ?? []) {
			for (const value of predicate.unmatched ?? []) {
				findings.push(
					warning(
						`rules[${rule.index}].where.custom_field ${predicate.fieldGid}: "${value}" is not an option of the field`,
					),
				);
			}
		}
	}
	return findings;
}

/** Whether a section sits in one of the projects of the rule naming it (a rule without projects takes any). */
function inRuleProject(policy: Policy, reference: Reference, branches: readonly Branch[]): boolean {
	const projects = policy.rules.find((rule) => rule.index === reference.rule)?.where.projects;
	return (
		projects === undefined ||
		branches.some((branch) => branch.project !== undefined && projects.has(branch.project))
	);
}

/** Loads one object a scope names; resolves to why it failed when Asana did not answer it. */
async function loadOrFailure(
	loader: FactsLoader,
	reference: Reference,
): Promise<Loaded | undefined | string> {
	try {
		return await loader.load(reference.resource, reference.gid);
	} catch (error) {
		return messageOf(error);
	}
}

/** Loads every object the scopes name and reports the ones that are gone, elsewhere, or misplaced. */
async function auditReferences(
	policy: Policy,
	loader: FactsLoader,
): Promise<{ checked: number; findings: Finding[] }> {
	const references = referencesOf(policy);
	const objects = await Promise.all(
		references.map((reference) => loadOrFailure(loader, reference)),
	);
	const findings: Finding[] = [];
	for (const [index, reference] of references.entries()) {
		const at = `rules[${reference.rule}].where.${reference.member} ${reference.gid}`;
		const loaded = objects[index];
		if (typeof loaded === "string") {
			findings.push(problem(`${at}: could not be checked (${loaded})`));
		} else if (loaded === undefined) {
			findings.push(problem(`${at}: not found (deleted, or not visible to this token)`));
		} else if (reference.resource !== "user" && loaded.facts.workspace !== policy.workspace) {
			findings.push(
				problem(
					`${at}: in another workspace (${loaded.facts.workspace}), so the rule never applies`,
				),
			);
		} else if (
			reference.resource === "section" &&
			!inRuleProject(policy, reference, loaded.facts.branches)
		) {
			findings.push(
				problem(`${at}: not a section of the rule's project, so the rule never applies`),
			);
		}
	}
	return { checked: references.length, findings };
}

/** The directories the gate writes to, as the process found them, and the token and log files' permissions. */
async function auditEnvironment(context: CommandContext): Promise<Finding[]> {
	const { settings } = context.loaded;
	const findings: Finding[] = [];
	const cacheProblem = await context.cache?.unwritable();
	if (cacheProblem !== undefined) {
		findings.push(
			warning(
				`cache: ${settings.cache.dir} is not writable (${cacheProblem}); names are read from Asana each run (cache.enabled: false makes that intended)`,
			),
		);
	}
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
