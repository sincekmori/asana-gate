// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import serverJson from "../scripts/generate-server.ts";

describe("registry entry of the MCP server", () => {
	it("is committed exactly as the generator renders it from package.json", async () => {
		const committed = await readFile(join(import.meta.dirname, "..", "server.json"), "utf8");
		expect(JSON.parse(committed)).toStrictEqual(serverJson());
	});

	it("keeps its description within the registry's 100 characters", () => {
		expect(serverJson().description.length).toBeLessThanOrEqual(100);
	});
});
