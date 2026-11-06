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
import { RESOURCES, type Resource } from "../catalog/resources.ts";
import type { Gate, GateRequest } from "../gate/gate.ts";
import { type Explanation, grantedActions } from "../policy/evaluate.ts";
import {
	confirmHandlerFor,
	ElicitationNeededError,
	type ProtocolEra,
	verifyConfirmState,
} from "./confirm.ts";
import { listOperations } from "./operations.ts";
import { errorResult, jsonResult, toToolResult } from "./results.ts";
import { type AnyToolSpec, BATCH_NOTE, TOOLS } from "./tools.ts";

/** Options for {@link createAsanaGateServer}. */
interface ServerOptions {
	/** The version advertised to clients. */
	version: string;
	/** The protocol era this instance serves; decides how confirmations are asked. */
	era?: ProtocolEra;
}

const INSTRUCTIONS = `asana-gate puts a policy in front of the Asana API. Everything you can see or do here is decided by that policy, not by Asana.

- Objects the policy hides do not exist for you: requests for them return the same "Not a recognized ID" 404 Asana returns for nonexistent gids, and lists never contain them.
- Every object in a response carries "allowed_actions": the <resource>:<verb> actions the policy currently allows on it (e.g. "task:update", "story:create"). Check it before writing; a refused action returns 403 with an asana-gate message.
- The policy may also shape requests: it can require members (a 400 names what is missing or wrong), fill in defaults and prefixes, hide members, cap how often an action runs (429), and ask the person for confirmation before an action (answer the elicitation).
- Use the curated asana_* tools for common work. asana_request reaches every Asana REST operation with the same policy; asana_operations lists them with the action each one needs; asana_allowed_actions tells what you may do with one object.
- Only the curated tools the policy could ever allow are listed; asana_request reaches every other operation the policy permits. ${BATCH_NOTE}
- Results are pages: pass next_page.offset back as offset to continue.`;

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

function explanationBody(
	type: Resource,
	gid: string,
	explanation: Explanation,
): Record<string, unknown> {
	return {
		resource_type: type,
		gid,
		allowed_actions: explanation.actions.filter((d) => d.allowed).map((d) => d.action),
		denied_actions: explanation.actions.filter((d) => !d.allowed).map((d) => d.action),
	};
}

const METHODS = ["GET", "POST", "PUT", "DELETE"] as const;
const QueryValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);
const QuerySchema = z.record(z.string(), QueryValueSchema);
const BodySchema = z.record(z.string(), z.unknown());

/** The curated tools the policy could ever allow: those needing an action some rule allows somewhere. */
function exposedTools(policy: Gate["policy"]): AnyToolSpec[] {
	const allowed = grantedActions(policy);
	return TOOLS.filter((spec) => spec.needs.some((action) => allowed.has(action)));
}

/** Builds the MCP server exposing the gate: the curated tools the policy could allow, plus the generic ones. */
function createAsanaGateServer(gate: Gate, options: ServerOptions): McpServer {
	const era: ProtocolEra = options.era ?? "modern";
	const server = new McpServer(
		{ name: "asana-gate", version: options.version, title: "Asana (policy-gated)" },
		{
			capabilities: { tools: {} },
			instructions: INSTRUCTIONS,
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
