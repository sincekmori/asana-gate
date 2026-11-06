// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { redactObject } from "../gate/shape.ts";
import { stringOf } from "../json.ts";
import { isVisible, workspaceFacts } from "../policy/evaluate.ts";
import type { Policy } from "../policy/types.ts";
import { BATCH_NOTE } from "./tools.ts";

/** What the MCP server tells an agent when it connects: how the gate works, and whom it acts as. */

const INSTRUCTIONS = `asana-gate puts a policy in front of the Asana API. Everything you can see or do here is decided by that policy, not by Asana.

- Objects the policy hides do not exist for you: requests for them return the same "Not a recognized ID" 404 Asana returns for nonexistent gids, and lists never contain them.
- Every object in a response carries "allowed_actions": the <resource>:<verb> actions the policy currently allows on it (e.g. "task:update", "story:create"). Check it before writing; a refused action returns 403 with an asana-gate message.
- The policy may also shape requests: it can require members (a 400 names what is missing or wrong), fill in defaults and prefixes, hide members, cap how often an action runs (429), and ask the person for confirmation before an action (answer the elicitation).
- Use the curated asana_* tools for common work. asana_request reaches every Asana REST operation with the same policy; asana_operations lists them with the action each one needs; asana_allowed_actions tells what you may do with one object.
- Only the curated tools the policy could ever allow are listed; asana_request reaches every other operation the policy permits. ${BATCH_NOTE}
- Results are pages: pass next_page.offset back as offset to continue.`;

/**
 * Who every request runs as, for the instructions: the token's user, in the
 * governed workspace. The gids are always given, since the user references
 * in responses carry them anyway; the user's name and email only as far as
 * the policy would show them through `GET /users/me`.
 */
function identityOf(policy: Policy): string {
	const facts = workspaceFacts(policy.workspace);
	const readable = isVisible(policy, facts, "workspace") && isVisible(policy, facts, "user");
	const { me } = policy;
	const shown = readable
		? redactObject({ policy, facts }, "user", { name: me.name, email: me.email })
		: {};
	const name = stringOf(shown.name);
	const user = [
		...(name === undefined ? [] : [JSON.stringify(name)]),
		...[stringOf(shown.email)].filter((email) => email !== undefined),
		`gid ${me.gid}`,
	].join(", ");
	return `- Every request runs as the Asana user the access token belongs to (${user}), in the workspace ${JSON.stringify(policy.workspaceName)} (gid ${policy.workspace}). A user reference with gid ${me.gid} in a response (assignee, created_by, followers, …) is that user, and "me" in a request names them.`;
}

/** The server's instructions under `policy`. */
function instructionsFor(policy: Policy): string {
	return `${INSTRUCTIONS}\n${identityOf(policy)}`;
}

export { instructionsFor };
