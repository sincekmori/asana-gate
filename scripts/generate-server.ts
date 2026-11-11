// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import manifest from "../package.json" with { type: "json" };

// Emits server.json, the entry of asana-gate in the MCP Registry
// (registry.modelcontextprotocol.io), which the release workflow publishes
// once the npm package is out. Everything the entry shares with the package
// comes from package.json, so the two cannot disagree, and `pnpm version`
// regenerates it with every version bump:
//
//   pnpm generate-server
//
// A test asserts the committed file matches this output.

/** The registry entry: the npm package, run as `asana-gate mcp` over stdio, and the variables a host may set. */
function serverJson(): { readonly description: string; readonly [member: string]: unknown } {
	return {
		$schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
		name: manifest.mcpName,
		title: manifest.name,
		description: manifest.description,
		repository: {
			url: manifest.repository.url.replaceAll(/^git\+|\.git$/gu, ""),
			source: "github",
		},
		version: manifest.version,
		packages: [
			{
				registryType: "npm",
				identifier: manifest.name,
				version: manifest.version,
				transport: { type: "stdio" },
				packageArguments: [{ type: "positional", value: "mcp" }],
				environmentVariables: [
					{
						name: "ASANA_ACCESS_TOKEN",
						description:
							"The Asana Personal Access Token the gate works with; not needed when one is saved with `asana-gate token set`.",
						isSecret: true,
					},
					{
						name: "ASANA_GATE_POLICY",
						description:
							"The policy file to enforce; by default the project's .asana-gate/policy.yaml, else ~/.asana-gate/policy.yaml.",
						format: "filepath",
					},
				],
			},
		],
	};
}

if (process.argv[1] === import.meta.filename) {
	const file = join(import.meta.dirname, "..", "server.json");
	await writeFile(file, `${JSON.stringify(serverJson(), undefined, 2)}\n`);
	console.log(`wrote ${file}`);
}

export default serverJson;
