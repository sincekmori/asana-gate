// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import type { AsanaClient, AsanaResponse } from "../asana/client.ts";
import { AsanaApiError } from "../asana/errors.ts";
import type { QueryValue } from "../asana/query.ts";
import { ruleFor } from "../catalog/classification.ts";
import type { HttpMethod } from "../catalog/operation-spec.ts";
import type { Resource } from "../catalog/resources.ts";
import type { Logger } from "../log.ts";
import {
	constraintsFor,
	type EffectiveConstraints,
	type EffectiveLimit,
	hasConstraints,
} from "../policy/effective.ts";
import {
	allowedActions,
	type Explanation,
	explainResource,
	type Facts,
	isAllowed,
	isVisible,
	workspaceFacts,
} from "../policy/evaluate.ts";
import { fieldAllowlist } from "../policy/fields.ts";
import { type Policy, ruleLabel } from "../policy/types.ts";
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
import { FactsLoader, hasPlace, placedBy } from "./facts.ts";
import { type AsanaObject, isObject, resourceOfType, stringOf } from "./objects.ts";
import {
	type Check,
	createPlanContext,
	dataOf,
	type Plan,
	type PlanContext,
	type ResponsePlan,
} from "./plan.ts";
import { fillPath, matchRoute, type RouteMatch } from "./router.ts";
import { askFor, pick, requestedFields, type Selection } from "./selection.ts";
import { redactObject } from "./shape.ts";

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

/** Options of {@link Passage.execute}. */
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
type CustomPlan = Extract<ResponsePlan, { kind: "custom" }>;

interface ListOptions {
	/** Fetches the page at `offset`, of at most `limit` items. */
	readonly refill?: (offset: string, limit: number) => Promise<AsanaResponse>;
	readonly limit?: number;
}

/** Marks a nested reference to a hidden object, removed from the response. */
const HIDDEN = Symbol("hidden");

/** Whether showing `before` as `shown` took a reference out: the member itself, or an item of its list. */
const lostReference = (before: unknown, shown: unknown): boolean =>
	shown === HIDDEN ||
	(Array.isArray(before) && Array.isArray(shown) && shown.length < before.length);

/** Ancestors known with their placement, by gid: none. */
const NO_ANCESTORS: ReadonlyMap<string, AsanaObject> = new Map();

/** What an answer shows of an object, and what the references nested in it are judged by. */
interface Shown {
	/** The facts of the object that nests them, which tell those of the project and section it is in ({@link placedBy}). */
	readonly facts?: Facts | undefined;
	/** The ancestors known with their placement, by gid ({@link FactsLoader.placedAncestors}). */
	readonly ancestors?: ReadonlyMap<string, AsanaObject>;
	/** The fields kept (the gate asked for more); everything without one. */
	readonly selection?: Selection | undefined;
}

/** What an object a response shows is judged by, and what the answer keeps of it. */
interface Judging extends Shown {
	/** The object's own facts; `undefined` when none could be derived. */
	readonly facts: Facts | undefined;
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

/** The `options.fields` of an enveloped body, which Asana reads like `opt_fields`. */
function optionFieldsOf(body: unknown): string[] {
	const options =
		isObject(body) && isObject(body.data) && isObject(body.options) ? body.options : {};
	const fields: unknown[] = Array.isArray(options.fields) ? options.fields : [];
	return fields.filter((field): field is string => typeof field === "string");
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

/** The type of an item of a mixed list: the one it names, or the only one the list expects. */
function itemTypeOf(response: ListPlan, item: AsanaObject): Resource | undefined {
	const [only, ...others] = response.expect ?? [];
	return resourceOfType(stringOf(item.resource_type)) ?? (others.length === 0 ? only : undefined);
}

/** A body as its plan transforms it, each object cut back to the fields kept when the gate asked for more. */
async function transformed(
	response: CustomPlan,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const answer = await response.transform(body);
	const { selection } = response;
	if (selection === undefined || !Array.isArray(answer.data)) {
		return answer;
	}
	const cut = (item: unknown): unknown => (isObject(item) ? pick(item, selection) : item);
	return { ...answer, data: answer.data.map((item: unknown) => cut(item)) };
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

/** What the requests of one gate share. */
interface Shared {
	readonly policy: Policy;
	readonly client: AsanaClient;
	readonly logger: Logger;
	readonly maxRefillPages: number;
	/** Whether a nested task's placement decides how it shows ({@link placementDecidesFor}). */
	readonly placementDecides: boolean;
	/** Request timestamps per rate limit (`rules[i]:action`), for `limit` clauses: all a gate keeps between requests. */
	readonly usage: Map<string, number[]>;
}

/**
 * One request on its way through the gate: it is classified, what it
 * touches is placed, the policy is evaluated, the request is forwarded to
 * Asana, and the response is shaped so that invisible objects never appear
 * in it. What it learns from Asana on the way is its own ({@link
 * FactsLoader}), so every request is judged by what Asana says then.
 */
class Passage {
	private readonly policy: Policy;
	private readonly client: AsanaClient;
	private readonly logger: Logger;
	private readonly maxRefillPages: number;
	private readonly placementDecides: boolean;
	private readonly usage: Map<string, number[]>;
	private readonly loader: FactsLoader;

	public constructor(shared: Shared) {
		this.policy = shared.policy;
		this.client = shared.client;
		this.logger = shared.logger;
		this.maxRefillPages = shared.maxRefillPages;
		this.placementDecides = shared.placementDecides;
		this.usage = shared.usage;
		this.loader = new FactsLoader(shared);
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
			scrub: (object) => this.scrubNested(object),
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
	 * object is invisible, otherwise the allowed actions with their reasons
	 * and the constraints in force where it is.
	 */
	public async explain(
		type: Resource,
		gid: string,
	): Promise<{ facts: Facts; explanation: Explanation; constraints: EffectiveConstraints }> {
		const loaded = await this.loader.load(type, gid);
		if (loaded === undefined || !isVisible(this.policy, loaded.facts, type)) {
			throw notFound(type, gid);
		}
		const { facts } = loaded;
		return {
			facts,
			explanation: explainResource(this.policy, facts, type),
			constraints: constraintsFor(this.policy, facts),
		};
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
					const key = `${limit.rule.layer}:${limit.rule.index}:${action}`;
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
			throw limitExceeded({
				action,
				max: limit.max,
				per: limit.per,
				rule: ruleLabel(this.policy, rule),
			});
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
		const { optFields, response: asked } = askFor(
			plan.response,
			requestedFields(context.query.opt_fields),
			(type) => this.loader.requiredFields(type),
		);
		if (plan.answer !== undefined) {
			// Planning read what the request asks for, afresh; sending it would read it again.
			return { status: 200, body: await this.postProcess(asked, plan.answer) };
		}
		const query: Record<string, QueryValue> = { ...context.query };
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
		// Once a request has written, what it learned before no longer holds: of the object
		// written, and of all that takes its place from it. A write can reach Asana although
		// its response is an error (a 5xx after the change).
		const response = await send().finally(() => {
			if (request.method !== "GET") {
				this.loader.forget();
			}
		});
		const body = await this.postProcess(asked, response.body, {
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
				return transformed(response, body);
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
		const { selection } = response;
		return {
			...body,
			data: await this.decorate(response.type, body.data, { facts, ancestors, selection }),
		};
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
		return this.decorate(type, item, { facts, selection: response.selection });
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

	/**
	 * An object as its answer shows it: redacted, its nested references
	 * scrubbed, cut back to the fields kept, with its `allowed_actions`. The
	 * cut follows the check, which tells a reference by the `resource_type`
	 * the gate asked for.
	 */
	private async decorate(
		type: Resource,
		object: AsanaObject,
		{ facts, ancestors = NO_ANCESTORS, selection }: Judging,
	): Promise<AsanaObject> {
		if (facts === undefined) {
			return { ...pick(object, selection), allowed_actions: [] };
		}
		const checked = await this.scrubNested(this.redacted(type, object, facts), {
			facts,
			ancestors,
			selection,
		});
		return {
			...pick(checked, selection),
			allowed_actions: allowedActions(this.policy, facts, type),
		};
	}

	private redacted(type: Resource, object: AsanaObject, facts: Facts): AsanaObject {
		return hasConstraints(this.policy)
			? redactObject({ policy: this.policy, facts }, type, object)
			: object;
	}

	/**
	 * Removes the nested references (a subtask's `parent`, `dependencies`,
	 * the project of a membership, a value of a `reference` custom field, …)
	 * to objects the policy hides, however deep they are nested, and redacts
	 * the visible ones as their own policy says: a visible object never
	 * carries a hidden one. An object that loses a reference loses its
	 * `display_value` too, the text in which Asana names what it holds.
	 */
	private async scrubNested(object: AsanaObject, shown: Shown = {}): Promise<AsanaObject> {
		const { selection } = shown;
		// What the answer leaves out is not loaded to be checked; the references a `display_value` names are.
		const checked = (key: string): boolean =>
			selection === undefined ||
			selection.has(key) ||
			(key === "reference_value" && selection.has("display_value"));
		const entries = await Promise.all(
			Object.entries(object).map(async ([key, value]) => {
				const inside = selection?.get(key);
				const within = { ...shown, selection: inside?.size === 0 ? undefined : inside };
				return [key, checked(key) ? await this.scrub(value, within) : value] as const;
			}),
		);
		const lost = entries.some(([key, value]) => lostReference(object[key], value));
		return Object.fromEntries(
			entries.map(([key, value]) => [
				key,
				value === HIDDEN || (lost && key === "display_value") ? null : value,
			]),
		);
	}

	/** A value of a response as an answer shows it; {@link HIDDEN} for a reference to a hidden object. */
	private async scrub(value: unknown, shown: Shown): Promise<unknown> {
		if (Array.isArray(value)) {
			const items = await Promise.all(value.map((item: unknown) => this.scrub(item, shown)));
			return items.filter((item) => item !== HIDDEN);
		}
		if (!isObject(value)) {
			return value;
		}
		const type = resourceOfType(stringOf(value.resource_type));
		if (type === undefined || stringOf(value.gid) === undefined) {
			// No object the policy knows, but it may hold some (a membership, an event's change).
			return this.scrubNested(value, shown);
		}
		if (!hasPlace(type)) {
			// At workspace level an object is part of what names it (a task's assignee, its tags): it stays.
			const facts = workspaceFacts(this.policy.workspace);
			return this.scrubNested(this.redacted(type, value, facts), shown);
		}
		const facts = await this.nestedFacts(type, value, shown);
		if (facts === undefined || !isVisible(this.policy, facts, type)) {
			return HIDDEN;
		}
		return this.scrubNested(this.redacted(type, value, facts), { ...shown, facts });
	}

	/**
	 * A nested task with its placement, when the placement alone decides how
	 * a task shows ({@link placementDecides}): the reference itself when the
	 * caller selected the placement, else the ancestor the response's object
	 * embeds with it (the loader's fetch carries the ancestors' placement).
	 */
	private placedTask(
		value: AsanaObject,
		ancestors: ReadonlyMap<string, AsanaObject>,
	): AsanaObject | undefined {
		if (!this.placementDecides) {
			return undefined;
		}
		return this.loader.carriesPlacement(value) ? value : ancestors.get(stringOf(value.gid) ?? "");
	}

	/**
	 * The facts of a nested object that has a place: those the object that
	 * nests it was judged by, when they tell (the project and the section a
	 * task is in); from the object itself when the answer carries what they
	 * derive from (a task's placement, the task a story is on); otherwise
	 * loaded.
	 */
	private async nestedFacts(
		type: Resource,
		value: AsanaObject,
		shown: Shown,
	): Promise<Facts | undefined> {
		const known = shown.facts === undefined ? undefined : placedBy(shown.facts, type, value);
		if (known !== undefined) {
			return known;
		}
		const ancestors = shown.ancestors ?? NO_ANCESTORS;
		const own = this.loader.carries(type, value) ? value : undefined;
		const carried = type === "task" ? this.placedTask(value, ancestors) : own;
		if (carried !== undefined) {
			return this.loader.fromObject(type, carried);
		}
		const loaded = await this.loader.load(type, stringOf(value.gid) ?? "");
		return loaded?.facts;
	}
}

export { Passage, placementDecidesFor };
export type { ConfirmHandler, ExecuteOptions, GateRequest, GateResponse, Planned, Shared };
