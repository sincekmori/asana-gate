// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { parseArgs } from "node:util";

import { FactsLoader } from "../gate/facts.ts";
import { cacheEntries } from "../gate/listing-cache.ts";
import {
	type CompiledConstraints,
	type CompiledRule,
	type Policy,
	PolicyError,
	ruleLabel,
} from "../policy/types.ts";
import { auditAgentFiles } from "./agent.ts";
import { auditEnvironment, auditReferences, policyWarnings } from "./audit.ts";
import { COMMON_OPTIONS, usageRows } from "./context.ts";
import { describeUser } from "./identity.ts";
import { loadPolicy } from "./policy.ts";
import { createContext } from "./session.ts";

const USAGE = `Usage: asana-gate check [options]

Validate the settings and the policy: the token works, every name resolves,
every gid the rules name still exists in the workspace, and the cache and log
directories can be written. Problems make the command fail (exit code 1);
warnings do not.

Options:
${usageRows(COMMON_OPTIONS)}`;

/** `resource.member` for every member a per-resource map or set names, with custom fields by name. */
function membersOf(
	labels: ReadonlyMap<string, string>,
	byResource: ReadonlyMap<string, ReadonlyMap<string, unknown> | ReadonlySet<string>>,
): string[] {
	return [...byResource].flatMap(([resource, members]) =>
		[...(members instanceof Set ? members : members.keys())].map((key: string) => {
			const label = labels.get(key);
			return label === undefined ? `${resource}.${key}` : `${resource} ${label}`;
		}),
	);
}

function describeConstraints(constraints: CompiledConstraints): string {
	const clauses: [string, string[]][] = [
		["require", membersOf(constraints.labels, constraints.require)],
		["apply", membersOf(constraints.labels, constraints.apply)],
		["forbid", membersOf(constraints.labels, constraints.forbid)],
		["redact", membersOf(constraints.labels, constraints.redact)],
		["limit", [...constraints.limit].map(([action, l]) => `${action} ${l.max} per ${l.per}`)],
		["confirm", [...constraints.confirm]],
	];
	return clauses
		.filter(([, items]) => items.length > 0)
		.map(([name, items]) => `${name} ${items.join(", ")}`)
		.join("; ");
}

function describeActions(rule: CompiledRule): string {
	const actions = [...rule.actions];
	return actions.length > 6
		? `${actions.slice(0, 6).join(", ")}, … (${actions.length} actions)`
		: actions.join(", ");
}

function describeRule(policy: Policy, rule: CompiledRule): string {
	const where = rule.raw.where === undefined ? "workspace" : JSON.stringify(rule.raw.where);
	const shown =
		rule.constraints === undefined ? describeActions(rule) : describeConstraints(rule.constraints);
	return `  ${ruleLabel(policy, rule)} ${rule.effect.padEnd(5)} level ${rule.specificity.level}.${rule.specificity.cross}  where ${where}\n           ${shown}`;
}

/** A policy that names something Asana does not have is a problem `check` reports (exit 1), not a usage error. */
function unresolved(error: unknown): undefined {
	if (!(error instanceof PolicyError)) {
		throw error;
	}
	console.log(`problem:    ${error.message}`);
	console.log("1 problems, 0 warnings");
}

async function runCheck(argv: readonly string[], version: string): Promise<number> {
	const { values } = parseArgs({ args: [...argv], options: COMMON_OPTIONS, strict: true });
	if (values.help === true) {
		console.log(USAGE);
		return 0;
	}
	const context = await createContext(values);
	const policy = await loadPolicy(context).catch(unresolved);
	if (policy === undefined) {
		return 1;
	}
	const { settings, projectDir } = context.loaded;
	const loader = new FactsLoader({ client: context.client, policy, logger: context.logger });
	const [references, environment, agent, listings] = await Promise.all([
		auditReferences(policy, loader),
		auditEnvironment(context),
		projectDir === undefined ? [] : auditAgentFiles(projectDir, version),
		settings.cache.enabled ? cacheEntries(settings.cache.dir) : 0,
	]);
	const cache = settings.cache.enabled ? `${settings.cache.dir} (${listings} listings)` : "off";
	console.log(`policy:     ${settings.policy ?? "?"}`);
	for (const layer of policy.layers) {
		if (layer.otherWorkspace === undefined && layer.file !== settings.policy) {
			console.log(`bounded by: ${layer.file} (${layer.role} policy)`);
		}
	}
	console.log(`workspace:  ${policy.workspaceName} (${policy.workspace})`);
	console.log(`token:      ${describeUser(policy.me)} from ${context.token.source}`);
	console.log(`cache:      ${cache}`);
	console.log(`log:        ${context.log.file ?? "stderr only"}`);
	console.log(`rules:      ${policy.rules.length} compiled statements`);
	for (const rule of policy.rules) {
		console.log(describeRule(policy, rule));
	}
	console.log(`references: ${references.checked} objects the rules name, checked against Asana`);
	const findings = [...policyWarnings(policy), ...references.findings, ...environment, ...agent];
	for (const finding of findings) {
		console.log(`${finding.level}:    ${finding.text}`);
	}
	const problems = findings.filter((finding) => finding.level === "problem").length;
	const warnings = findings.length - problems;
	console.log(findings.length === 0 ? "ok" : `${problems} problems, ${warnings} warnings`);
	return problems === 0 ? 0 : 1;
}

export { runCheck };
