// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { GATE_HELP, GateError, type PendingConfirmation } from "./errors.ts";

/** One pending confirmation, as the person asked for it sees it. */
function describePending(pending: PendingConfirmation): string {
	const name = pending.name === undefined ? "" : ` "${pending.name}"`;
	return `${pending.action} on ${pending.type} ${pending.gid}${name}`;
}

/** A request that needs a person's confirmation which was not given (or was declined). */
class ConfirmationRequiredError extends GateError {
	public override readonly name: string = "ConfirmationRequiredError";

	public constructor(pending: readonly PendingConfirmation[], declined = false) {
		const actions = [...new Set(pending.map((p) => p.action))].join(", ");
		super(
			declined ? 403 : 428,
			declined
				? `asana-gate: ${actions} was declined by the user`
				: `asana-gate: ${actions} needs a person's confirmation (the policy says so); the client did not provide one`,
			GATE_HELP,
		);
	}
}

export { ConfirmationRequiredError, describePending };
