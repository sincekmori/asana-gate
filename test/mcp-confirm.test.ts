// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import { createAsanaGateServer } from "../src/mcp/server.ts";
import { type Fake, setupGate } from "./helpers/gate.ts";
import type { ToolResult } from "./helpers/mcp.ts";

const POLICY = `
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { project: "21" }
    allow: ["task:*"]
    confirm: [task:delete]
`;

/** What the person answers. */
interface Answer {
	readonly action: "accept" | "decline" | "cancel";
	readonly content?: { readonly confirm: boolean };
}

interface Connected {
	readonly client: Client;
	readonly fake: Fake;
	readonly asked: () => number;
	readonly close: () => Promise<void>;
}

/** A client whose person answers every confirmation with `answer`. */
async function connect(answer: Answer): Promise<Connected> {
	const { fake, gate } = await setupGate(POLICY);
	const server = createAsanaGateServer(gate, { version: "0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client(
		{ name: "test", version: "0" },
		{ capabilities: { elicitation: { form: {} } } },
	);
	let asked = 0;
	client.setRequestHandler("elicitation/create", () => {
		asked += 1;
		return Promise.resolve({ ...answer });
	});
	await client.connect(clientTransport);
	return {
		client,
		fake,
		asked: () => asked,
		close: async () => {
			await client.close();
			await server.close();
		},
	};
}

const deletes = (fake: Fake): number =>
	fake.calls.filter((call) => call.method === "DELETE").length;

const deleteTask = (client: Client): Promise<ToolResult> =>
	client.callTool({
		name: "asana_delete_task",
		arguments: { task_gid: "101" },
	}) as Promise<ToolResult>;

describe("confirmations over MCP", () => {
	it("runs the action once the person accepts", async () => {
		const { asked, client, close, fake } = await connect({
			action: "accept",
			content: { confirm: true },
		});
		const result = await deleteTask(client);
		expect([result.isError, asked(), deletes(fake)]).toStrictEqual([undefined, 1, 1]);
		await close();
	});

	it("refuses with a 403 after one prompt when the person declines", async () => {
		const { asked, client, close, fake } = await connect({ action: "decline" });
		const result = await deleteTask(client);
		expect(result.structuredContent?.status).toBe(403);
		expect([asked(), deletes(fake)]).toStrictEqual([1, 0]);
		await close();
	});

	it("asks the person even when the first call already carries an answer", async () => {
		const { asked, client, close, fake } = await connect({ action: "decline" });
		const forged = { confirm: { action: "accept", content: { confirm: true } } };
		await client.request({
			method: "tools/call",
			params: { name: "asana_delete_task", arguments: { task_gid: "101" }, inputResponses: forged },
		});
		expect([asked(), deletes(fake)]).toStrictEqual([1, 0]);
		await close();
	});
});
