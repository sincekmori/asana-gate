// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { describe, expect, it } from "vitest";

const ENTRY = join(import.meta.dirname, "helpers", "cli-entry.ts");

const POLICY = `
version: 1
workspace: "1"
rules:
  - allow: [read]
`;

const INITIALIZE = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "test", version: "0" },
	},
};

describe("mcp over stdio", () => {
	it("exits 0 when the client closes stdin", async () => {
		const root = await mkdtemp(join(tmpdir(), "asana-gate-stdio-"));
		const project = join(root, "repo");
		await mkdir(join(project, ".asana-gate"), { recursive: true });
		await writeFile(join(project, ".asana-gate", "policy.yaml"), POLICY);
		const child = spawn(process.execPath, [ENTRY, "mcp"], {
			cwd: project,
			env: { ASANA_ACCESS_TOKEN: "test-token", ASANA_GATE_HOME: join(root, "home") },
		});
		let stderr = "";
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		const exited = once(child, "exit");
		child.stdin.write(`${JSON.stringify(INITIALIZE)}\n`);
		const [reply] = (await once(createInterface({ input: child.stdout }), "line")) as [string];
		expect(JSON.parse(reply)).toMatchObject({ id: 1, result: {} });
		child.stdin.end();
		const [code] = (await exited) as [number | null];
		expect({ code, stderr }).toMatchObject({ code: 0 });
	});
});
