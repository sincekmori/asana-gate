// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { auditEnvironment, auditReferences } from "../src/cli/audit.ts";
import { main } from "../src/cli/main.ts";
import type { FactsLoader } from "../src/gate/facts.ts";
import { compilePolicy } from "../src/policy/compile.ts";
import { parsePolicy } from "../src/policy/load.ts";
import { fakeResolver } from "./helpers/fake-resolver.ts";

const POLICY = `
version: 1
workspace: "1"
rules:
  - where: { project: "21" }
    allow: [read]
`;

/** The findings of the environment audit over a log file and a token file in `dir`. */
async function environmentFindings(dir: string): Promise<string[]> {
	const context = {
		loaded: { settings: { cache: { dir } } },
		log: { file: join(dir, "asana-gate.log") },
		token: { token: "t", source: "file", file: join(dir, "token"), mode: 0o644 },
	} as unknown as Parameters<typeof auditEnvironment>[0];
	const findings = await auditEnvironment(context);
	return findings.map((finding) => finding.text);
}

describe("check and exit codes", () => {
	it("exits 2 when the arguments cannot be parsed", async () => {
		const quiet = vi.spyOn(console, "error").mockReturnValue();
		await expect(main(["check", "--no-such-flag"], "0")).resolves.toBe(2);
		await expect(main(["init", "stray"], "0")).resolves.toBe(2);
		expect(quiet.mock.calls.flat().join("\n")).toMatch(/no-such-flag/u);
		quiet.mockRestore();
	});

	it.skipIf(process.platform === "win32")(
		"warns about a log file other users can read, as about a token file",
		async () => {
			const dir = await mkdtemp(join(tmpdir(), "asana-gate-audit-"));
			const log = join(dir, "asana-gate.log");
			await writeFile(log, "");
			await chmod(log, 0o644);
			const token = `token: ${join(dir, "token")} is readable by other users (mode 644); run chmod 600 on it`;
			await expect(environmentFindings(dir)).resolves.toStrictEqual([
				`log: ${log} is readable by other users (mode 644); run chmod 600 on it`,
				token,
			]);
			await chmod(log, 0o600);
			await expect(environmentFindings(dir)).resolves.toStrictEqual([token]);
		},
	);

	it("reports an object it could not load as a problem rather than failing", async () => {
		const policy = await compilePolicy(parsePolicy(POLICY), fakeResolver);
		const loader = {
			load: () => Promise.reject(new Error("Asana answered 503")),
		} as unknown as FactsLoader;
		await expect(auditReferences(policy, loader)).resolves.toStrictEqual({
			checked: 1,
			findings: [
				{
					level: "problem",
					text: "rules[0].where.project 21: could not be checked (Asana answered 503)",
				},
			],
		});
	});
});
