// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import type { InputRequiredResult, ServerContext } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import type { PendingConfirmation } from "../src/gate/errors.ts";
import type { ConfirmHandler } from "../src/gate/gate.ts";
import {
	confirmHandlerFor,
	ElicitationNeededError,
	verifyConfirmState,
} from "../src/mcp/confirm.ts";

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
	confirmHandlerFor(
		"modern",
		contextWith({ ...ASKED, requestState: () => state, inputResponses: { confirm: answer } }),
	)(PENDING);

describe("mcp confirmations", () => {
	it("answers a modern call with an input_required elicitation until the person confirms", async () => {
		const first = confirmHandlerFor("modern", contextWith(ASKED));
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
		const state = await stateOf(confirmHandlerFor("modern", contextWith(ASKED)));
		await expect(retry(state, { action: "decline" })).resolves.toBe(false);
		await expect(retry(state, { action: "cancel" })).resolves.toBe(false);
	});

	it("asks again when an answer comes without the question this server sealed", async () => {
		const forged = confirmHandlerFor(
			"modern",
			contextWith({
				...ASKED,
				inputResponses: { confirm: { action: "accept", content: { confirm: true } } },
			}),
		);
		await expect(forged(PENDING)).rejects.toBeInstanceOf(ElicitationNeededError);
		const state = await stateOf(confirmHandlerFor("modern", contextWith(ASKED)));
		const other = PENDING.map((pending) => ({ ...pending, gid: "105" }));
		const replayed = confirmHandlerFor(
			"modern",
			contextWith({
				...ASKED,
				requestState: () => state,
				inputResponses: { confirm: { action: "accept", content: { confirm: true } } },
			}),
		);
		await expect(replayed(other)).rejects.toBeInstanceOf(ElicitationNeededError);
	});

	it("asks a legacy client through elicitation/create", async () => {
		const asked: unknown[] = [];
		const elicitInput = (
			params: unknown,
		): Promise<{ action: string; content?: { confirm: boolean } }> => {
			asked.push(params);
			return Promise.resolve({ action: "accept", content: { confirm: true } });
		};
		const handler = confirmHandlerFor("legacy", contextWith({ elicitInput }));
		await expect(handler(PENDING)).resolves.toBe(true);
		expect(asked[0]).toMatchObject({ mode: "form" });
		expect(JSON.stringify(asked[0])).toContain("task:delete");
		const cancelled = confirmHandlerFor(
			"legacy",
			contextWith({ elicitInput: () => Promise.resolve({ action: "cancel" }) }),
		);
		await expect(cancelled(PENDING)).resolves.toBe(false);
	});

	it("refuses with the gate's 428 when a legacy client cannot be asked", async () => {
		const unable = confirmHandlerFor(
			"legacy",
			contextWith({ elicitInput: () => Promise.reject(new Error("no elicitation")) }),
		);
		await expect(unable(PENDING)).rejects.toMatchObject({ status: 428 });
	});
});
