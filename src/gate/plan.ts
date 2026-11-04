// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import type { OperationSpec } from "../catalog/operation-spec.ts";
import type { OperationId } from "../catalog/operations.gen.ts";
import type { Action, Resource } from "../catalog/resources.ts";
import { type Facts, isVisible, workspaceFacts } from "../policy/evaluate.ts";
import type { Policy } from "../policy/types.ts";
import { badRequest, notFound } from "./errors.ts";
import { type FactsLoader, type Loaded, readOperationOf } from "./facts.ts";
import { type AsanaObject, gidOf, gidsOf, isObject } from "./objects.ts";
import { parseOptFields, type Selection } from "./selection.ts";
import { shapeBody } from "./shape.ts";

/** An object the request acts on, with its facts resolved. */
interface Target {
	readonly type: Resource;
	readonly gid: string;
	readonly facts: Facts;
	/** The object as loaded, when it was fetched. */
	readonly object?: AsanaObject;
}

/** One authorization requirement of a request. */
interface Check {
	readonly target: Target;
	/** Actions that must all be allowed on the target (its visibility is always required). */
	readonly actions: readonly Action[];
	/** Body keys to validate against the policy's field allowlist for `<resource>:update`. */
	readonly fields?: { readonly resource: Resource; readonly keys: readonly string[] };
	/** In a batch, the index of the action the check belongs to (refusals name it; limits count each action). */
	readonly unit?: number;
	/**
	 * Actions whose `limit` and `confirm` apply to the request although their
	 * permission is decided per item (the reads of a filtered list).
	 */
	readonly counted?: readonly Action[];
}

/** How the Asana response is post-processed. */
type ResponsePlan =
	/** Pass the body through unchanged. */
	| { readonly kind: "raw" }
	/**
	 * `data` is one object of `type`: attach `allowed_actions`. With `facts`
	 * the object's facts are already known; with `verify` an invisible object
	 * becomes a 404 (for lookups that could not be authorized up front).
	 * With `loaded`, the object as the loader fetched it to authorize the
	 * request, references to the ancestors it embeds with their placement
	 * are judged by that placement instead of being loaded.
	 */
	| {
			readonly kind: "item";
			readonly type: Resource;
			readonly facts?: Facts;
			readonly verify?: boolean;
			readonly loaded?: AsanaObject;
			/** The caller's `opt_fields`, which the object is cut back to once checked (the gate asked for more). */
			readonly selection?: Selection;
	  }
	/**
	 * `data` is a list of objects of `type` (or of mixed types): drop invisible
	 * ones, attach `allowed_actions`. The items of a mixed list expected to be
	 * of the `expect` types are asked for what their facts need and judged by
	 * themselves; one that lacks it (Asana may not honour a selection on every
	 * path) is loaded by gid, like every item of a list that expects nothing.
	 */
	| {
			readonly kind: "list";
			readonly type: Resource | "mixed";
			readonly facts?: Facts;
			readonly expect?: readonly Resource[];
	  }
	/** Custom handling of the whole body. */
	| {
			readonly kind: "custom";
			readonly transform: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
	  };

/** Everything the gate needs to authorize, send and post-process one request. */
interface Plan {
	readonly checks: readonly Check[];
	readonly response: ResponsePlan;
	/** Objects whose cached state is stale after the request succeeds. */
	readonly invalidate?: readonly { readonly type: Resource; readonly gid: string }[];
	/** Body to send instead of the caller's. */
	readonly data?: unknown;
	/** Asana's response, already read while planning: the request is not sent, and this is answered instead. */
	readonly answer?: Record<string, unknown>;
}

/** What {@link PlanContext.read} found: the target, and Asana's answer to the request when it read that. */
interface Read {
	readonly target: Target;
	readonly answer?: {
		readonly body: Record<string, unknown>;
		/** The object whose embedded ancestors carry their placement (the loader's fetch of it). */
		readonly placement?: AsanaObject;
		readonly selection?: Selection;
	};
}

/** A request body that breaks the constraints in force for its target. */
interface ShapeViolation {
	readonly resource: Resource;
	readonly problems: readonly string[];
	/** In a batch, the index of the action whose body breaks the constraints. */
	readonly unit?: number;
}

/** One request as the planners see it. */
interface PlanInputs {
	readonly operationId: OperationId;
	readonly spec: OperationSpec;
	readonly params: Readonly<Record<string, string>>;
	readonly query: Readonly<Record<string, string>>;
	/** The request's `data` object (`{}` when there is none). */
	readonly body: Readonly<Record<string, unknown>>;
	readonly policy: Policy;
	readonly loader: FactsLoader;
	/** Post-processes a response body according to a response plan (supplied by the gate). */
	readonly postProcess: (
		response: ResponsePlan,
		body: Record<string, unknown>,
	) => Promise<Record<string, unknown>>;
}

/** The request a classification entry plans for, with what it can ask of the gate. */
interface PlanContext extends PlanInputs {
	/**
	 * Loads a target of `type`; 404 when `gid` is missing, when the object
	 * cannot be loaded, and when the policy hides it, so a hidden object
	 * refuses a request exactly where a nonexistent one would.
	 */
	anchor(type: Resource, gid: string | undefined): Promise<Target>;
	/**
	 * {@link anchor} for a request that reads the object itself (its type's
	 * own GET by gid): the object is read afresh with the request's
	 * `opt_fields` and what its facts need, and `answer` is Asana's response,
	 * to serve instead of sending the request. Without `answer` (another
	 * operation, or fields that are not plain paths), the request is sent.
	 */
	read(type: Resource, gid: string | undefined): Promise<Read>;
	/** Loads a target whose type is unknown, trying `types` in order; 404 when none exists or it is hidden. */
	probe(gid: string | undefined, types: readonly Resource[]): Promise<Target>;
	/** The governed workspace as a target; 404 when `gid` names another workspace. */
	workspace(gid?: string): Target;
	/** A gid from the body, given as a string or a `{ gid }` object. */
	bodyGid(field: string): string | undefined;
	/** Gids from a body list member. */
	bodyGids(field: string): string[];
	/**
	 * Shapes the request body (or `body`) for creating or updating an object
	 * of `resource` whose facts are `facts`: applies the policy's `apply`
	 * rules and records a violation when `require` or `forbid` is not met.
	 * The gate refuses the request for it once the permissions are checked.
	 */
	shape(
		facts: Facts,
		target: { resource: Resource; verb: "create" | "update" },
		body?: Readonly<Record<string, unknown>>,
	): Record<string, unknown>;
	/** The violations {@link shape} recorded, shared with the contexts of sub-requests. */
	readonly violations: readonly ShapeViolation[];
	/** Plans another operation with this context's policy and loader (used by the Batch API). */
	planSub(
		inputs: Pick<PlanContextInputs, "operationId" | "spec" | "params" | "query" | "body" | "unit">,
	): Promise<Plan>;
}

/** Inputs of {@link createPlanContext}. */
interface PlanContextInputs extends PlanInputs {
	/** Plans a request for its operation (the gate supplies the classification lookup). */
	readonly planner: (context: PlanContext) => Promise<Plan>;
	/** The list violations are recorded in (a sub-request shares its parent's). */
	readonly violations?: ShapeViolation[];
	/** For a sub-request of a batch, the index of its action. */
	readonly unit?: number;
}

/** The gid a request names for a target of `type`; 400 when it names none. */
function given(type: string, gid: string | undefined): string {
	if (gid === undefined || gid === "") {
		throw badRequest(`${type}: Missing input`);
	}
	return gid;
}

/** Builds the context a classification entry plans against. */
function createPlanContext(inputs: PlanContextInputs): PlanContext {
	const { planner, violations: shared, unit, ...request } = inputs;
	const { policy, loader } = request;
	const violations = shared ?? [];
	/** The target `loaded` is, when the policy lets the request see it; 404 otherwise. */
	const visible = (type: Resource, gid: string, loaded: Loaded | undefined): Target => {
		if (loaded === undefined || !isVisible(policy, loaded.facts, type)) {
			throw notFound(type, gid);
		}
		return { type, gid, facts: loaded.facts, object: loaded.object };
	};
	return {
		...request,
		async anchor(type, gid) {
			const named = given(type, gid);
			return visible(type, named, await loader.load(type, named));
		},
		async read(type, gid) {
			const named = given(type, gid);
			const { fields, selection } = parseOptFields(request.query.opt_fields);
			if (readOperationOf(type) !== request.operationId || (fields.length > 0 && !selection)) {
				return { target: visible(type, named, await loader.load(type, named)) };
			}
			const loaded = await loader.read(type, named, selection);
			const target = visible(type, named, loaded);
			const placement = loaded?.fetched ?? loaded?.object;
			const body = { data: target.object };
			return {
				target,
				answer: { body, ...(placement && { placement }), ...(selection && { selection }) },
			};
		},
		async probe(gid, types) {
			const label = types[0] ?? "object";
			const named = given(label, gid);
			const loaded = await loader.probe(named, types);
			if (loaded === undefined) {
				throw notFound(label, named);
			}
			return visible(loaded.type, named, loaded);
		},
		workspace(gid) {
			if (gid !== undefined && gid !== policy.workspace) {
				throw notFound("workspace", gid);
			}
			return { type: "workspace", gid: policy.workspace, facts: workspaceFacts(policy.workspace) };
		},
		bodyGid(field) {
			return gidOf(request.body[field]);
		},
		bodyGids(field) {
			return gidsOf(request.body[field]);
		},
		shape(facts, target, body) {
			const shaped = shapeBody({ policy, facts }, target, { ...(body ?? request.body) });
			if (shaped.problems.length > 0) {
				violations.push({
					resource: target.resource,
					problems: shaped.problems,
					...(unit !== undefined && { unit }),
				});
			}
			return shaped.data;
		},
		violations,
		// The sub-context shares `violations`, so what the action violates is the request's.
		planSub: (subInputs) => planner(createPlanContext({ ...inputs, ...subInputs, violations })),
	};
}

/**
 * Parses a request body into its `data` object: a bare object, or Asana's
 * envelope `{ data, options }`; an envelope with other members is refused,
 * since Asana would read only its `data`.
 */
function dataOf(body: unknown): Record<string, unknown> {
	if (!isObject(body)) {
		return {};
	}
	if (!isObject(body.data)) {
		return body;
	}
	const others = Object.keys(body).filter((key) => key !== "data" && key !== "options");
	if (others.length > 0) {
		throw badRequest(
			`body: expected the data object, or { data, options } (also given: ${others.join(", ")})`,
		);
	}
	return body.data;
}

/** The `options.fields` of an enveloped body, which Asana reads like `opt_fields`. */
function optionFieldsOf(body: unknown): string[] {
	const options =
		isObject(body) && isObject(body.data) && isObject(body.options) ? body.options : {};
	const fields: unknown[] = Array.isArray(options.fields) ? options.fields : [];
	return fields.filter((field): field is string => typeof field === "string");
}

export { createPlanContext, dataOf, optionFieldsOf };
export type {
	Check,
	Plan,
	PlanContext,
	PlanContextInputs,
	Read,
	ResponsePlan,
	ShapeViolation,
	Target,
};
