// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { Gate } from "../gate/gate.ts";
import { AsanaNameResolver } from "../gate/resolver.ts";
import { compilePolicy } from "../policy/compile.ts";
import { loadPolicyFile } from "../policy/load.ts";
import type { Policy } from "../policy/types.ts";
import { policyCandidates } from "../settings/load.ts";
import { POLICY_FILE, PROJECT_DIR } from "../settings/paths.ts";
import { UsageError } from "./context.ts";
import type { CommandContext } from "./session.ts";

/** Loads the policy file the settings name (or found in its conventional place) and compiles it against Asana. */
async function loadPolicy(context: CommandContext): Promise<Policy> {
	const { loaded } = context;
	const path = loaded.settings.policy;
	if (path === undefined) {
		const looked = policyCandidates(loaded, process.cwd()).join(", ");
		throw new UsageError(
			`no policy file: run "asana-gate init" to create ${PROJECT_DIR}/${POLICY_FILE}, or pass --policy (looked for ${looked})`,
		);
	}
	context.logger.debug(`policy: ${path}`);
	const file = await loadPolicyFile(path);
	return compilePolicy(file, new AsanaNameResolver(context.client, { cache: context.cache }));
}

/** The gate of a command: the policy compiled, in front of the command's client. */
async function openGate(context: CommandContext): Promise<Gate> {
	const policy = await loadPolicy(context);
	return new Gate({ client: context.client, policy, logger: context.logger });
}

export { loadPolicy, openGate };
