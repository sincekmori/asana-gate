// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { GateRequest } from "../src/gate/gate.ts";
import { data, type Fake, items, setupGate } from "./helpers/gate.ts";

/** Everything is readable; a user's email is redacted, and in project 21 the text of stories and status updates. */
const REDACTING = `
version: 1
workspace: "1"
rules:
  - allow: [read]
    redact: { user: [email] }
  - where: { project: "21" }
    redact: { story: [text], status_update: [text] }
`;

/** Everything is readable but the stories and status updates of project 21. */
const HIDING = `
version: 1
workspace: "1"
rules:
  - allow: [read]
  - where: { project: "21" }
    deny: [story:read, status_update:read]
`;

/** Tasks of project 22 only: nothing at workspace level is readable. */
const TASKS_ONLY = `
version: 1
workspace: "1"
rules:
  - where: { project: "22" }
    allow: ["task:*"]
`;

/** Posts a status update with a text on project 21; its gid. */
function report(fake: Fake): string {
	const created = fake.api("POST", "/status_updates", {
		parent: "21",
		title: "Blocked",
		text: "the reason",
		status_type: "at_risk",
	});
	return String(data(created.body).gid);
}

/** Stores a notification about task 101 that names story 501, a comment on it. */
function notify(fake: Fake): void {
	fake.store.put({
		gid: "601",
		resource_type: "notification",
		is_read: false,
		user: { gid: "51", resource_type: "user" },
		workspace: { gid: "1", resource_type: "workspace" },
		story: { gid: "501", resource_type: "story" },
		work_objects: [{ gid: "101", resource_type: "task" }],
	});
}

/** The request for user 51's notifications, with `fields` (Asana's default ones without). */
const notifications = (fields?: string): GateRequest => ({
	method: "GET",
	path: "/users/51/notifications",
	query: { workspace: "1", opt_fields: fields },
});

describe("objects that live inside another", () => {
	it("redacts a project's status update where the project holds it, as the project's place says", async () => {
		const { fake, gate } = await setupGate(REDACTING);
		const gid = report(fake);
		const whole = await gate.execute({ method: "GET", path: "/projects/21" });
		expect(data(whole.body).current_status).toMatchObject({ gid, title: "Blocked" });
		expect(data(whole.body).current_status_update).toMatchObject({ gid, title: "Blocked" });
		const selected = await gate.execute({
			method: "GET",
			path: "/projects/21",
			query: { opt_fields: "current_status_update.title,current_status_update.text" },
		});
		expect(data(selected.body).current_status_update).toStrictEqual({ gid, title: "Blocked" });
		expect(JSON.stringify([whole.body, selected.body])).not.toContain("the reason");
	});

	it("removes a status update the policy hides from the project that holds it", async () => {
		const { fake, gate } = await setupGate(HIDING);
		report(fake);
		const response = await gate.execute({ method: "GET", path: "/projects/21" });
		expect(response.status).toBe(200);
		expect(data(response.body)).toMatchObject({
			current_status: null,
			current_status_update: null,
		});
	});

	it("redacts the story a notification names as the place of its task says", async () => {
		const { fake, gate } = await setupGate(REDACTING);
		notify(fake);
		const response = await gate.execute(notifications("story.text"));
		expect(items(response.body)).toStrictEqual([{ gid: "601", story: { gid: "501" } }]);
	});

	it("removes the story of a notification where the policy hides stories", async () => {
		const { fake, gate } = await setupGate(HIDING);
		notify(fake);
		const response = await gate.execute(notifications());
		expect(items(response.body)).toMatchObject([{ gid: "601", story: null }]);
	});

	it("loads a nested object to place it, unless the answer carries what it lives in", async () => {
		const { fake, gate } = await setupGate(REDACTING);
		const gid = report(fake);
		const loads = (): number =>
			fake.calls.filter((call) => call.url.pathname.endsWith(`/status_updates/${gid}`)).length;
		const read = (fields: string): ReturnType<typeof gate.execute> =>
			gate.execute({ method: "GET", path: "/projects/21", query: { opt_fields: fields } });
		await read("current_status_update.title,current_status_update.parent");
		const carried = loads();
		await read("current_status_update.title");
		expect([carried, loads()]).toStrictEqual([0, 1]);
	});
});

describe("objects at workspace level", () => {
	it("stay where a visible object names them, whatever the policy says about reading them", async () => {
		const { gate } = await setupGate(TASKS_ONLY);
		const response = await gate.execute({
			method: "GET",
			path: "/tasks/107",
			query: { opt_fields: "assignee.name,tags.name" },
		});
		expect(data(response.body)).toMatchObject({
			assignee: { gid: "51", name: "Me" },
			tags: [{ gid: "41", name: "ai-ok" }],
		});
	});

	it("lose the members the policy redacts", async () => {
		const { gate } = await setupGate(REDACTING);
		const response = await gate.execute({
			method: "GET",
			path: "/tasks/107",
			query: { opt_fields: "assignee.name,assignee.email" },
		});
		expect(data(response.body).assignee).toStrictEqual({ gid: "51", name: "Me" });
	});
});
