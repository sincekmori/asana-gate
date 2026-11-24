// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import type { CallToolResult } from "@modelcontextprotocol/server";

import { AsanaApiError } from "../asana/errors.ts";
import { GateError } from "../gate/errors.ts";
import type { GateResponse } from "../gate/gate.ts";
import { messageOf } from "../log.ts";
import { type EffectiveConstraints, writtenConstraints } from "../policy/effective.ts";
import type { Explanation } from "../policy/evaluate.ts";

/** How gate responses and errors become MCP tool results. */

/** A tool result carrying a JSON body: as text for the model, as structured content for clients. */
function jsonResult(body: Record<string, unknown>, isError = false): CallToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(body) }],
		structuredContent: body,
		...(isError && { isError: true }),
	};
}

function toToolResult(response: GateResponse): CallToolResult {
	const failed = response.status >= 400;
	return jsonResult(failed ? { status: response.status, ...response.body } : response.body, failed);
}

function errorResult(error: unknown): CallToolResult {
	if (error instanceof GateError || error instanceof AsanaApiError) {
		return toToolResult({ status: error.status, body: error.toBody() });
	}
	return { content: [{ type: "text", text: messageOf(error) }], isError: true };
}

/**
 * What `asana_allowed_actions` answers: the actions the policy allows and
 * denies on one object, and the constraints in force where it is.
 */
function explanationBody(
	gid: string,
	explanation: Explanation,
	effective: EffectiveConstraints,
): Record<string, unknown> {
	const constraints = writtenConstraints(effective);
	return {
		resource_type: explanation.resource,
		gid,
		allowed_actions: explanation.actions.filter((d) => d.allowed).map((d) => d.action),
		denied_actions: explanation.actions.filter((d) => !d.allowed).map((d) => d.action),
		...(constraints && { constraints }),
	};
}

export { errorResult, explanationBody, jsonResult, toToolResult };
