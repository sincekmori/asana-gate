// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import type { CustomFieldDefinition, NameResolver } from "../../src/policy/compile.ts";
import { PolicyError } from "../../src/policy/types.ts";

/** The sandbox the tests describe: one workspace with two teams, three projects and a few tasks. */
const WORLD = {
	workspace: { gid: "1", name: "Acme" },
	me: { gid: "51", email: "me@acme.test", name: "Me" },
	teams: { Platform: "11", Design: "12" },
	projects: { Backend: "21", "Design System": "22", Secret: "23" },
	sections: { "21": { Backlog: "31", Done: "32" }, "22": { Inbox: "33" } } as Record<
		string,
		Record<string, string>
	>,
	tags: { "ai-ok": "41", frozen: "42" },
	users: { "me@acme.test": "51", "bob@acme.test": "52" },
	customFields: [
		{
			gid: "61",
			name: "Owner",
			enumOptions: [
				{ gid: "71", name: "AI" },
				{ gid: "72", name: "Human" },
			],
		},
	] as CustomFieldDefinition[],
};

function lookup(kind: string, table: Record<string, string>, ref: string): string {
	const gid = table[ref];
	if (gid === undefined) {
		throw new PolicyError(`${kind} "${ref}" was not found`);
	}
	return gid;
}

/** A resolver over {@link WORLD}; gids pass through, names are looked up. */
const fakeResolver: NameResolver = {
	workspace: (ref) =>
		Promise.resolve(
			ref === WORLD.workspace.gid || ref === WORLD.workspace.name
				? WORLD.workspace
				: Promise.reject(new PolicyError(`workspace "${ref}" was not found`)),
		),
	me: () => Promise.resolve(WORLD.me),
	team: (ref) => Promise.resolve(lookup("team", WORLD.teams, ref)),
	portfolio: (ref) => Promise.resolve(ref),
	project: (ref) => Promise.resolve(lookup("project", WORLD.projects, ref)),
	section: (ref, project) => Promise.resolve(lookup("section", WORLD.sections[project] ?? {}, ref)),
	tag: (ref) => Promise.resolve(lookup("tag", WORLD.tags, ref)),
	user: (ref) => Promise.resolve(ref === "me" ? WORLD.me.gid : lookup("user", WORLD.users, ref)),
	customField: (ref) => {
		const field = WORLD.customFields.find((f) => f.gid === ref || f.name === ref);
		return field === undefined
			? Promise.reject(new PolicyError(`custom field "${ref}" was not found`))
			: Promise.resolve(field);
	},
};

export { fakeResolver, WORLD };
