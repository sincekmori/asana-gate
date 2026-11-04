// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";

import { isFile } from "../system.ts";
import { MANAGED_POLICY_FILE, POLICY_FILE, PROJECT_DIR } from "./paths.ts";

/** Where policy files are looked for. */
interface PolicyPlace {
	readonly home: string;
	readonly managedDir: string;
	readonly projectDir?: string | undefined;
}

/** A policy file in force and what it may do. */
interface PolicyPath {
	readonly path: string;
	readonly role: "project" | "user" | "managed";
}

/** Where the policy file is looked for when no settings layer names one, in order. */
function policyCandidates(place: PolicyPlace, cwd: string): string[] {
	return [
		...(place.projectDir === undefined ? [] : [join(place.projectDir, PROJECT_DIR, POLICY_FILE)]),
		join(cwd, "asana-gate.yaml"),
		join(place.home, POLICY_FILE),
		join(place.managedDir, MANAGED_POLICY_FILE),
	];
}

/**
 * The policy files in force: the one the settings name (`first`), the
 * project's, first; then the user's own `~/.asana-gate/policy.yaml` and the
 * administrator's `managed-policy.yaml` when they exist and are not that
 * one, which bound it.
 */
async function policyFiles(place: PolicyPlace, first: string): Promise<PolicyPath[]> {
	const bounds: PolicyPath[] = [
		{ path: join(place.home, POLICY_FILE), role: "user" },
		{ path: join(place.managedDir, MANAGED_POLICY_FILE), role: "managed" },
	];
	const present = await Promise.all(
		bounds.map(async (bound) =>
			bound.path !== first && (await isFile(bound.path)) ? bound : undefined,
		),
	);
	const role = bounds.find((bound) => bound.path === first)?.role ?? "project";
	return [{ path: first, role }, ...present.filter((bound) => bound !== undefined)];
}

export { policyCandidates, policyFiles };
export type { PolicyPath };
