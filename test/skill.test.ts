// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import renderSkillFiles from "../scripts/generate-skill.ts";

const SKILL_DIR = join(import.meta.dirname, "..", "skills", "asana-gate");

describe("agent skill", () => {
	it("is committed exactly as the generator renders it from the code and the README", async () => {
		const files = await renderSkillFiles();
		const paths = [...files.keys()];
		const committed = await Promise.all(
			paths.map((path) => readFile(join(SKILL_DIR, path), "utf8")),
		);
		expect(Object.fromEntries(paths.map((path, index) => [path, committed[index]]))).toStrictEqual(
			Object.fromEntries(files),
		);
	});
});
