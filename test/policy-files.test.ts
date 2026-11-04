// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { policyCandidates, policyFiles } from "../src/settings/policy-files.ts";

/** A home and a managed directory holding a policy file each, and a project path. */
async function scaffold(): Promise<{ home: string; managedDir: string; projectDir: string }> {
	const root = await mkdtemp(join(tmpdir(), "asana-gate-policy-files-"));
	const home = join(root, "home");
	const managedDir = join(root, "managed");
	await Promise.all([mkdir(home, { recursive: true }), mkdir(managedDir, { recursive: true })]);
	await Promise.all([
		writeFile(join(home, "policy.yaml"), "version: 1\nrules: []\n"),
		writeFile(join(managedDir, "managed-policy.yaml"), "version: 1\nrules: []\n"),
	]);
	return { home, managedDir, projectDir: join(root, "repo") };
}

describe("policy files", () => {
	it("looks for the project's policy in the project, the working directory, the home and the managed place", async () => {
		const place = await scaffold();
		expect(policyCandidates(place, place.projectDir)).toStrictEqual([
			join(place.projectDir, ".asana-gate", "policy.yaml"),
			join(place.projectDir, "asana-gate.yaml"),
			join(place.home, "policy.yaml"),
			join(place.managedDir, "managed-policy.yaml"),
		]);
	});

	it("adds the user's and the administrator's files as restrictions, never twice", async () => {
		const place = await scaffold();
		const project = join(place.projectDir, ".asana-gate", "policy.yaml");
		await expect(policyFiles(place, project)).resolves.toStrictEqual([
			{ path: project, role: "project" },
			{ path: join(place.home, "policy.yaml"), role: "user" },
			{ path: join(place.managedDir, "managed-policy.yaml"), role: "managed" },
		]);
		await expect(policyFiles(place, join(place.home, "policy.yaml"))).resolves.toStrictEqual([
			{ path: join(place.home, "policy.yaml"), role: "user" },
			{ path: join(place.managedDir, "managed-policy.yaml"), role: "managed" },
		]);
	});
});
