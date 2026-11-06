// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";

import {
	acceptedContent,
	createRequestStateCodec,
	inputRequired,
	type InputRequiredResult,
	inputResponse,
	type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod";

import { ConfirmationRequiredError, describePending } from "../gate/confirmation.ts";
import type { PendingConfirmation } from "../gate/errors.ts";
import type { ConfirmHandler, GateRequest } from "../gate/gate.ts";

/** The protocol era a server instance serves (from the SDK's request context). */
type ProtocolEra = "legacy" | "modern";

/** The key under which the confirmation is requested and answered. */
const CONFIRM_KEY = "confirm";

const ConfirmationSchema = z.object({
	confirm: z.boolean().describe("Confirm the action"),
});

/**
 * How long a person has to answer a confirmation, in seconds: the life of a
 * modern question's sealed state, and the wait for a legacy answer, which the
 * SDK would otherwise give up on after its default request timeout of one
 * minute, too short for a person to notice the prompt, read it and decide.
 */
const ANSWER_SECONDS = 600;

/** What a confirmation's `requestState` carries: a digest of what the person was asked, for which call. */
interface ConfirmState {
	readonly asked: string;
}

/**
 * Seals the `requestState` of a confirmation, so an answer counts only for
 * the question this server asked: an answer sent without being asked, or
 * replayed for another question, makes the server ask again. The key lives
 * as long as the process, which serves every round of a call.
 */
const STATE = createRequestStateCodec<ConfirmState>({
	key: randomBytes(32),
	ttlSeconds: ANSWER_SECONDS,
	bind: (ctx) => ctx.mcpReq.method,
});

/** Verifies an echoed `requestState`; the server's `requestState.verify` hook. */
function verifyConfirmState(state: string, ctx: ServerContext): Promise<ConfirmState> {
	return STATE.verify(state, ctx);
}

/**
 * A digest of a question: the actions to confirm and the request they belong
 * to, so an answer does not carry over to the same action with other
 * arguments (another comment on the same task, another body for its update).
 */
function digestOf(pending: readonly PendingConfirmation[], request: GateRequest): string {
	return createHash("sha256").update(JSON.stringify({ pending, request })).digest("base64url");
}

/** A human sentence describing what is about to happen. */
function describe(pending: readonly PendingConfirmation[]): string {
	const lines = pending.map((p) => describePending(p));
	return `The policy asks for your confirmation before: ${lines.join("; ")}. Proceed?`;
}

/**
 * Thrown by the modern confirmation handler when the call must be answered
 * with an `input_required` result; the tool handler turns it into one.
 */
class ElicitationNeededError extends Error {
	public override readonly name: string = "ElicitationNeededError";
	public readonly result: InputRequiredResult;

	public constructor(result: InputRequiredResult) {
		super("confirmation needed");
		this.result = result;
	}
}

/** Asks the person (modern era): an `input_required` result whose sealed state names the question (`asked`). */
async function ask(
	pending: readonly PendingConfirmation[],
	asked: string,
	ctx: ServerContext,
): Promise<never> {
	const requestState = await STATE.mint({ asked }, ctx);
	const question = inputRequired.elicit({
		message: describe(pending),
		requestedSchema: ConfirmationSchema,
	});
	const result = inputRequired({ inputRequests: { [CONFIRM_KEY]: question }, requestState });
	throw new ElicitationNeededError(result);
}

/** Asks the person (legacy era) through `elicitation/create`; 428 when the client cannot be asked. */
async function askLegacy(
	pending: readonly PendingConfirmation[],
	ctx: ServerContext,
): Promise<Awaited<ReturnType<ServerContext["mcpReq"]["elicitInput"]>>> {
	try {
		// The push-style request is the right one for a 2025-era connection; the SDK marks it deprecated only for the modern path.
		// oxlint-disable-next-line typescript/no-deprecated
		return await ctx.mcpReq.elicitInput(
			{
				mode: "form",
				message: describe(pending),
				requestedSchema: {
					type: "object",
					properties: {
						confirm: { type: "boolean", title: "Confirm", description: "Confirm the action" },
					},
					required: ["confirm"],
				},
			},
			// A call the client cancels stops waiting, and so cannot run on a late yes.
			{ timeout: ANSWER_SECONDS * 1000, signal: ctx.mcpReq.signal },
		);
	} catch {
		// No elicitation capability, no answer in time, or the request failed: nobody can be asked.
		throw new ConfirmationRequiredError(pending);
	}
}

/** The answer of a retried modern call to the question `asked`: `undefined` when the person still has to be asked. */
function answerOf(asked: string, ctx: ServerContext): boolean | undefined {
	const state = ctx.mcpReq.requestState<ConfirmState>();
	const response = inputResponse(ctx.mcpReq.inputResponses, CONFIRM_KEY);
	if (typeof state !== "object" || state.asked !== asked || response.kind !== "elicit") {
		return undefined;
	}
	if (response.action !== "accept") {
		return false;
	}
	return (
		acceptedContent(ctx.mcpReq.inputResponses, CONFIRM_KEY, ConfirmationSchema)?.confirm === true
	);
}

/**
 * The confirmation handler for one tool call, which sends `request`.
 *
 * On a 2026-07-28 (modern) connection the first call answers with an
 * `input_required` result carrying a form elicitation and a sealed
 * `requestState`; the client asks the person and retries the same call with
 * the answer and the state, which this handler then reads (declining or
 * cancelling refuses the call; a call with other arguments is asked again).
 * On a 2025-era (legacy) connection the server sends `elicitation/create`
 * itself and waits for the answer; a client that cannot be asked gets the
 * gate's 428.
 */
function confirmHandlerFor(
	era: ProtocolEra,
	ctx: ServerContext,
	request: GateRequest,
): ConfirmHandler {
	return async (pending) => {
		if (era === "modern") {
			const asked = digestOf(pending, request);
			return answerOf(asked, ctx) ?? ask(pending, asked, ctx);
		}
		const result = await askLegacy(pending, ctx);
		return result.action === "accept" && result.content?.confirm === true;
	};
}

export { confirmHandlerFor, ElicitationNeededError, verifyConfirmState };
export type { ProtocolEra };
