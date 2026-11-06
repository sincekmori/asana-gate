// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import {
	DEFAULT_REQUEST_TIMEOUT_MSEC,
	type InputRequiredResult,
	type RequestOptions,
	type ServerContext,
} from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import type { PendingConfirmation } from "../src/gate/errors.ts";
import type { ConfirmHandler, GateRequest } from "../src/gate/gate.ts";
import {
	confirmHandlerFor,
	ElicitationNeededError,
	type ProtocolEra,
	verifyConfirmState,
} from "../src/mcp/confirm.ts";

/** The request the confirmations are asked for. */
const CALL: GateRequest = { method: "DELETE", path: "/tasks/101" };

/** The confirmation handler of a call sending `request` (by default {@link CALL}). */
const handlerFor = (
	era: ProtocolEra,
	ctx: ServerContext,
	request: GateRequest = CALL,
): ConfirmHandler => confirmHandlerFor(era, ctx, request);

const PENDING: PendingConfirmation[] = [
	{ action: "task:delete", type: "task", gid: "101", name: "T1", ruleIndex: 1 },
];

const contextWith = (mcpReq: Record<string, unknown>): ServerContext =>
	({ mcpReq }) as unknown as ServerContext;

/** A first call: no answer, no state. */
const ASKED = { method: "tools/call", requestState: (): undefined => undefined };

/** The input_required result a handler answers with. */
async function resultOf(handler: ConfirmHandler): Promise<InputRequiredResult> {
	try {
		await handler(PENDING);
	} catch (error) {
		return (error as ElicitationNeededError).result;
	}
	throw new Error("expected an elicitation");
}

/** The sealed state of the question a handler asked, as the server's verify hook decodes it. */
async function stateOf(handler: ConfirmHandler): Promise<unknown> {
	const { requestState } = await resultOf(handler);
	return verifyConfirmState(requestState ?? "", contextWith(ASKED));
}

/** A retried call carrying `state` and the person's `answer`. */
const retry = (state: unknown, answer: Record<string, unknown>): Promise<boolean> =>
	handlerFor(
		"modern",
		contextWith({ ...ASKED, requestState: () => state, inputResponses: { confirm: answer } }),
	)(PENDING);

/**
 * A legacy `elicitInput` whose person accepts after `ms`; like the SDK's
 * request, it fails instead when its timeout runs out first.
 */
const acceptingAfter =
	(ms: number) =>
	(
		_params: unknown,
		options?: RequestOptions,
	): Promise<{ action: string; content?: { confirm: boolean } }> =>
		(options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC) < ms
			? Promise.reject(new Error("Request timed out"))
			: Promise.resolve({ action: "accept", content: { confirm: true } });

describe("mcp confirmations", () => {
	it("answers a modern call with an input_required elicitation until the person confirms", async () => {
		const first = handlerFor("modern", contextWith(ASKED));
		await expect(first(PENDING)).rejects.toBeInstanceOf(ElicitationNeededError);
		const state = await stateOf(first);
		expect(JSON.stringify(await resultOf(first))).toContain("task:delete on task 101");
		await expect(retry(state, { action: "accept", content: { confirm: true } })).resolves.toBe(
			true,
		);
		await expect(retry(state, { action: "accept", content: { confirm: false } })).resolves.toBe(
			false,
		);
	});

	it("refuses a modern call the person declined or cancelled, instead of asking again", async () => {
		const state = await stateOf(handlerFor("modern", contextWith(ASKED)));
		await expect(retry(state, { action: "decline" })).resolves.toBe(false);
		await expect(retry(state, { action: "cancel" })).resolves.toBe(false);
	});

	it("asks again when an answer comes without the question this server sealed", async () => {
		const forged = handlerFor(
			"modern",
			contextWith({
				...ASKED,
				inputResponses: { confirm: { action: "accept", content: { confirm: true } } },
			}),
		);
		await expect(forged(PENDING)).rejects.toBeInstanceOf(ElicitationNeededError);
		const state = await stateOf(handlerFor("modern", contextWith(ASKED)));
		const other = PENDING.map((pending) => ({ ...pending, gid: "105" }));
		const replayed = handlerFor(
			"modern",
			contextWith({
				...ASKED,
				requestState: () => state,
				inputResponses: { confirm: { action: "accept", content: { confirm: true } } },
			}),
		);
		await expect(replayed(other)).rejects.toBeInstanceOf(ElicitationNeededError);
	});

	it("asks again when an answer comes back for the same action with other arguments", async () => {
		const update: GateRequest = { method: "PUT", path: "/tasks/101", body: { name: "approved" } };
		const state = await stateOf(handlerFor("modern", contextWith(ASKED), update));
		const answered = (request: GateRequest): ConfirmHandler =>
			handlerFor(
				"modern",
				contextWith({
					...ASKED,
					requestState: () => state,
					inputResponses: { confirm: { action: "accept", content: { confirm: true } } },
				}),
				request,
			);
		await expect(answered(update)(PENDING)).resolves.toBe(true);
		await expect(
			answered({ ...update, body: { name: "something else" } })(PENDING),
		).rejects.toBeInstanceOf(ElicitationNeededError);
	});

	it("asks a legacy client through elicitation/create", async () => {
		const asked: unknown[] = [];
		const elicitInput = (
			params: unknown,
		): Promise<{ action: string; content?: { confirm: boolean } }> => {
			asked.push(params);
			return Promise.resolve({ action: "accept", content: { confirm: true } });
		};
		const handler = handlerFor("legacy", contextWith({ elicitInput }));
		await expect(handler(PENDING)).resolves.toBe(true);
		expect(asked[0]).toMatchObject({ mode: "form" });
		expect(JSON.stringify(asked[0])).toContain("task:delete");
		const cancelled = handlerFor(
			"legacy",
			contextWith({ elicitInput: () => Promise.resolve({ action: "cancel" }) }),
		);
		await expect(cancelled(PENDING)).resolves.toBe(false);
	});

	it("waits minutes, not the SDK's default minute, for a legacy person to answer", async () => {
		const slow = handlerFor("legacy", contextWith({ elicitInput: acceptingAfter(5 * 60_000) }));
		await expect(slow(PENDING)).resolves.toBe(true);
	});

	it("refuses with the gate's 428 when a legacy client cannot be asked", async () => {
		const unable = handlerFor(
			"legacy",
			contextWith({ elicitInput: () => Promise.reject(new Error("no elicitation")) }),
		);
		await expect(unable(PENDING)).rejects.toMatchObject({ status: 428 });
	});
});
