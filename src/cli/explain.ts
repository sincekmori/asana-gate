// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { parseArgs } from "node:util";

import { isResource, type Resource } from "../catalog/resources.ts";
import { FactsLoader, type Loaded } from "../gate/facts.ts";
import { stringOf } from "../gate/objects.ts";
import { constraintsFor, labelOf } from "../policy/effective.ts";
import {
	type Branch,
	decide,
	type Decision,
	explainResource,
	type Facts,
} from "../policy/evaluate.ts";
import { type Policy, ruleLabel } from "../policy/types.ts";
import { COMMON_OPTIONS, UsageError, usageRows } from "./context.ts";
import { loadPolicy } from "./policy.ts";
import { createContext } from "./session.ts";

const EXPLAIN_OPTIONS = {
	type: {
		type: "string",
		short: "t",
		placeholder: "<resource>",
		description: "The object's type (task, project, section, …); probed when omitted",
	},
	...COMMON_OPTIONS,
} as const;

const USAGE = `Usage: asana-gate explain [options] <gid>

Show how the policy treats one object: where it sits, which actions are
allowed, and which rules decided each one. Reads Asana without the policy's
restrictions, so an invisible object is explained, not hidden.

Options:
${usageRows(EXPLAIN_OPTIONS)}`;

const PROBE_ORDER: readonly Resource[] = [
	"task",
	"project",
	"section",
	"portfolio",
	"team",
	"tag",
	"goal",
	"story",
	"attachment",
	"status_update",
	"project_brief",
	"custom_field",
];

function describeBranch(branch: Branch): string {
	const parts = [
		branch.team === undefined ? undefined : `team ${branch.team}`,
		branch.portfolios.size === 0 ? undefined : `portfolios ${[...branch.portfolios].join(",")}`,
		branch.project === undefined ? undefined : `project ${branch.project}`,
		branch.section === undefined ? undefined : `section ${branch.section}`,
		branch.unhomed ? "unhomed" : undefined,
		branch.taskChain.length > 1 ? `ancestors ${branch.taskChain.slice(1).join(" > ")}` : undefined,
	];
	const text = parts.filter((part) => part !== undefined).join(", ");
	return text === "" ? "workspace level" : text;
}

/** Prints the constraints in force for the object's resource. */
function printConstraints(policy: Policy, loaded: Loaded): void {
	const effective = constraintsFor(policy, loaded.facts);
	const lines: string[] = [];
	const label = (key: string): string => labelOf(effective, key);
	for (const [key, requirements] of effective.require.get(loaded.type) ?? []) {
		lines.push(
			`  require ${label(key)}: ${requirements.map((r) => JSON.stringify(r)).join(" and ")}`,
		);
	}
	for (const [key, application] of effective.apply.get(loaded.type) ?? []) {
		lines.push(`  apply   ${label(key)}: ${JSON.stringify(application)}`);
	}
	const forbid = effective.forbid.get(loaded.type);
	if (forbid !== undefined && forbid.size > 0) {
		lines.push(`  forbid  ${[...forbid].join(", ")}`);
	}
	const redact = effective.redact.get(loaded.type);
	if (redact !== undefined && redact.size > 0) {
		lines.push(`  redact  ${[...redact].join(", ")}`);
	}
	for (const { rule, action, limit } of [...effective.limits.values()].flat()) {
		lines.push(`  limit   ${action}: ${limit.max} per ${limit.per} (${ruleLabel(policy, rule)})`);
	}
	for (const [action, rules] of effective.confirm) {
		lines.push(`  confirm ${action} (${rules.map((r) => ruleLabel(policy, r)).join(", ")})`);
	}
	if (lines.length > 0) {
		console.log("constraints:");
		for (const line of lines) {
			console.log(line);
		}
	}
}

/** One file of the policy on its own, so its decision can be told from the others'. */
function fileView(policy: Policy, index: number): Policy {
	return { ...policy, layers: [], rules: policy.rules.filter((rule) => rule.layer === index) };
}

/** The rules that decided an action in one view of the policy, or the default. */
function decidedBy(view: Policy, facts: Facts, action: Decision["action"]): string {
	const winners = decide(view, facts, action).branches.flatMap((b) =>
		b.winners.map((r) => `${ruleLabel(view, r)} ${r.effect}`),
	);
	return winners.length === 0
		? "no rule mentions it (default deny)"
		: [...new Set(winners)].join(", ");
}

/** Why an action is allowed or denied: per file when the policy has several, since every file must allow it. */
function reasonOf(policy: Policy, facts: Facts, action: Decision["action"]): string {
	if (policy.layers.length <= 1) {
		return decidedBy(policy, facts, action);
	}
	return policy.layers
		.flatMap((layer, index) =>
			layer.otherWorkspace === undefined
				? [`${layer.role}: ${decidedBy(fileView(policy, index), facts, action)}`]
				: [],
		)
		.join("; ");
}

function printExplanation(policy: Policy, loaded: Loaded): void {
	const { facts } = loaded;
	const name = stringOf(loaded.object.name);
	console.log(
		`${loaded.type} ${stringOf(loaded.object.gid) ?? ""}${name === undefined ? "" : ` "${name}"`}`,
	);
	console.log(
		`workspace: ${facts.workspace}${facts.workspace === policy.workspace ? "" : " (not the policy's workspace)"}`,
	);
	for (const branch of facts.branches) {
		console.log(`placement: ${describeBranch(branch)}`);
	}
	if (facts.tags !== undefined && facts.tags.size > 0) {
		console.log(`tags:      ${[...facts.tags].join(", ")}`);
	}
	if (facts.assignee !== undefined) {
		console.log(`assignee:  ${facts.assignee ?? "(none)"}`);
	}
	for (const [gid, values] of facts.customFields ?? []) {
		console.log(`field ${gid}: ${[...values].join(" | ")}`);
	}
	const explanation = explainResource(policy, facts, loaded.type);
	console.log(explanation.visible ? "visible:   yes" : "visible:   NO (requests return 404)");
	for (const decision of explanation.actions) {
		const verdict = decision.allowed ? "allow" : "deny ";
		console.log(
			`  ${verdict} ${decision.action.padEnd(28)} ${reasonOf(policy, facts, decision.action)}`,
		);
	}
	printConstraints(policy, loaded);
}

async function runExplain(argv: readonly string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: [...argv],
		options: EXPLAIN_OPTIONS,
		allowPositionals: true,
		strict: true,
	});
	if (values.help === true) {
		console.log(USAGE);
		return 0;
	}
	const [gid] = positionals;
	if (gid === undefined) {
		throw new UsageError("explain needs the gid of an object");
	}
	if (values.type !== undefined && !isResource(values.type)) {
		throw new UsageError(`unknown resource type "${values.type}"`);
	}
	const context = await createContext(values);
	const policy = await loadPolicy(context);
	// Every fact, whether the policy reads it or not: explain shows them all.
	const loader = new FactsLoader({
		client: context.client,
		policy,
		logger: context.logger,
		allFacts: true,
	});
	const loaded =
		values.type === undefined
			? await loader.probe(gid, PROBE_ORDER)
			: await loader.load(values.type, gid);
	if (loaded === undefined) {
		console.log(`${values.type ?? "object"} ${gid}: not found (or not accessible with this token)`);
		return 1;
	}
	printExplanation(policy, loaded);
	return 0;
}

export { runExplain };
