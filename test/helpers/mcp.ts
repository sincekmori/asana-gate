// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import { createAsanaGateServer } from "../../src/mcp/server.ts";
import { setupGate } from "./gate.ts";

const POLICY = `
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { project: "21" }
    allow: ["task:*", story:create]
  - where: { project: "21", section: Done }
    deny: [task:update, task:complete]
  - where: { project: "23" }
    deny: ["*"]
`;

/** A client connected in memory to a server over the fake Asana; `close` tears both down. */
export async function connectMcp(): Promise<{ client: Client; close: () => Promise<void> }> {
	const { gate } = await setupGate(POLICY);
	const server = createAsanaGateServer(gate, { version: "0.0.0-test" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "test", version: "0" });
	await client.connect(clientTransport);
	return {
		client,
		close: async () => {
			await client.close();
			await server.close();
		},
	};
}

/** The shape of a tool result as the tests read it. */
export type ToolResult = {
	isError?: boolean;
	structuredContent?: Record<string, unknown>;
	content: { type: string; text?: string }[];
};

/** Calls a tool and returns its result. */
export const callTool = async (
	client: Client,
	name: string,
	args: Record<string, unknown>,
): Promise<ToolResult> => (await client.callTool({ name, arguments: args })) as ToolResult;
