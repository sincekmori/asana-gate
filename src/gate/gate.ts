// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import type { AsanaClient, AsanaResponse } from "../asana/client.ts";
import { AsanaApiError } from "../asana/errors.ts";
import type { QueryValue } from "../asana/query.ts";
import { ruleFor } from "../catalog/classification.ts";
import type { HttpMethod } from "../catalog/operation-spec.ts";
import type { Resource } from "../catalog/resources.ts";
import { type Logger, silentLogger } from "../log.ts";
import { constraintsFor, type EffectiveLimit, hasConstraints } from "../policy/effective.ts";
import {
	allowedActions,
	type Explanation,
	explainResource,
	type Facts,
	fieldAllowlist,
	isAllowed,
	isVisible,
} from "../policy/evaluate.ts";
import type { Policy } from "../policy/types.ts";
import { ConfirmationRequiredError } from "./confirmation.ts";
import {
	constraintViolation,
	forbidden,
	forbiddenField,
	GateError,
	limitExceeded,
	noRoute,
	notFound,
	inAction,
	type PendingConfirmation,
} from "./errors.ts";
import { FactsLoader } from "./facts.ts";
import { type AsanaObject, isObject, resourceOfType, stringOf } from "./objects.ts";
import {
	type Check,
	createPlanContext,
	dataOf,
	optionFieldsOf,
	type Plan,
	type PlanContext,
	type ResponsePlan,
} from "./plan.ts";
import { fillPath, matchRoute, type RouteMatch } from "./router.ts";
import { augmentOptFields, pick, requestedFields } from "./selection.ts";
import { redactObject } from "./shape.ts";

/** Options for {@link Gate}. */
interface GateOptions {
	client: AsanaClient;
	policy: Policy;
	loader?: FactsLoader;
	logger?: Logger;
	/** How many extra pages a filtered list may fetch to fill up to the requested size. */
	maxRefillPages?: number;
}

/** A request to pass through the gate. */
interface GateRequest {
	method: HttpMethod;
	/** The API path, e.g. `/tasks/123`; a query string in it is honored. */
	path: string;
	query?: Readonly<Record<string, string | undefined>>;
	/** The JSON body: either the `data` object or an envelope around it. */
	body?: unknown;
	/** A multipart body (attachment uploads); `body` then carries the form fields for planning. */
	multipart?: FormData;
}

/** The outcome of a gated request: an HTTP status and a JSON body shaped like Asana's. */
interface GateResponse {
	readonly status: number;
	readonly body: Record<string, unknown>;
}

/**
 * Asked when the policy says a person must confirm actions before they run.
 * Resolves to `true` to proceed; `false` refuses the request as declined.
 */
type ConfirmHandler = (pending: readonly PendingConfirmation[]) => Promise<boolean>;

/** Options of {@link Gate.execute}. */
interface ExecuteOptions {
	/** How confirmations are obtained; without it, a request needing one is refused with 428. */
	readonly confirm?: ConfirmHandler;
}

/** A planned request, before it is sent. */
interface Planned {
	readonly match: RouteMatch;
	readonly context: PlanContext;
	readonly plan: Plan;
}

type ListPlan = Extract<ResponsePlan, { kind: "list" }>;
type ItemPlan = Extract<ResponsePlan, { kind: "item" }>;

interface ListOptions {
	/** Fetches the page at `offset`, of at most `limit` items. */
	readonly refill?: (offset: string, limit: number) => Promise<AsanaResponse>;
	readonly limit?: number;
}

/** Resource types whose nested references are checked: a visible object may point at hidden ones. */
const NESTED_TYPES: ReadonlySet<Resource> = new Set([
	"task",
	"project",
	"section",
	"portfolio",
	"goal",
	"team",
]);

/** How deep nested references are followed (a subtask's ancestors nest five levels). */
const MAX_NESTING = 6;

/** Marks a nested reference to a hidden object, removed from the response. */
const HIDDEN = Symbol("hidden");

/** Ancestors known with their placement, by gid: none. */
const NO_ANCESTORS: ReadonlyMap<string, AsanaObject> = new Map();

/** What an object a response shows is judged by. */
interface Judging {
	/** The object's own facts; `undefined` when none could be derived. */
	readonly facts: Facts | undefined;
	/** The ancestors known with their placement, by gid ({@link FactsLoader.placedAncestors}). */
	readonly ancestors?: ReadonlyMap<string, AsanaObject>;
}

const WRITE_METHODS: ReadonlySet<HttpMethod> = new Set(["POST", "PUT", "PATCH"]);

function parseQuery(query: GateRequest["query"], path: string): Record<string, string> {
	const result: Record<string, string> = {};
	const fromPath = path.indexOf("?");
	if (fromPath !== -1) {
		for (const [key, value] of new URLSearchParams(path.slice(fromPath + 1))) {
			result[key] = value;
		}
	}
	for (const [key, value] of Object.entries(query ?? {})) {
		if (value !== undefined) {
			result[key] = value;
		}
	}
	return result;
}

/** The query, with the `options.fields` of an enveloped body joining its `opt_fields`. */
function withOptionFields(query: Record<string, string>, body: unknown): Record<string, string> {
	const fields = optionFieldsOf(body);
	if (fields.length === 0) {
		return query;
	}
	return { ...query, opt_fields: requestedFields(query.opt_fields, fields).join(",") };
}

/** The form to send: the caller's, with the members the policy shaped (a file stays as given). */
function shapedForm(form: FormData, data: unknown): FormData {
	if (!isObject(data)) {
		return form;
	}
	const shaped = new FormData();
	for (const [key, value] of form) {
		shaped.append(key, value);
	}
	for (const [key, value] of Object.entries(data)) {
		if (key !== "file" && (typeof value === "string" || typeof value === "number")) {
			shaped.set(key, String(value));
		}
	}
	return shaped;
}

/** The fields a request names, `undefined` for none (Asana's default representation). */
function fieldsNamed(optFields: string | undefined): string[] | undefined {
	const fields = requestedFields(optFields);
	return fields.length > 0 ? fields : undefined;
}

/** The type of an item of a mixed list: the one it names, or the only one the list expects. */
function itemTypeOf(response: ListPlan, item: AsanaObject): Resource | undefined {
	const [only, ...others] = response.expect ?? [];
	return resourceOfType(stringOf(item.resource_type)) ?? (others.length === 0 ? only : undefined);
}

function offsetOf(nextPage: unknown): string | undefined {
	return isObject(nextPage) ? stringOf(nextPage.offset) : undefined;
}

/**
 * Whether a nested task's placement decides how it shows: no filter rule
 * (tag, assignee, state, …), whose facts a placement does not carry, may
 * hide tasks or redact their members. A property of the policy, so the gate
 * works it out once.
 */
function placementDecidesFor(policy: Policy): boolean {
	return !policy.rules.some(
		(rule) =>
			rule.specificity.cross > 0 &&
			((rule.effect === "deny" && rule.actions.has("task:read")) ||
				(rule.constraints?.redact.get("task")?.size ?? 0) > 0),
	);
}

/**
 * The gate: classifies a request, resolves what it touches, evaluates the
 * policy, forwards the request to Asana, and shapes the response so that
 * invisible objects never appear in it.
 */
class Gate {
	public readonly policy: Policy;
	public readonly loader: FactsLoader;
	public readonly client: AsanaClient;
	private readonly logger: Logger;
	private readonly maxRefillPages: number;
	/** Whether a nested task's placement decides how it shows ({@link placementDecidesFor}). */
	private readonly placementDecides: boolean;
	/** Request timestamps per rate limit (`rules[i]:action`), for `limit` clauses. */
	private readonly usage = new Map<string, number[]>();

	public constructor(options: GateOptions) {
		this.client = options.client;
		this.policy = options.policy;
		this.logger = options.logger ?? silentLogger;
		this.loader =
			options.loader ??
			new FactsLoader({ client: this.client, policy: this.policy, logger: this.logger });
		this.maxRefillPages = options.maxRefillPages ?? 3;
		this.placementDecides = placementDecidesFor(this.policy);
	}

	/** Runs a request through the policy and Asana; refusals and Asana errors become responses. */
	public async execute(request: GateRequest, options: ExecuteOptions = {}): Promise<GateResponse> {
		try {
			return await this.run(request, options);
		} catch (error) {
			if (error instanceof GateError) {
				this.logger.info(
					`${request.method} ${request.path}: refused ${error.status} (${error.message})`,
				);
				return { status: error.status, body: error.toBody() };
			}
			if (error instanceof AsanaApiError) {
				return { status: error.status, body: error.toBody() };
			}
			throw error;
		}
	}

	/** Classifies and plans a request without sending it; throws a {@link GateError} when it is refused. */
	public async plan(request: GateRequest): Promise<Planned> {
		const match = matchRoute(request.method, request.path);
		if (match === undefined) {
			throw noRoute();
		}
		const context = createPlanContext({
			operationId: match.operationId,
			spec: match.spec,
			params: match.params,
			query: withOptionFields(parseQuery(request.query, request.path), request.body),
			body: dataOf(request.body),
			policy: this.policy,
			loader: this.loader,
			postProcess: (response, body) => this.postProcess(response, body),
			planner: (ctx) => ruleFor(ctx.operationId).plan(ctx),
		});
		const plan = await ruleFor(match.operationId).plan(context);
		return { match, context, plan };
	}

	/**
	 * Plans a request and evaluates every check; throws a {@link GateError}
	 * when it is refused. Permissions come first (404 for hidden objects, 403
	 * for actions not allowed), then the content constraints (400), then the
	 * limits (429) and the confirmations (428, or 403 when declined): a later
	 * refusal never reveals what an earlier one hides, nobody is asked to
	 * confirm a request that would be refused anyway, and a refused request
	 * does not count against a limit.
	 */
	public async authorize(request: GateRequest, options: ExecuteOptions = {}): Promise<Planned> {
		const planned = await this.plan(request);
		for (const check of planned.plan.checks) {
			try {
				this.enforceOne(check);
			} catch (error) {
				throw inAction(error, check.unit);
			}
		}
		const [violation] = planned.context.violations;
		if (violation !== undefined) {
			throw inAction(constraintViolation(violation.resource, violation.problems), violation.unit);
		}
		await this.enforceConstraints(planned.plan.checks, options);
		return planned;
	}

	/**
	 * How the policy treats one object, as an agent may ask: 404 when the
	 * object is invisible, otherwise the allowed actions with their reasons.
	 */
	public async explain(
		type: Resource,
		gid: string,
	): Promise<{ facts: Facts; explanation: Explanation }> {
		const loaded = await this.loader.load(type, gid);
		if (loaded === undefined || !isVisible(this.policy, loaded.facts, type)) {
			throw notFound(type, gid);
		}
		return { facts: loaded.facts, explanation: explainResource(this.policy, loaded.facts, type) };
	}

	/** Evaluates the `limit` and `confirm` clauses in force for the checked targets. */
	private async enforceConstraints(
		checks: readonly Check[],
		options: ExecuteOptions,
	): Promise<void> {
		if (!hasConstraints(this.policy)) {
			return;
		}
		const pending: PendingConfirmation[] = [];
		// Per rule and action, the units (batch actions) it applies to: a request
		// counts once, a batch once per action.
		const limits = new Map<string, { limit: EffectiveLimit; units: Set<number> }>();
		for (const check of checks) {
			const effective = constraintsFor(this.policy, check.target.facts);
			for (const action of [...check.actions, ...(check.counted ?? [])]) {
				for (const rule of effective.confirm.get(action) ?? []) {
					pending.push({
						action,
						type: check.target.type,
						gid: check.target.gid,
						...(check.target.object && { name: stringOf(check.target.object.name) }),
						ruleIndex: rule.index,
					});
				}
				for (const limit of effective.limits.get(action) ?? []) {
					const key = `${limit.rule.index}:${action}`;
					const entry = limits.get(key) ?? { limit, units: new Set<number>() };
					entry.units.add(check.unit ?? 0);
					limits.set(key, entry);
				}
			}
		}
		// Slots are taken before a person is asked, so concurrent requests
		// waiting for a confirmation cannot all pass a full limit; a declined
		// or failed confirmation gives them back.
		const releases: (() => void)[] = [];
		try {
			for (const [key, { limit, units }] of limits) {
				releases.push(this.reserve(key, limit, units.size));
			}
			if (pending.length > 0) {
				if (options.confirm === undefined) {
					throw new ConfirmationRequiredError(pending);
				}
				if (!(await options.confirm(pending))) {
					throw new ConfirmationRequiredError(pending, true);
				}
			}
		} catch (error) {
			for (const release of releases) {
				release();
			}
			throw error;
		}
	}

	/**
	 * Takes `count` slots of a limit's sliding window, refusing the request
	 * when they do not fit; resolves to the function that gives them back.
	 */
	private reserve(key: string, { rule, action, limit }: EffectiveLimit, count: number): () => void {
		const now = Date.now();
		const recent = (this.usage.get(key) ?? []).filter((at) => now - at < limit.perMs);
		if (recent.length + count > limit.max) {
			this.usage.set(key, recent);
			throw limitExceeded({ action, max: limit.max, per: limit.per, ruleIndex: rule.index });
		}
		for (let taken = 0; taken < count; taken += 1) {
			recent.push(now);
		}
		this.usage.set(key, recent);
		return () => {
			const current = this.usage.get(key) ?? [];
			for (let given = 0; given < count; given += 1) {
				const at = current.indexOf(now);
				if (at !== -1) {
					current.splice(at, 1);
				}
			}
		};
	}

	private enforceOne(check: Check): void {
		const { target } = check;
		if (!isVisible(this.policy, target.facts, target.type)) {
			throw notFound(target.type, target.gid);
		}
		for (const action of check.actions) {
			if (!isAllowed(this.policy, target.facts, action)) {
				throw forbidden(action, target.type, target.gid);
			}
		}
		if (check.fields === undefined || check.fields.keys.length === 0) {
			return;
		}
		const allowlist = fieldAllowlist(this.policy, target.facts, check.fields.resource);
		if (allowlist === undefined) {
			return;
		}
		const denied = check.fields.keys.find((key) => !allowlist.has(key));
		if (denied !== undefined) {
			throw forbiddenField(check.fields.resource, denied, allowlist);
		}
	}

	private async run(request: GateRequest, options: ExecuteOptions): Promise<GateResponse> {
		const { match, context, plan } = await this.authorize(request, options);
		if (plan.answer !== undefined) {
			// Planning read what the request asks for, afresh; sending it would read it again.
			return { status: 200, body: await this.postProcess(plan.response, plan.answer) };
		}
		const query: Record<string, QueryValue> = { ...context.query };
		const optFields = augmentOptFields(
			plan.response,
			fieldsNamed(context.query.opt_fields),
			(type) => this.loader.requiredFields(type),
		);
		if (optFields !== undefined) {
			query.opt_fields = optFields;
		}
		const path = fillPath(match.spec.path, match.params);
		const send = (offset?: string, limit?: number): Promise<AsanaResponse> =>
			this.client.request({
				method: request.method,
				path,
				query:
					offset === undefined
						? query
						: { ...query, offset, ...(limit !== undefined && { limit }) },
				...(request.multipart && { multipart: shapedForm(request.multipart, plan.data) }),
				...(request.multipart === undefined &&
					WRITE_METHODS.has(request.method) && { data: plan.data ?? context.body }),
			});
		const response = await send();
		for (const stale of plan.invalidate ?? []) {
			this.loader.invalidate(stale.type, stale.gid);
		}
		const body = await this.postProcess(plan.response, response.body, {
			...(request.method === "GET" && { refill: send }),
			...(Number(context.query.limit) > 0 && { limit: Number(context.query.limit) }),
		});
		return { status: response.status, body };
	}

	private postProcess(
		response: ResponsePlan,
		body: Record<string, unknown>,
		options: ListOptions = {},
	): Promise<Record<string, unknown>> {
		switch (response.kind) {
			case "raw": {
				return Promise.resolve(body);
			}
			case "custom": {
				return response.transform(body);
			}
			case "item": {
				return this.processItem(response, body);
			}
			case "list": {
				return this.processList(response, body, options);
			}
			default: {
				return Promise.resolve(body);
			}
		}
	}

	private async processItem(
		response: ItemPlan,
		body: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		if (!isObject(body.data)) {
			return body;
		}
		const facts = response.facts ?? (await this.loader.fromObject(response.type, body.data));
		if (
			response.verify === true &&
			(facts === undefined || !isVisible(this.policy, facts, response.type))
		) {
			throw notFound(response.type, stringOf(body.data.gid) ?? "");
		}
		const ancestors =
			response.loaded === undefined ? NO_ANCESTORS : this.loader.placedAncestors(response.loaded);
		const decorated = await this.decorate(response.type, body.data, { facts, ancestors });
		if (response.selection === undefined) {
			return { ...body, data: decorated };
		}
		// What the gate asked for besides the caller's fields goes, once it has been checked.
		const data = {
			...pick(decorated, response.selection),
			allowed_actions: decorated.allowed_actions,
		};
		return { ...body, data };
	}

	private async processList(
		response: ListPlan,
		body: Record<string, unknown>,
		options: ListOptions,
	): Promise<Record<string, unknown>> {
		if (!Array.isArray(body.data)) {
			return body;
		}
		const target = options.limit ?? body.data.length;
		const state = {
			items: await this.filterItems(response, body.data),
			nextPage: body.next_page,
			pages: 0,
		};
		const more = async (): Promise<void> => {
			const offset = offsetOf(state.nextPage);
			if (
				options.refill === undefined ||
				offset === undefined ||
				state.items.length >= target ||
				state.pages >= this.maxRefillPages
			) {
				return;
			}
			state.pages += 1;
			// Ask for what is missing only, so a refilled page never holds more than asked for.
			const page = await options.refill(offset, target - state.items.length);
			state.nextPage = page.body.next_page;
			const extra = await this.filterItems(response, Array.isArray(page.data) ? page.data : []);
			state.items = [...state.items, ...extra];
			await more();
		};
		await more();
		return {
			...body,
			data: state.items,
			...(state.nextPage !== undefined && { next_page: state.nextPage }),
		};
	}

	private async filterItems(response: ListPlan, items: readonly unknown[]): Promise<AsanaObject[]> {
		const decorated = await Promise.all(items.map((item) => this.filterItem(response, item)));
		return decorated.filter((item): item is AsanaObject => item !== undefined);
	}

	private async filterItem(response: ListPlan, item: unknown): Promise<AsanaObject | undefined> {
		if (!isObject(item)) {
			return undefined;
		}
		const type = response.type === "mixed" ? itemTypeOf(response, item) : response.type;
		if (type === undefined) {
			return undefined;
		}
		const facts = await this.factsOfItem(response, type, item);
		if (facts === undefined || !isVisible(this.policy, facts, type)) {
			return undefined;
		}
		return this.decorate(type, item, { facts });
	}

	private async factsOfItem(
		response: ListPlan,
		type: Resource,
		item: AsanaObject,
	): Promise<Facts | undefined> {
		if (response.facts !== undefined) {
			return response.facts;
		}
		if (
			response.type !== "mixed" ||
			(response.expect?.includes(type) === true && this.loader.carries(type, item))
		) {
			return this.loader.fromObject(type, item);
		}
		const gid = stringOf(item.gid);
		if (gid === undefined) {
			return undefined;
		}
		const loaded = await this.loader.load(type, gid);
		return loaded?.facts;
	}

	/** Redacts an object, scrubs its nested references and attaches its `allowed_actions`. */
	private async decorate(
		type: Resource,
		object: AsanaObject,
		{ facts, ancestors = NO_ANCESTORS }: Judging,
	): Promise<AsanaObject> {
		if (facts === undefined) {
			return { ...object, allowed_actions: [] };
		}
		const shown = await this.scrubNested(this.redacted(type, object, facts), 0, ancestors);
		return { ...shown, allowed_actions: allowedActions(this.policy, facts, type) };
	}

	private redacted(type: Resource, object: AsanaObject, facts: Facts): AsanaObject {
		return hasConstraints(this.policy)
			? redactObject({ policy: this.policy, facts }, type, object)
			: object;
	}

	/**
	 * Removes the nested references (a subtask's `parent`, `dependencies`,
	 * `projects`, …) to objects the policy hides, and redacts the visible ones
	 * as their own policy says: a visible object never carries a hidden one.
	 */
	private async scrubNested(
		object: AsanaObject,
		depth: number,
		ancestors: ReadonlyMap<string, AsanaObject>,
	): Promise<AsanaObject> {
		if (depth >= MAX_NESTING) {
			return object;
		}
		const entries = await Promise.all(
			Object.entries(object).map(async ([key, value]) => {
				if (!Array.isArray(value)) {
					const scrubbed = await this.scrubRef(value, depth, ancestors);
					return [key, scrubbed === HIDDEN ? null : scrubbed] as const;
				}
				const items = await Promise.all(
					value.map((item: unknown) => this.scrubRef(item, depth, ancestors)),
				);
				return [key, items.filter((item) => item !== HIDDEN)] as const;
			}),
		);
		return Object.fromEntries(entries);
	}

	private async scrubRef(
		value: unknown,
		depth: number,
		ancestors: ReadonlyMap<string, AsanaObject>,
	): Promise<unknown> {
		if (!isObject(value)) {
			return value;
		}
		const type = resourceOfType(stringOf(value.resource_type));
		const gid = stringOf(value.gid);
		if (type === undefined || gid === undefined || !NESTED_TYPES.has(type)) {
			return value;
		}
		const facts = await this.nestedFacts(type, gid, this.placedTask(type, value, ancestors));
		if (facts === undefined || !isVisible(this.policy, facts, type)) {
			return HIDDEN;
		}
		return this.scrubNested(this.redacted(type, value, facts), depth + 1, ancestors);
	}

	/**
	 * A nested task with its placement, when the placement alone decides how
	 * a task shows ({@link placementDecides}): the reference itself when the
	 * caller selected the placement, else the ancestor the response's object
	 * embeds with it (the loader's fetch carries the ancestors' placement).
	 */
	private placedTask(
		type: Resource,
		value: AsanaObject,
		ancestors: ReadonlyMap<string, AsanaObject>,
	): AsanaObject | undefined {
		if (type !== "task" || !this.placementDecides) {
			return undefined;
		}
		return this.loader.carriesPlacement(value) ? value : ancestors.get(stringOf(value.gid) ?? "");
	}

	/** The facts of a nested object: from `placed`, a task carrying its placement; otherwise loaded. */
	private async nestedFacts(
		type: Resource,
		gid: string,
		placed: AsanaObject | undefined,
	): Promise<Facts | undefined> {
		if (placed !== undefined) {
			return this.loader.fromObject(type, placed);
		}
		const loaded = await this.loader.load(type, gid);
		return loaded?.facts;
	}
}

export { Gate };
export type { ConfirmHandler, ExecuteOptions, GateOptions, GateRequest, GateResponse, Planned };
