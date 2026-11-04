// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { ASANA_ERROR_HELP, type AsanaErrorEntry } from "../asana/errors.ts";

/** HTTP statuses the gate itself produces. */
type GateStatus = 400 | 403 | 404 | 428 | 429;

/**
 * A decision of the gate, shaped like an Asana error response so that
 * callers cannot tell an invisible object from a nonexistent one.
 */
class GateError extends Error {
	public override readonly name: string = "GateError";
	public readonly status: GateStatus;
	public readonly errors: readonly AsanaErrorEntry[];

	public constructor(status: GateStatus, message: string, help: string = ASANA_ERROR_HELP) {
		super(message);
		this.status = status;
		this.errors = [{ message, help }];
	}

	/** The response body, as Asana would send it. */
	public toBody(): { errors: AsanaErrorEntry[] } {
		return { errors: this.errors.map((e) => ({ ...e })) };
	}
}

const GATE_HELP =
	"This request was refused by the asana-gate policy, not by Asana. Ask for the allowed actions of the object (they are listed as `allowed_actions` on every object the gate returns) before retrying.";

/**
 * The 404 Asana returns for a gid that does not exist (verified live:
 * `task: Not a recognized ID: 1234567890`); used for invisible objects too.
 */
function notFound(type: string, gid: string): GateError {
	return new GateError(404, `${type}: Not a recognized ID: ${gid}`);
}

/** The 404 Asana returns for a path that matches no operation (verified live). */
function noRoute(): GateError {
	return new GateError(404, "No matching route for request");
}

/** A visible object on which the policy does not allow `action`. */
function forbidden(action: string, type: string, gid: string): GateError {
	return new GateError(403, `asana-gate: ${action} is not permitted on ${type} ${gid}`, GATE_HELP);
}

/** A visible object whose update touches a field outside the policy's allowlist. */
function forbiddenField(resource: string, field: string, allowed: Iterable<string>): GateError {
	return new GateError(
		403,
		`asana-gate: updating ${resource}.${field} is not permitted here (allowed fields: ${[...allowed].join(", ")})`,
		GATE_HELP,
	);
}

/** A request the gate cannot interpret. */
function badRequest(message: string): GateError {
	return new GateError(400, message, GATE_HELP);
}

/** A request whose content breaks the policy's constraints; `problems` name each one. */
function constraintViolation(resource: string, problems: readonly string[]): GateError {
	return new GateError(
		400,
		`asana-gate: the ${resource} does not satisfy the policy: ${problems.join("; ")}`,
		GATE_HELP,
	);
}

/** A request beyond a rate limit the policy sets. */
function limitExceeded(limit: {
	action: string;
	max: number;
	per: string;
	/** The rule that set the limit, as messages name it. */
	rule: string;
}): GateError {
	return new GateError(
		429,
		`asana-gate: ${limit.action} is limited to ${limit.max} per ${limit.per} by ${limit.rule}; try again later`,
		GATE_HELP,
	);
}

/**
 * A refusal of action `unit` of a batch, its message prefixed
 * (`actions[2]: …`); a request's own refusal, and any other error, as it is.
 */
function inAction(error: unknown, unit: number | undefined): unknown {
	return error instanceof GateError && unit !== undefined
		? new GateError(error.status, `actions[${unit}]: ${error.message}`, error.errors[0]?.help)
		: error;
}

/** One action a person must confirm before it runs. */
interface PendingConfirmation {
	readonly action: string;
	readonly type: string;
	readonly gid: string;
	readonly name?: string;
	readonly ruleIndex: number;
}

export {
	badRequest,
	constraintViolation,
	GATE_HELP,
	forbidden,
	forbiddenField,
	GateError,
	limitExceeded,
	noRoute,
	notFound,
	inAction,
};
export type { GateStatus, PendingConfirmation };
