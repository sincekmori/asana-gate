// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { AsanaClient } from "../src/asana/client.ts";
import { FactsLoader } from "../src/gate/facts.ts";
import { PortfolioIndex } from "../src/gate/portfolio-index.ts";
import { AsanaNameResolver } from "../src/gate/resolver.ts";
import { compilePolicy } from "../src/policy/compile.ts";
import { parsePolicy } from "../src/policy/load.ts";
import { createFakeAsana } from "./helpers/fake-asana.ts";
import { fakeResolver } from "./helpers/fake-resolver.ts";
import { data, setupGate } from "./helpers/gate.ts";

type Route = (url: URL) => Response | Promise<Response>;

const json = (status: number, body: unknown): Response => Response.json(body, { status });

const urlOf = (input: string | URL | Request): URL =>
	new URL(input instanceof Request ? input.url : input);

/** A client whose fetch answers by path; every request is counted per path. */
function routed(routes: Record<string, Route>): { client: AsanaClient; calls: string[] } {
	const calls: string[] = [];
	const fetch: typeof globalThis.fetch = (input) => {
		const url = urlOf(input);
		const path = url.pathname.replace(/^\/api\/1\.0/u, "");
		calls.push(path);
		const route = routes[path];
		return Promise.resolve(
			route === undefined ? json(404, { errors: [{ message: "Not found" }] }) : route(url),
		);
	};
	return { client: new AsanaClient({ token: "t", fetch, maxRetries: 0 }), calls };
}

/** A fetch that answers with `first` once, after `gate` opens, and with `later` from then on. */
function onceAfter(gate: Promise<boolean>, first: Route, later: Route): Route {
	let used = false;
	return async (url) => {
		const answer = used ? later : first;
		const wait = used ? Promise.resolve(true) : gate;
		used = true;
		await wait;
		return answer(url);
	};
}

/** Wraps a fetch so the first request whose path ends with `path` answers only after `gate` opens. */
function holdingFirst(
	fetch: typeof globalThis.fetch,
	path: string,
	gate: Promise<boolean>,
): typeof globalThis.fetch {
	let held = false;
	return async (input, init) => {
		const hold = !held && urlOf(input).pathname.endsWith(path);
		held ||= hold;
		const answer = await fetch(input, init);
		await (hold ? gate : Promise.resolve(true));
		return answer;
	};
}

const items = (...gids: string[]): Response =>
	json(200, { data: gids.map((gid) => ({ gid, resource_type: "project" })) });

/** Everything, except reading the tasks of the Design team's (12) projects. */
const DESIGN_HIDDEN = `
version: 1
workspace: "1"
rules:
  - allow: ["*"]
  - where: { team: Design }
    deny: [task:read]
`;

describe("a project write", () => {
	it("refreshes the facts its tasks took from it (the team their memberships carry)", async () => {
		const { gate } = await setupGate(DESIGN_HIDDEN);
		const stories = { method: "GET", path: "/tasks/101/stories" } as const;
		await expect(gate.execute(stories)).resolves.toMatchObject({ status: 200 });
		const moved = await gate.execute({
			method: "PUT",
			path: "/projects/21",
			body: { data: { team: "12" } },
		});
		expect(moved.status).toBe(200);
		await expect(gate.execute(stories)).resolves.toMatchObject({ status: 404 });
	});
});

describe("portfolio index", () => {
	it("fails the lookup instead of emptying a portfolio Asana would not list", async () => {
		const limited = routed({ "/portfolios/91/items": () => json(429, { errors: [] }) });
		const index = new PortfolioIndex({
			client: limited.client,
			roots: new Set(["91"]),
			ttlMs: 60_000,
		});
		await expect(index.containing("21")).rejects.toMatchObject({ status: 429 });
		const missing = routed({ "/portfolios/91/items": () => json(404, { errors: [] }) });
		const empty = new PortfolioIndex({
			client: missing.client,
			roots: new Set(["91"]),
			ttlMs: 60_000,
		});
		await expect(empty.containing("21")).resolves.toStrictEqual(new Set());
	});

	it("lists again when the portfolio changes while it is being listed", async () => {
		const held = Promise.withResolvers<boolean>();
		const { client } = routed({
			"/portfolios/91/items": onceAfter(
				held.promise,
				() => items("500"),
				() => items("500", "600"),
			),
		});
		const index = new PortfolioIndex({ client, roots: new Set(["91"]), ttlMs: 60_000 });
		const lookup = index.containing("600");
		index.invalidateFor("91");
		held.resolve(true);
		await expect(lookup).resolves.toStrictEqual(new Set(["91"]));
	});
});

const POLICY = `version: 1\nworkspace: "1"\nrules:\n  - allow: [read]\n`;

/** A loader over `fetch` that derives every fact (the policy reads none of the task's state). */
async function loaderOver(fetch: typeof globalThis.fetch): Promise<FactsLoader> {
	const policy = await compilePolicy(parsePolicy(POLICY), fakeResolver);
	const client = new AsanaClient({ token: "t", fetch, maxRetries: 0 });
	return new FactsLoader({ client, policy, allFacts: true });
}

describe("facts loader", () => {
	it("forgets a subtask's inherited placement when its parent is written", async () => {
		const fake = createFakeAsana();
		const loader = await loaderOver(fake.fetch);
		const before = await loader.load("task", "104");
		expect(before?.facts.branches[0]?.project).toBe("21");
		// Asana moves the parent behind the gate's back.
		expect(fake.api("POST", "/tasks/101/removeProject", { project: "21" }).status).toBe(200);
		expect(fake.api("POST", "/tasks/101/addProject", { project: "22", section: "33" }).status).toBe(
			200,
		);
		loader.invalidate("task", "101");
		const after = await loader.load("task", "104");
		expect(after?.facts.branches[0]?.project).toBe("22");
	});

	it("judges a subtask's parent by its new placement once the parent is written", async () => {
		const { fake, gate } = await setupGate(
			`${POLICY}  - where: { project: "23" }\n    deny: ["*"]\n`,
		);
		const created = fake.api("POST", "/tasks", { name: "S", projects: ["21"], parent: "101" });
		const gid = String(data(created.body).gid);
		const parentOf = async (): Promise<unknown> => {
			const response = await gate.execute({ method: "GET", path: `/tasks/${gid}` });
			return data(response.body).parent;
		};
		await expect(parentOf()).resolves.toMatchObject({ gid: "101" });
		// Asana moves the parent into a hidden project; the gate learns of the write.
		expect(fake.api("POST", "/tasks/101/removeProject", { project: "21" }).status).toBe(200);
		expect(fake.api("POST", "/tasks/101/addProject", { project: "23" }).status).toBe(200);
		gate.loader.invalidate("task", "101");
		await expect(parentOf()).resolves.toBeNull();
	});

	it("does not keep an object fetched before a write invalidated it", async () => {
		const fake = createFakeAsana();
		const held = Promise.withResolvers<boolean>();
		const loader = await loaderOver(holdingFirst(fake.fetch, "/tasks/101", held.promise));
		const stale = loader.load("task", "101");
		loader.invalidate("task", "101");
		held.resolve(true);
		await stale;
		expect(fake.api("PUT", "/tasks/101", { completed: true }).status).toBe(200);
		const fresh = await loader.load("task", "101");
		expect(fresh?.facts.state?.completed).toBe(true);
	});

	it("skips a probe candidate the workspace's plan does not offer", async () => {
		const { client } = routed({
			"/goals/61": () => json(402, { errors: [{ message: "Payment Required" }] }),
			"/sections/61": () => json(200, { data: { gid: "61", name: "S", project: { gid: "21" } } }),
			"/projects/21": () =>
				json(200, { data: { gid: "21", name: "P", workspace: { gid: "1" }, team: { gid: "11" } } }),
		});
		const policy = await compilePolicy(parsePolicy(POLICY), fakeResolver);
		const loader = new FactsLoader({ client, policy });
		const found = await loader.probe("61", ["goal", "section"]);
		expect(found?.type).toBe("section");
	});
});

describe("name resolver", () => {
	it("resolves a custom field gid through the field itself", async () => {
		const { client, calls } = routed({
			"/custom_fields/1203": () =>
				json(200, {
					data: { gid: "1203", name: "Local", enum_options: [{ gid: "9", name: "A" }] },
				}),
		});
		const field = await new AsanaNameResolver(client).customField("1203", "1");
		expect(field).toStrictEqual({
			gid: "1203",
			name: "Local",
			enumOptions: [{ gid: "9", name: "A" }],
		});
		expect(calls).toStrictEqual(["/custom_fields/1203"]);
	});

	it("looks a user up once however often the policy names them", async () => {
		const { client, calls } = routed({
			"/users/alice%40acme.test": () => json(200, { data: { gid: "77", name: "Alice" } }),
		});
		const resolver = new AsanaNameResolver(client);
		const gids = await Promise.all([
			resolver.user("alice@acme.test", "1"),
			resolver.user("alice@acme.test", "1"),
		]);
		expect(gids).toStrictEqual(["77", "77"]);
		expect(calls).toHaveLength(1);
	});
});
