// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import type { HttpMethod } from "../catalog/operation-spec.ts";
import { isObject } from "../json.ts";
import { type Logger, silentLogger } from "../log.ts";
import { chunksOf, isBatchPath, joinedResults } from "./batch.ts";
import { AsanaApiError, parseErrorEntries } from "./errors.ts";
import { flagHeaders, parseAsanaChange, parseRetryAfter } from "./headers.ts";
import { type QueryValue, renderQuery } from "./query.ts";
import { Semaphore, wait, withSemaphore } from "./semaphore.ts";

/** The public Asana REST API base URL. */
const ASANA_API_BASE_URL = "https://app.asana.com/api/1.0";

/** Asana's limits on requests in flight per token: 50 reads and 15 writes. */
const ASANA_LIMITS = { reads: 50, writes: 15 } as const;

/** Asana runs at most this many actions in one `POST /batch`. */
const ASANA_BATCH_ACTIONS = 10;

/** How many actions one asana-gate batch may hold; the client sends them to Asana {@link ASANA_BATCH_ACTIONS} at a time. */
const BATCH_LIMIT = 50;

/** What the client does unless its options say otherwise. */
const CLIENT_DEFAULTS = {
	maxRetries: 5,
	maxRetryAfterSeconds: 60,
	maxConcurrentReads: ASANA_LIMITS.reads,
	maxConcurrentWrites: ASANA_LIMITS.writes,
} as const;

/** Options for {@link AsanaClient}. */
interface AsanaClientOptions {
	/** The Personal Access Token. Treated as opaque; never logged. */
	token: string;
	/** Base URL of the API; override for tests or proxies. */
	baseUrl?: string;
	/** The fetch implementation; override for tests. */
	fetch?: typeof globalThis.fetch;
	/** Retries after a 429, and after a 5xx for a request that is safe to send twice (not a POST). */
	maxRetries?: number;
	/** Concurrent GET requests in flight (Asana allows 50). */
	maxConcurrentReads?: number;
	/** Concurrent write requests in flight (Asana allows 15). */
	maxConcurrentWrites?: number;
	/** The longest wait before a retry, in seconds: a longer `Retry-After` (or backoff) is cut to it, and the request is still retried. */
	maxRetryAfterSeconds?: number;
	userAgent?: string;
	logger?: Logger;
	/** Flags sent in the `Asana-Enable` header of every request: early-access opt-ins, announced changes taken early. */
	enable?: readonly string[];
	/** Flags sent in the `Asana-Disable` header of every request: announced changes kept off while Asana allows it. */
	disable?: readonly string[];
}

/** A request against the Asana API. */
interface AsanaRequest {
	method: HttpMethod;
	/** The path below the base URL, e.g. `/tasks/123`. */
	path: string;
	query?: Record<string, QueryValue>;
	/** The JSON `data` object of the request body. */
	data?: unknown;
	/** A multipart body (attachments); takes precedence over `data`. */
	multipart?: FormData;
	signal?: AbortSignal;
}

/** Pagination info Asana returns with list responses. */
interface NextPage {
	readonly offset: string;
	readonly path: string;
	readonly uri: string;
}

/** A successful Asana response. */
interface AsanaResponse<T = unknown> {
	readonly status: number;
	/** The `data` member of the response body. */
	readonly data: T;
	/** The `next_page` member, when the response is a page of a list. */
	readonly nextPage: NextPage | null | undefined;
	/** The whole JSON body. */
	readonly body: Record<string, unknown>;
	readonly headers: Headers;
}

/** The JSON body of a response, or `null` when it has none. */
async function parseJson(response: Response): Promise<unknown> {
	try {
		return (await response.json()) as unknown;
	} catch {
		return null;
	}
}

/**
 * A thin Asana REST client: bearer auth, JSON envelopes, pagination,
 * concurrency caps and `Retry-After`-aware retries. It knows nothing about
 * policies; the gate sits on top of it.
 */
class AsanaClient {
	public readonly baseUrl: string;
	private readonly token: string;
	private readonly fetchImpl: typeof globalThis.fetch;
	private readonly maxRetries: number;
	private readonly maxRetryAfterSeconds: number;
	private readonly reads: Semaphore;
	private readonly writes: Semaphore;
	private readonly userAgent: string;
	private readonly logger: Logger;
	private readonly announced = new Set<string>();
	/** The `Asana-Enable` / `Asana-Disable` headers of every request. */
	private readonly flags: Record<string, string>;

	public constructor(options: AsanaClientOptions) {
		this.token = options.token;
		this.baseUrl = (options.baseUrl ?? ASANA_API_BASE_URL).replace(/\/+$/u, "");
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.maxRetries = options.maxRetries ?? CLIENT_DEFAULTS.maxRetries;
		this.maxRetryAfterSeconds =
			options.maxRetryAfterSeconds ?? CLIENT_DEFAULTS.maxRetryAfterSeconds;
		this.flags = flagHeaders(options.enable ?? [], options.disable ?? []);
		this.reads = new Semaphore(options.maxConcurrentReads ?? CLIENT_DEFAULTS.maxConcurrentReads);
		this.writes = new Semaphore(options.maxConcurrentWrites ?? CLIENT_DEFAULTS.maxConcurrentWrites);
		this.userAgent = options.userAgent ?? "asana-gate";
		this.logger = options.logger ?? silentLogger;
	}

	/** Builds the full URL of a request. */
	private url(path: string, query?: Record<string, QueryValue>): URL {
		const url = new URL(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
		for (const [key, value] of Object.entries(renderQuery(query))) {
			url.searchParams.set(key, value);
		}
		return url;
	}

	/** Sends one request, retrying on 429 / 5xx, and parses the JSON envelope; a batch of more actions than Asana takes goes as several. */
	public request<T = unknown>(request: AsanaRequest): Promise<AsanaResponse<T>> {
		const actions = isBatchPath(request.path) && isObject(request.data) ? request.data.actions : [];
		if (Array.isArray(actions) && actions.length > ASANA_BATCH_ACTIONS) {
			return this.batched<T>(request, actions);
		}
		const semaphore = request.method === "GET" ? this.reads : this.writes;
		return withSemaphore(semaphore, () => this.attempt<T>(request, 0));
	}

	/** Sends a batch as requests of {@link ASANA_BATCH_ACTIONS} actions each, at once, and joins their results in order. */
	private async batched<T>(
		request: AsanaRequest,
		actions: readonly unknown[],
	): Promise<AsanaResponse<T>> {
		const chunks = chunksOf(actions, ASANA_BATCH_ACTIONS);
		const envelope = isObject(request.data) ? request.data : {};
		const settled = await Promise.allSettled(
			chunks.map((chunk) =>
				this.request<unknown[]>({ ...request, data: { ...envelope, actions: chunk } }),
			),
		);
		const first = settled.find((result) => result.status === "fulfilled");
		if (first === undefined) {
			// Nothing ran: report the failure as the request's own.
			const [failed] = settled;
			throw failed?.status === "rejected" ? failed.reason : new Error("empty batch");
		}
		const data = joinedResults(settled, chunks);
		return { ...first.value, data: data as T, body: { ...first.value.body, data } };
	}

	/** `GET` and returns the `data` member. */
	public async get<T = unknown>(path: string, query?: Record<string, QueryValue>): Promise<T> {
		const response = await this.request<T>({ method: "GET", path, query });
		return response.data;
	}

	/**
	 * Iterates over every item of a paginated list, page by page.
	 *
	 * @yields {T} each item of the list, in API order.
	 */
	public async *paginate<T = unknown>(
		path: string,
		query?: Record<string, QueryValue>,
		options?: { limit?: number; signal?: AbortSignal },
	): AsyncGenerator<T, void, undefined> {
		let page: Record<string, QueryValue> | undefined = { ...query };
		while (page !== undefined) {
			// Each page names the next, so the pages are fetched one after another.
			// oxlint-disable-next-line no-await-in-loop
			const response: AsanaResponse<T[]> = await this.request<T[]>({
				method: "GET",
				path,
				query: { ...page, limit: options?.limit ?? 100 },
				signal: options?.signal,
			});
			yield* response.data;
			page = response.nextPage ? { ...page, offset: response.nextPage.offset } : undefined;
		}
	}

	private async attempt<T>(request: AsanaRequest, attempt: number): Promise<AsanaResponse<T>> {
		const response = await this.send(request);
		this.noteAnnouncedChanges(response.headers.get("asana-change"));
		const body = await parseJson(response);
		if (response.ok) {
			const envelope = isObject(body) ? body : {};
			return {
				status: response.status,
				data: envelope.data as T,
				nextPage: envelope.next_page as NextPage | null | undefined,
				body: envelope,
				headers: response.headers,
			};
		}
		const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
		const error = new AsanaApiError({
			status: response.status,
			errors: parseErrorEntries(body, response.status),
			body,
			...(retryAfter !== undefined && { retryAfter }),
		});
		// A 429 was refused before it ran. A 5xx may come after Asana ran the request, so it is sent
		// again only when running twice changes nothing more: never a POST, which creates or adds
		// (the rule of urllib3's Retry, which python-asana uses).
		const retryable =
			response.status === 429 || (response.status >= 500 && request.method !== "POST");
		if (!retryable || attempt >= this.maxRetries) {
			throw error;
		}
		// A 429 waits what Retry-After says; a 5xx backs off, longer when Retry-After asks for it. Either is capped.
		const wanted =
			response.status === 429 ? (retryAfter ?? 1) : Math.max(retryAfter ?? 0, 2 ** attempt);
		const waitSeconds = Math.min(wanted, this.maxRetryAfterSeconds);
		this.logger.warn(
			`${request.method} ${request.path}: ${response.status}, retrying in ${waitSeconds}s (attempt ${attempt + 1}/${this.maxRetries})`,
		);
		await wait(waitSeconds * 1000, request.signal);
		return this.attempt<T>(request, attempt + 1);
	}

	/**
	 * Asana announces upcoming API changes in an `Asana-Change` header
	 * (https://developers.asana.com/docs/deprecations); each one is logged once
	 * so operators learn that this deployment's behavior may change.
	 */
	private noteAnnouncedChanges(header: string | null): void {
		const fresh = parseAsanaChange(header).filter((change) => !this.announced.has(change.name));
		for (const change of fresh) {
			this.announced.add(change.name);
			const info = change.info === undefined ? "" : ` (${change.info})`;
			const text = `Asana announced the API change "${change.name}"${info}`;
			// Informational: Asana flags `affected=true` on most responses for
			// changes that rarely concern this gateway, so this stays below `warn`.
			this.logger.info(change.affected ? `${text}; this request is affected` : text);
		}
	}

	private send(request: AsanaRequest): Promise<Response> {
		const headers: Record<string, string> = {
			authorization: `Bearer ${this.token}`,
			accept: "application/json",
			"user-agent": this.userAgent,
			...this.flags,
		};
		const body = AsanaClient.bodyOf(request, headers);
		this.logger.debug(`${request.method} ${request.path}`);
		return this.fetchImpl(this.url(request.path, request.query), {
			method: request.method,
			headers,
			body,
			signal: request.signal,
		});
	}

	private static bodyOf(
		request: AsanaRequest,
		headers: Record<string, string>,
	): BodyInit | undefined {
		if (request.multipart !== undefined) {
			return request.multipart;
		}
		if (request.data === undefined) {
			return undefined;
		}
		headers["content-type"] = "application/json";
		return JSON.stringify({ data: request.data });
	}
}

export {
	ASANA_API_BASE_URL,
	ASANA_BATCH_ACTIONS,
	ASANA_LIMITS,
	AsanaClient,
	BATCH_LIMIT,
	CLIENT_DEFAULTS,
};
export type { AsanaClientOptions, AsanaRequest, AsanaResponse, NextPage };
