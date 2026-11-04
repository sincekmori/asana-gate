// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { Gate } from "../gate/gate.ts";
import { AsanaNameResolver } from "../gate/resolver.ts";
import { compilePolicies, type PolicySource } from "../policy/compile.ts";
import { loadPolicyFile } from "../policy/load.ts";
import type { Policy } from "../policy/types.ts";
import { POLICY_FILE, PROJECT_DIR } from "../settings/paths.ts";
import { policyCandidates, policyFiles } from "../settings/policy-files.ts";
import { UsageError } from "./context.ts";
import type { CommandContext } from "./session.ts";

/**
 * Loads the policy in force and compiles it against Asana: the file the
 * settings name (or found in its conventional place), with the user's own and
 * the administrator's policy files when they exist; every one of them must
 * allow an action for it to be allowed.
 */
async function loadPolicy(context: CommandContext): Promise<Policy> {
	const { loaded } = context;
	const first = loaded.settings.policy;
	if (first === undefined) {
		const looked = policyCandidates(loaded, process.cwd()).join(", ");
		throw new UsageError(
			`no policy file: run "asana-gate init" to create ${PROJECT_DIR}/${POLICY_FILE}, or pass --policy (looked for ${looked})`,
		);
	}
	const files = await policyFiles(loaded, first);
	context.logger.debug(`policy: ${files.map((entry) => entry.path).join(", ")}`);
	const sources: PolicySource[] = await Promise.all(
		files.map(async ({ path, role }) => ({ path, role, file: await loadPolicyFile(path) })),
	);
	return compilePolicies(sources, new AsanaNameResolver(context.client, { cache: context.cache }));
}

/** The gate of a command: the policy compiled, in front of the command's client. */
async function openGate(context: CommandContext): Promise<Gate> {
	const policy = await loadPolicy(context);
	return new Gate({ client: context.client, policy, logger: context.logger });
}

export { loadPolicy, openGate };
