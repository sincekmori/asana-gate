// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import {
	type CallToolResult,
	type InputRequiredResult,
	McpServer,
	type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod";

import { renderQuery } from "../asana/query.ts";
import { RESOURCES } from "../catalog/resources.ts";
import type { Gate, GateRequest } from "../gate/gate.ts";
import {
	confirmHandlerFor,
	ElicitationNeededError,
	type ProtocolEra,
	verifyConfirmState,
} from "./confirm.ts";
import { instructionsFor } from "./instructions.ts";
import { listOperations } from "./operations.ts";
import { errorResult, explanationBody, jsonResult, toToolResult } from "./results.ts";
import { BATCH_NOTE, exposedTools } from "./tools.ts";

/** Options for {@link createAsanaGateServer}. */
interface ServerOptions {
	/** The version advertised to clients. */
	version: string;
	/** The protocol era this instance serves; decides how confirmations are asked. */
	era?: ProtocolEra;
}

/** What a gated tool call needs besides its request. */
interface ToolCall {
	readonly gate: Gate;
	readonly ctx: ServerContext;
	readonly era: ProtocolEra;
}

/** Runs a gated request for a tool call, asking the person for confirmation when the policy requires it. */
async function gated(
	call: ToolCall,
	request: GateRequest,
): Promise<CallToolResult | InputRequiredResult> {
	try {
		return toToolResult(
			await call.gate.execute(request, {
				confirm: confirmHandlerFor(call.era, call.ctx, request),
			}),
		);
	} catch (error) {
		if (error instanceof ElicitationNeededError) {
			return error.result;
		}
		return errorResult(error);
	}
}

const METHODS = ["GET", "POST", "PUT", "DELETE"] as const;
const QueryValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);
const QuerySchema = z.record(z.string(), QueryValueSchema);
const BodySchema = z.record(z.string(), z.unknown());

/** Builds the MCP server exposing the gate: the curated tools the policy could allow, plus the generic ones. */
function createAsanaGateServer(gate: Gate, options: ServerOptions): McpServer {
	const era: ProtocolEra = options.era ?? "modern";
	const server = new McpServer(
		{ name: "asana-gate", version: options.version, title: "Asana (policy-gated)" },
		{
			capabilities: { tools: {} },
			instructions: instructionsFor(gate.policy),
			// Confirmation answers count only for the question this server asked.
			requestState: { verify: verifyConfirmState },
		},
	);
	for (const spec of exposedTools(gate.policy)) {
		server.registerTool(
			spec.name,
			{
				title: spec.title,
				description: spec.description,
				inputSchema: spec.input,
				annotations: {
					readOnlyHint: spec.readOnly === true,
					destructiveHint: spec.destructive === true,
					idempotentHint: spec.idempotent === true || spec.readOnly === true,
					openWorldHint: true,
				},
			},
			(args, ctx) => gated({ gate, ctx, era }, spec.request(args, gate.policy)),
		);
	}
	server.registerTool(
		"asana_request",
		{
			title: "Asana REST request",
			description: `Calls any Asana REST API operation (https://developers.asana.com/reference) through the policy. Give the path below /api/1.0, e.g. /projects/123/sections. For POST and PUT, body is the \`data\` object. ${BATCH_NOTE}`,
			inputSchema: z.object({
				method: z.enum(METHODS),
				path: z.string().describe("Path such as /tasks/123 or /workspaces/456/tasks/search"),
				query: QuerySchema.optional(),
				body: BodySchema.optional().describe("The request's data object"),
			}),
			annotations: { openWorldHint: true },
		},
		(args, ctx) =>
			gated(
				{ gate, ctx, era },
				{ method: args.method, path: args.path, query: renderQuery(args.query), body: args.body },
			),
	);
	server.registerTool(
		"asana_operations",
		{
			title: "List Asana operations",
			description:
				"Lists the Asana REST operations asana_request can call, with the policy action each one needs. Filter by a search term (matched against the path, id and group) or by resource.",
			inputSchema: z.object({
				search: z.string().optional(),
				resource: z.enum(RESOURCES).optional(),
				limit: z.number().int().min(1).max(300).optional(),
			}),
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		(args) => jsonResult(listOperations(args)),
	);
	server.registerTool(
		"asana_allowed_actions",
		{
			title: "Allowed actions on an object",
			description:
				"Tells which actions the policy allows on one object; 404 when the object is not visible to you.",
			inputSchema: z.object({ resource_type: z.enum(RESOURCES), gid: z.string() }),
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async (args) => {
			try {
				const { explanation } = await gate.explain(args.resource_type, args.gid);
				return jsonResult(explanationBody(args.resource_type, args.gid, explanation));
			} catch (error) {
				return errorResult(error);
			}
		},
	);
	return server;
}

export { createAsanaGateServer };
export type { ServerOptions };
