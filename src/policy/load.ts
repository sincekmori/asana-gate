// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";

import { messageOf } from "../log.ts";
import { parseYaml, validated } from "../yaml.ts";
import { type PolicyFile, PolicyFileSchema } from "./schema.ts";
import { PolicyError } from "./types.ts";

const fail = (message: string): Error => new PolicyError(message);

/** Parses and validates policy YAML text. */
function parsePolicy(text: string, source = "policy"): PolicyFile {
	return validated(PolicyFileSchema, parseYaml(text, source, fail), { source, fail });
}

/** Reads, parses and validates a policy file. */
async function loadPolicyFile(path: string): Promise<PolicyFile> {
	const text = await readFile(path, "utf8").catch((error: unknown) => {
		throw new PolicyError(`cannot read policy file ${path}: ${messageOf(error)}`);
	});
	return parsePolicy(text, path);
}

export { loadPolicyFile, parsePolicy };
