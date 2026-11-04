// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { AsanaClient } from "../src/asana/client.ts";
import { AsanaApiError } from "../src/asana/errors.ts";

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
	Response.json(body, { status, headers });

/** The URL of the n-th request a fetch mock received. */
const requestedUrl = (fetch: { mock: { calls: unknown[][] } }, index: number): URL => {
	const [url] = fetch.mock.calls[index] ?? [];
	return url instanceof URL ? url : new URL(String(url));
};

/** A list endpoint of `pages` pages of one item each, the offset naming the page. */
const pagedList =
	(pages: number): typeof globalThis.fetch =>
	(input) => {
		const page = Number((input as URL).searchParams.get("offset") ?? "0");
		const next = page + 1 < pages ? { offset: String(page + 1), path: "", uri: "" } : null;
		return Promise.resolve(json(200, { data: [{ gid: String(page) }], next_page: next }));
	};

/** A batch endpoint that creates every action it is sent. */
const created: typeof globalThis.fetch = (_url, init) => {
	const body = JSON.parse(init?.body as string) as { data: { actions: unknown[] } };
	const results = body.data.actions.map(() => ({ status_code: 201, body: { data: {} } }));
	return Promise.resolve(json(200, { data: results }));
};

describe("asana client", () => {
	it("sends the bearer token, the JSON envelope and comma-joined opt_fields", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(json(200, { data: { gid: "1" } }));
		const client = new AsanaClient({ token: "secret", fetch });
		const response = await client.request({
			method: "PUT",
			path: "/tasks/1",
			query: { opt_fields: ["a", "b"] },
			data: { name: "x" },
		});
		expect(response.data).toStrictEqual({ gid: "1" });
		const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
		expect(url.href).toBe("https://app.asana.com/api/1.0/tasks/1?opt_fields=a%2Cb");
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");
		expect(init.body).toBe('{"data":{"name":"x"}}');
	});

	it("sends the Asana-Enable and Asana-Disable flags on every request", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(json(200, { data: { gid: "1" } }));
		const client = new AsanaClient({
			token: "secret",
			fetch,
			enable: ["ai_teammate_actors", "other_change"],
			disable: ["a_third_change"],
		});
		await client.request({ method: "GET", path: "/agents/1" });
		const [, init] = fetch.mock.calls[0] as [URL, RequestInit];
		const headers = init.headers as Record<string, string>;
		expect(headers["asana-enable"]).toBe("ai_teammate_actors,other_change");
		expect(headers["asana-disable"]).toBe("a_third_change");
		await new AsanaClient({ token: "secret", fetch }).request({ method: "GET", path: "/agents/1" });
		const [, bare] = fetch.mock.calls[1] as [URL, RequestInit];
		expect(Object.keys(bare.headers as Record<string, string>)).not.toContain("asana-enable");
	});

	it("retries 429 responses after Retry-After and gives up after maxRetries", async () => {
		vi.useFakeTimers();
		try {
			const fetch = vi
				.fn<typeof globalThis.fetch>()
				.mockResolvedValueOnce(
					json(429, { errors: [{ message: "Rate Limit Enforced" }] }, { "retry-after": "2" }),
				)
				.mockResolvedValueOnce(json(200, { data: [] }));
			const client = new AsanaClient({ token: "t", fetch, maxRetries: 1 });
			const pending = client.get("/tasks", { project: "1" });
			await vi.advanceTimersByTimeAsync(2000);
			await expect(pending).resolves.toStrictEqual([]);
			expect(fetch).toHaveBeenCalledTimes(2);

			const exhausted = vi
				.fn<typeof globalThis.fetch>()
				.mockResolvedValue(
					json(429, { errors: [{ message: "Rate Limit Enforced" }] }, { "retry-after": "1" }),
				);
			const strict = new AsanaClient({ token: "t", fetch: exhausted, maxRetries: 0 });
			await expect(strict.get("/tasks")).rejects.toBeInstanceOf(AsanaApiError);
			expect(exhausted).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("waits at least what Retry-After asks before retrying a 5xx, cut to maxWait", async () => {
		vi.useFakeTimers();
		try {
			const fetch = vi
				.fn<typeof globalThis.fetch>()
				.mockResolvedValueOnce(json(503, { errors: [] }, { "retry-after": "5" }))
				.mockResolvedValueOnce(json(503, { errors: [] }, { "retry-after": "600" }))
				.mockResolvedValueOnce(json(200, { data: { gid: "1" } }));
			const client = new AsanaClient({ token: "t", fetch, maxRetries: 2, maxRetryAfterSeconds: 9 });
			const pending = client.get("/tasks/1");
			await vi.advanceTimersByTimeAsync(4999);
			expect(fetch).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(1);
			expect(fetch).toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(9000);
			await expect(pending).resolves.toStrictEqual({ gid: "1" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("returns a POST's 5xx instead of sending it twice, but retries its 429", async () => {
		vi.useFakeTimers();
		try {
			const fetch = vi
				.fn<typeof globalThis.fetch>()
				.mockResolvedValueOnce(json(503, { errors: [{ message: "Service Unavailable" }] }))
				.mockResolvedValueOnce(json(429, { errors: [] }, { "retry-after": "1" }))
				.mockResolvedValueOnce(json(201, { data: { gid: "2" } }));
			const client = new AsanaClient({ token: "t", fetch });
			const create = { method: "POST", path: "/tasks", data: { name: "x" } } as const;
			await expect(client.request(create)).rejects.toMatchObject({ status: 503 });
			expect(fetch).toHaveBeenCalledOnce();
			const retried = client.request(create);
			await vi.advanceTimersByTimeAsync(1000);
			await expect(retried).resolves.toMatchObject({ status: 201 });
			expect(fetch).toHaveBeenCalledTimes(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it("backs off a 5xx without Retry-After, and ignores a blank one", async () => {
		vi.useFakeTimers();
		try {
			const fetch = vi
				.fn<typeof globalThis.fetch>()
				.mockResolvedValueOnce(json(500, { errors: [] }, { "retry-after": "" }))
				.mockResolvedValueOnce(json(200, { data: [] }));
			const client = new AsanaClient({ token: "t", fetch, maxRetries: 1 });
			const pending = client.get("/tasks", { project: "1" });
			await vi.advanceTimersByTimeAsync(999);
			expect(fetch).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(1);
			await expect(pending).resolves.toStrictEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the whole error body, including out-of-band members such as sync", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(json(412, { errors: [{ message: "Sync token invalid" }], sync: "abc" }));
		const client = new AsanaClient({ token: "t", fetch, maxRetries: 0 });
		const error = await client.get("/events", { resource: "1" }).catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(AsanaApiError);
		expect((error as AsanaApiError).status).toBe(412);
		expect((error as AsanaApiError).toBody()).toStrictEqual({
			errors: [{ message: "Sync token invalid" }],
			sync: "abc",
		});
	});

	it("walks every page of a list", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(
				json(200, { data: [{ gid: "1" }], next_page: { offset: "o2", path: "", uri: "" } }),
			)
			.mockResolvedValueOnce(json(200, { data: [{ gid: "2" }], next_page: null }));
		const client = new AsanaClient({ token: "t", fetch });
		const gids: string[] = [];
		for await (const item of client.paginate<{ gid: string }>("/tags", { workspace: "1" })) {
			gids.push(item.gid);
		}
		expect(gids).toStrictEqual(["1", "2"]);
		expect(requestedUrl(fetch, 1).searchParams.get("offset")).toBe("o2");
		expect(requestedUrl(fetch, 1).searchParams.get("limit")).toBe("100");
	});

	it("walks a long list without nesting a generator per page", async () => {
		const pages = 2000;
		const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(pagedList(pages));
		const client = new AsanaClient({ token: "t", fetch });
		let count = 0;
		for await (const _ of client.paginate("/tags", { workspace: "1" }, { limit: 1 })) {
			count += 1;
		}
		expect(count).toBe(pages);
		expect(requestedUrl(fetch, pages - 1).searchParams.get("limit")).toBe("1");
	});

	it("sends a batch of more than ten actions as several requests and joins the results in order", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => {
			const body = JSON.parse(init?.body as string) as {
				data: { actions: { data: { name: string } }[] };
			};
			const results = body.data.actions.map((action) => ({
				status_code: 201,
				body: { data: { name: action.data.name } },
			}));
			return Promise.resolve(json(200, { data: results }));
		});
		const client = new AsanaClient({ token: "t", fetch });
		const actions = Array.from({ length: 23 }, (_, i) => ({
			method: "post",
			relative_path: "/tasks",
			data: { name: `T${i}` },
		}));
		const response = await client.request<{ body: { data: { name: string } } }[]>({
			method: "POST",
			path: "/batch",
			data: { actions },
		});
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(response.data.map((result) => result.body.data.name)).toStrictEqual(
			actions.map((action) => action.data.name),
		);
	});

	it("answers one result per action of a failed chunk instead of failing the whole batch", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockImplementationOnce(created)
			.mockResolvedValueOnce(json(500, { errors: [{ message: "Server Error" }] }))
			.mockImplementationOnce(created);
		const client = new AsanaClient({ token: "t", fetch, maxRetries: 0 });
		const actions = Array.from({ length: 23 }, () => ({ method: "post", relative_path: "/tasks" }));
		const response = await client.request<{ status_code: number }[]>({
			method: "POST",
			path: "/batch",
			data: { actions },
		});
		const statuses = response.data.map((result) => result.status_code);
		expect(statuses).toHaveLength(23);
		expect(statuses.slice(0, 10).every((status) => status === 201)).toBe(true);
		expect(statuses.slice(10, 20).every((status) => status === 500)).toBe(true);
		expect(statuses.slice(20).every((status) => status === 201)).toBe(true);
	});
});
