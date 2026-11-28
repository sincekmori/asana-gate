// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { AsanaClient } from "../src/asana/client.ts";
import { policyFor } from "../src/gate/identity.ts";
import { parsePolicy } from "../src/policy/load.ts";
import type { Policy } from "../src/policy/types.ts";
import { createFakeAsana } from "./helpers/fake-asana.ts";

/** The policy that governs `workspace` and allows reading, compiled for the fake Asana's token; the requests it took. */
async function compiled(workspace: string): Promise<{ policy: Policy; asked: string[] }> {
	const fake = createFakeAsana();
	const client = new AsanaClient({ token: "test-token", fetch: fake.fetch, maxRetries: 0 });
	const file = parsePolicy(`version: 1\nworkspace: "${workspace}"\nrules:\n  - allow: [read]\n`);
	const policy = await policyFor(client, [{ file, path: "policy.yaml", role: "project" }]);
	return {
		policy,
		asked: fake.calls.map((call) => `${call.method} ${call.url.pathname}`).toSorted(),
	};
}

describe("a policy compiled for a client", () => {
	it("asks Asana who the token belongs to and what the workspace is called, and nothing else", async () => {
		const { policy, asked } = await compiled("1");
		expect(policy.me).toStrictEqual({ gid: "51", email: "me@acme.test", name: "Me" });
		expect(policy.workspaceName).toBe("Acme");
		expect(asked).toStrictEqual(["GET /api/1.0/users/me", "GET /api/1.0/workspaces/1"]);
	});

	it("does not load for a workspace the token does not see", async () => {
		await expect(compiled("9")).rejects.toThrow(
			"workspace 9 was not found (deleted, or not visible to this token)",
		);
	});
});
