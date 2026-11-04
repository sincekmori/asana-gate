// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { compilePolicy } from "../../src/policy/compile.ts";
import { EMPTY, type Facts } from "../../src/policy/evaluate.ts";
import { parsePolicy } from "../../src/policy/load.ts";
import type { Policy } from "../../src/policy/types.ts";
import { fakeResolver } from "./fake-resolver.ts";

/** The policy of the design document, written against {@link WORLD}. */
export const EXAMPLE = `
version: 1
workspace: "Acme"
rules:
  - allow: [read]
  - where: { team: "Platform" }
    allow: [write]
  - where: { project: "21" }
    allow: ["task:*", story:create]
  - where: { project: "21", section: "Done" }
    deny: [task:update, task:delete]
  - where: { tag: "ai-ok" }
    allow: [task:update]
  - where: { project: "Design System" }
    allow: [read]
    fields: { task: [completed, assignee, due_on] }
  - where: { project: "Secret" }
    deny: ["*"]
  - where: { assignee: me, custom_field: { Owner: AI } }
    allow: [task:complete]
  - where: { unhomed: true }
    allow: [task:create]
  - where: { subtree: "900" }
    allow: [story:update]
`;

/** Facts of a task living in `project` (team 11, or 12 for the Secret project), optionally in `section`. */
export function taskIn(project: string, section?: string, extra: Partial<Facts> = {}): Facts {
	const team = project === "23" ? "12" : "11";
	return {
		workspace: "1",
		branches: [
			{
				team,
				portfolios: EMPTY,
				project,
				...(section !== undefined && { section }),
				taskChain: ["x"],
				unhomed: false,
			},
		],
		tags: EMPTY,
		assignee: null,
		...extra,
	};
}

/** Facts of a task in `project` carrying one tag. */
export const tagged = (project: string, tag: string): Facts =>
	taskIn(project, undefined, { tags: new Set([tag]) });

/** The example policy, compiled once. */
export const examplePolicy: Promise<Policy> = compilePolicy(parsePolicy(EXAMPLE), fakeResolver);
