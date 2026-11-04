// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import type { CallToolResult } from "@modelcontextprotocol/server";

import { AsanaApiError } from "../asana/errors.ts";
import { GateError } from "../gate/errors.ts";
import type { GateResponse } from "../gate/gate.ts";
import { messageOf } from "../log.ts";

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

export { errorResult, jsonResult, toToolResult };
