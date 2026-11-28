// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { AsanaClient } from "../src/asana/client.ts";
import { FactsLoader } from "../src/gate/facts.ts";
import { PortfolioIndex } from "../src/gate/portfolio-index.ts";
import { compilePolicy } from "../src/policy/compile.ts";
import { parsePolicy } from "../src/policy/load.ts";
import { createFakeAsana } from "./helpers/fake-asana.ts";
import { data, type Fake, setupGate } from "./helpers/gate.ts";
import { requests } from "./helpers/requests.ts";
import { CONTEXT } from "./helpers/world.ts";

type Route = (url: URL) => Response;

const json = (status: number, body: unknown): Response => Response.json(body, { status });

/** A client whose fetch answers by path, and 404 for any other. */
function routed(routes: Record<string, Route>): AsanaClient {
	const fetch: typeof globalThis.fetch = (input) => {
		const url = new URL(input instanceof Request ? input.url : input);
		const route = routes[url.pathname.replace(/^\/api\/1\.0/u, "")];
		return Promise.resolve(
			route === undefined ? json(404, { errors: [{ message: "Not found" }] }) : route(url),
		);
	};
	return new AsanaClient({ token: "t", fetch, maxRetries: 0 });
}

const POLICY = `version: 1\nworkspace: "1"\nrules:\n  - allow: ["*"]\n`;

/** Everything, except what is in the Secret project (23). */
const SECRET_HIDDEN = `${POLICY}  - where: { project: "23" }\n    deny: ["*"]\n`;

/** Everything, and more for what the Roadmap portfolio (81) holds, so that the portfolio is read. */
const WITH_PORTFOLIO = `${POLICY}  - where: { portfolio: "81" }\n    confirm: [task:delete]\n`;

/** A loader over the fake that derives every fact. */
function loaderOver(fake: Fake): FactsLoader {
	const policy = compilePolicy(parsePolicy(POLICY), CONTEXT);
	const client = new AsanaClient({ token: "t", fetch: fake.fetch, maxRetries: 0 });
	return new FactsLoader({ client, policy, allFacts: true });
}

/** Moves task 101 from the Backend project (21) to `project`, in Asana itself: the gate is not told. */
function moveParent(fake: Fake, project: string): void {
	fake.api("POST", "/tasks/101/removeProject", { project: "21" });
	fake.api("POST", "/tasks/101/addProject", { project });
}

/** How often the gate asked Asana for `path`. */
const asked = (fake: Fake, path: string): number =>
	requests(fake).filter((request) => request === path).length;

describe("what a request learns from Asana", () => {
	it("is gone with it: the next request is judged by what Asana says then", async () => {
		const { fake, gate } = await setupGate(SECRET_HIDDEN);
		const created = fake.api("POST", "/tasks", { name: "S", projects: ["21"], parent: "101" });
		const path = `/tasks/${String(data(created.body).gid)}`;
		const parentOf = async (): Promise<unknown> => {
			const response = await gate.execute({ method: "GET", path });
			return data(response.body).parent;
		};
		await expect(parentOf()).resolves.toMatchObject({ gid: "101" });
		// Somebody moves the parent into the hidden project.
		moveParent(fake, "23");
		await expect(parentOf()).resolves.toBeNull();
	});

	it("is asked for once, however often the request needs it, until the loader forgets", async () => {
		const fake = createFakeAsana();
		const loader = loaderOver(fake);
		const first = await loader.load("task", "104");
		await Promise.all([loader.load("task", "104"), loader.load("task", "104")]);
		// A subtask's own fetch carries its parent's placement.
		expect(requests(fake)).toStrictEqual(["GET /tasks/104"]);
		expect(first?.facts.branches[0]?.project).toBe("21");
		moveParent(fake, "22");
		loader.forget();
		const again = await loader.load("task", "104");
		expect(again?.facts.branches[0]?.project).toBe("22");
	});

	it("is asked for again once the request has written, to judge the answer", async () => {
		const { fake, gate } = await setupGate(POLICY);
		const renamed = await gate.execute({
			method: "PUT",
			path: "/sections/31",
			body: { name: "Next" },
		});
		expect(renamed.status).toBe(200);
		// The section is placed by its project, before the write and after it.
		expect(requests(fake)).toStrictEqual([
			"GET /sections/31",
			"GET /projects/21",
			"PUT /sections/31",
			"GET /projects/21",
		]);
	});

	it("holds a custom field's definition once for a request, in however many actions set the field", async () => {
		const { fake, gate } = await setupGate(POLICY);
		const set = (...values: unknown[]): ReturnType<typeof gate.execute> => {
			const actions = values.map((value) => ({
				method: "put",
				relative_path: "/tasks/101",
				data: { custom_fields: { "61": value } },
			}));
			return gate.execute({ method: "POST", path: "/batch", body: { actions } });
		};
		// A value that names nothing asks for no definition.
		await set(null);
		expect(asked(fake, "GET /custom_fields/61")).toBe(0);
		// Field 61 takes an option of its own, which only its definition tells from an object's gid.
		await expect(set("71", "72")).resolves.toMatchObject({ status: 200 });
		expect(asked(fake, "GET /custom_fields/61")).toBe(1);
	});
});

describe("the portfolios a policy names", () => {
	it("are listed once for a request that places something, and again for the next", async () => {
		const { fake, gate } = await setupGate(WITH_PORTFOLIO);
		const tasks = { method: "GET", path: "/projects/21/tasks" } as const;
		await expect(gate.execute(tasks)).resolves.toMatchObject({ status: 200 });
		expect(asked(fake, "GET /portfolios/81/items")).toBe(1);
		await expect(gate.execute(tasks)).resolves.toMatchObject({ status: 200 });
		expect(asked(fake, "GET /portfolios/81/items")).toBe(2);
	});

	it("fail the request when Asana would not list one, and are empty when it is not there", async () => {
		const limited = routed({ "/portfolios/91/items": () => json(429, { errors: [] }) });
		const roots = new Set(["91"]);
		await expect(new PortfolioIndex(limited).list(roots)).rejects.toMatchObject({ status: 429 });
		const missing = routed({ "/portfolios/91/items": () => json(404, { errors: [] }) });
		const index = await new PortfolioIndex(missing).list(roots);
		expect(index.containing("21")).toStrictEqual(new Set());
	});
});

describe("probing an object of unknown type", () => {
	it("skips a candidate the workspace's plan does not offer", async () => {
		const client = routed({
			"/goals/61": () => json(402, { errors: [{ message: "Payment Required" }] }),
			"/sections/61": () => json(200, { data: { gid: "61", name: "S", project: { gid: "21" } } }),
			"/projects/21": () =>
				json(200, { data: { gid: "21", name: "P", workspace: { gid: "1" }, team: { gid: "11" } } }),
		});
		const policy = compilePolicy(parsePolicy(POLICY), CONTEXT);
		const loader = new FactsLoader({ client, policy });
		const found = await loader.probe("61", ["goal", "section"]);
		expect(found?.type).toBe("section");
	});
});
