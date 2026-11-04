// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import type { AsanaClient } from "../asana/client.ts";
import { AsanaApiError, isAbsent } from "../asana/errors.ts";
import { READ_OPERATIONS } from "../catalog/object-operations.ts";
import { type OperationId, OPERATIONS } from "../catalog/operations.gen.ts";
import { RESOURCES, type Resource } from "../catalog/resources.ts";
import { RESPONSE_SCHEMAS } from "../catalog/schemas.gen.ts";
import { type Logger, silentLogger } from "../log.ts";
import {
	type Branch,
	type Facts,
	type ObjectState,
	WORKSPACE_BRANCH,
	workspaceFacts,
} from "../policy/evaluate.ts";
import { needsTaskChain, portfoliosNamed } from "../policy/scope.ts";
import type { CompiledWhere, Policy } from "../policy/types.ts";
import { TtlCache } from "./cache.ts";
import {
	type AsanaObject,
	gidOf,
	gidsOf,
	isObject,
	type Ref,
	refOf,
	refsOf,
	resourceOfType,
	stringOf,
} from "./objects.ts";
import { PortfolioIndex } from "./portfolio-index.ts";
import {
	fieldsOf,
	parseSelection,
	type Selection,
	widenSelection,
	withReferenceTypes,
} from "./selection.ts";

/** How deep the parent chain of a subtask is followed (Asana nests subtasks up to 5 levels). */
const MAX_PARENT_DEPTH = 5;

/** `parent.`, `parent.parent.`, … up to {@link MAX_PARENT_DEPTH}. */
const ANCESTOR_PREFIXES: readonly string[] = Array.from({ length: MAX_PARENT_DEPTH }, (_, depth) =>
	"parent.".repeat(depth + 1),
);

/**
 * Which facts of a task the policy reads: a rule's `where` is the only
 * reader, so a fact no rule names is neither asked of Asana nor derived.
 * `asana-gate explain` shows them all.
 */
/** The members of a task's custom fields that {@link customFieldValues} reads. */
const CUSTOM_FIELD_MEMBERS: readonly string[] = [
	"custom_fields.gid",
	"custom_fields.display_value",
	"custom_fields.enum_value.gid",
	"custom_fields.enum_value.name",
	"custom_fields.multi_enum_values.gid",
	"custom_fields.multi_enum_values.name",
];

/** A fact of a task a rule's `where` may name, and the members it is derived from. */
interface TaskFact {
	readonly named: (where: CompiledWhere) => boolean;
	readonly fields: readonly string[];
}

/** Every such fact, in the order their members are asked for. */
const TASK_FACTS = {
	completed: { named: (where) => where.completed !== undefined, fields: ["completed"] },
	createdBy: { named: (where) => where.createdBy !== undefined, fields: ["created_by"] },
	createdAt: { named: (where) => where.createdWithinMs !== undefined, fields: ["created_at"] },
	due: {
		named: (where) => where.overdue !== undefined || where.dueWithinMs !== undefined,
		fields: ["due_on", "due_at"],
	},
	tags: { named: (where) => where.tags !== undefined, fields: ["tags"] },
	assignee: { named: (where) => where.assignees !== undefined, fields: ["assignee"] },
	customFields: {
		named: (where) => (where.customFields?.length ?? 0) > 0,
		fields: CUSTOM_FIELD_MEMBERS,
	},
	// The team comes with the placement (`memberships.project.team`); see taskFields.
	team: { named: (where) => where.teams !== undefined, fields: [] },
} as const satisfies Record<string, TaskFact>;

type TaskFactName = keyof typeof TASK_FACTS;

type TaskNeeds = Readonly<Record<TaskFactName, boolean>>;

const TASK_FACT_NAMES = Object.keys(TASK_FACTS) as TaskFactName[];

const needsWhere = (needed: (name: TaskFactName) => boolean): TaskNeeds =>
	Object.fromEntries(TASK_FACT_NAMES.map((name) => [name, needed(name)])) as TaskNeeds;

const EVERY_TASK_FACT = needsWhere(() => true);

function taskNeedsOf(policy: Policy): TaskNeeds {
	return needsWhere((name) => policy.rules.some((rule) => TASK_FACTS[name].named(rule.where)));
}

/** The `opt_fields` the loader needs on a task to derive the facts in `needs`. */
function taskFields(needs: TaskNeeds): string[] {
	const placement = (prefix: string): string[] => [
		`${prefix}memberships.project`,
		`${prefix}memberships.section`,
		// The project's team in the same response (honoured on GET /tasks/{gid} and
		// typeahead; verified live), so placing a task costs no request per project.
		...(needs.team ? [`${prefix}memberships.project.team`] : []),
	];
	return [
		"name",
		"workspace",
		"parent",
		...placement(""),
		...TASK_FACT_NAMES.flatMap((name) => (needs[name] ? TASK_FACTS[name].fields : [])),
		// The ancestor chain with each ancestor's placement, in the same response
		// (nested `parent.…` selections work; verified live). A subtask's facts then
		// cost no extra request.
		...ANCESTOR_PREFIXES.flatMap((prefix) => placement(prefix)),
	];
}

/** Per resource, the `opt_fields` {@link FactsLoader.fromObject} needs. */
const REQUIRED_FIELDS: Partial<Record<Resource, readonly string[]>> = {
	// Tasks: see taskFields.
	// `name` too: a `where: { name }` filter applies to projects and sections.
	project: ["name", "workspace", "team"],
	section: ["name", "project"],
	portfolio: ["workspace"],
	team: ["organization"],
	goal: ["workspace", "team"],
	story: ["target"],
	attachment: ["parent"],
	status_update: ["parent"],
	project_brief: ["project"],
	webhook: ["resource"],
	time_tracking_entry: ["task"],
	allocation: ["parent"],
	budget: ["parent"],
	rate: ["parent"],
	task_template: ["project"],
	project_template: ["team"],
	goal_relationship: ["supported_goal"],
	membership: ["parent"],
	project_membership: ["parent"],
	portfolio_membership: ["portfolio"],
	team_membership: ["team"],
	workspace_membership: ["workspace"],
	project_portfolio_setting: ["project"],
	tag: ["workspace"],
	user: ["workspaces"],
	user_task_list: ["workspace"],
	table: ["workspace"],
	record: ["workspace"],
	role: ["workspace"],
	timesheet_approval_status: ["workspace"],
	agent: ["workspace"],
};

/** Response schemas to use instead of the read operation's. */
const SCHEMA_OVERRIDES: Partial<Record<Resource, string>> = {
	// The full object names its project `project`; the compact one (lists) names it `parent`, which the gate requests.
	project_membership: "ProjectMembershipCompact",
};

/** The operation that reads one object of `type` by gid, where the loader fetches it. */
function readOperationOf(type: Resource): OperationId | undefined {
	return READ_OPERATIONS[type];
}

/** The `GET /<path>/{gid}` of a resource, as the path prefix; `undefined` when it has none. */
function objectPath(type: Resource): string | undefined {
	const id = READ_OPERATIONS[type];
	return id === undefined ? undefined : OPERATIONS[id].path.replace(/\/\{[^}]+\}$/u, "");
}

/** The OpenAPI response schema that describes a resource's objects, when the catalog names one. */
function responseSchemaOf(type: Resource): string | undefined {
	const id = READ_OPERATIONS[type];
	return (
		SCHEMA_OVERRIDES[type] ?? (id === undefined ? undefined : (RESPONSE_SCHEMAS[id] ?? undefined))
	);
}

/**
 * The `opt_fields` a list or object response of `type` must carry for
 * {@link FactsLoader.fromObject} to derive the task facts in `needs` (by
 * default, all of them).
 */
function requiredFields(type: Resource, needs: TaskNeeds = EVERY_TASK_FACT): readonly string[] {
	return type === "task" ? taskFields(needs) : (REQUIRED_FIELDS[type] ?? []);
}

/** A member the gate reads from objects of a resource, and the response schema that describes it. */
interface ReliedMember {
	readonly resource: Resource;
	readonly schema: string;
	readonly member: string;
	/** The member read inside it (`memberships.project` reads `project`), if any. */
	readonly nested: string | undefined;
}

/** Every member the gate reads, for each resource whose objects a response schema describes. */
function reliedMembers(): ReliedMember[] {
	return RESOURCES.flatMap((resource) => {
		const schema = responseSchemaOf(resource);
		return schema === undefined
			? []
			: requiredFields(resource).map((field) => {
					const [member = field, nested] = field.split(".");
					return { resource, schema, member, nested };
				});
	});
}

/** Types a `parent`-like reference of unknown type is probed as. */
const PARENT_TYPES: readonly Resource[] = ["project", "portfolio", "goal", "task", "project_brief"];

/**
 * Per resource that lives inside another object, the members that may name
 * its container (first present wins) and the container's possible types.
 * Every other resource lives at workspace level.
 */
const CONTAINER_MEMBERS: Partial<
	Record<Resource, { members: readonly string[]; types: readonly Resource[] }>
> = {
	story: { members: ["target"], types: ["task", "goal"] },
	attachment: { members: ["parent"], types: PARENT_TYPES },
	status_update: { members: ["parent"], types: PARENT_TYPES },
	allocation: { members: ["parent"], types: PARENT_TYPES },
	budget: { members: ["parent"], types: PARENT_TYPES },
	rate: { members: ["parent"], types: PARENT_TYPES },
	membership: { members: ["parent"], types: PARENT_TYPES },
	project_brief: { members: ["project"], types: ["project"] },
	task_template: { members: ["project"], types: ["project"] },
	project_portfolio_setting: { members: ["project"], types: ["project"] },
	webhook: { members: ["resource"], types: ["project", "task", "portfolio", "goal", "team"] },
	time_tracking_entry: { members: ["task"], types: ["task"] },
	project_template: { members: ["team"], types: ["team"] },
	goal_relationship: { members: ["supported_goal"], types: ["goal"] },
	portfolio_membership: { members: ["portfolio"], types: ["portfolio"] },
	team_membership: { members: ["team"], types: ["team"] },
	// A project membership names its project `parent` when compact and `project` when full (verified live).
	project_membership: { members: ["parent", "project"], types: ["project"] },
};

/** Options for {@link FactsLoader}. */
interface FactsLoaderOptions {
	client: AsanaClient;
	policy: Policy;
	logger?: Logger;
	/** How long a fetched object is reused, in milliseconds. */
	objectTtlMs?: number;
	/** How long a project (whose team rarely changes) is reused, in milliseconds. */
	projectTtlMs?: number;
	/** How long the portfolio contents snapshot is reused, in milliseconds. */
	portfolioTtlMs?: number;
	/** Derive every fact of a task, not only those the policy reads (for `explain`). */
	allFacts?: boolean;
}

/** A loaded object together with its resolved facts. */
interface Loaded {
	readonly type: Resource;
	readonly object: AsanaObject;
	readonly facts: Facts;
	/** The loader's own fetch of the object, when `object` is a read of it with other fields. */
	readonly fetched?: AsanaObject;
}

/** One project a task belongs to, and the section within it. */
interface Membership {
	readonly project: string;
	readonly section: string | undefined;
	/** The project's team when the membership embeds it (`null`: none); `undefined` when it does not. */
	readonly team?: string | null;
}

interface Placement {
	readonly chain: readonly string[];
	readonly memberships: readonly Membership[];
}

/** One object fetch: the object, its cache key, and the generation it was asked for under. */
interface Fetch {
	readonly type: Resource;
	readonly gid: string;
	readonly key: string;
	readonly generation: number;
}

/** The parent a task embeds together with its placement (`parent.memberships.*`), if any. */
function embeddedParent(task: Readonly<AsanaObject>): AsanaObject | undefined {
	return isObject(task.parent) && Array.isArray(task.parent.memberships) ? task.parent : undefined;
}

/** Whether a membership names both its project and its section, as the loader asks for them. */
function namesPlacement(membership: unknown): boolean {
	return isObject(membership) && "project" in membership && "section" in membership;
}

/** The project memberships of a task (or a task body), from its `memberships` member. */
function membershipsOf(task: Readonly<AsanaObject>): Membership[] {
	if (!Array.isArray(task.memberships)) {
		return [];
	}
	return task.memberships
		.filter((m): m is AsanaObject => isObject(m))
		.map((m) => ({
			project: gidOf(m.project),
			section: gidOf(m.section),
			...(isObject(m.project) && "team" in m.project && { team: gidOf(m.project.team) ?? null }),
		}))
		.filter((m): m is Membership => m.project !== undefined);
}

/**
 * Whether a cached task's facts derive from the object `gid`: an ancestor in
 * the parent chain it embeds, or a project its memberships (or an
 * ancestor's) name, whose team they carry.
 */
function derivesFrom(task: AsanaObject | null, gid: string): boolean {
	let node: unknown = task;
	for (let depth = 0; depth <= MAX_PARENT_DEPTH && isObject(node); depth += 1) {
		if (depth > 0 && gidOf(node) === gid) {
			return true;
		}
		if (membershipsOf(node).some((membership) => membership.project === gid)) {
			return true;
		}
		node = node.parent;
	}
	return false;
}

function customFieldValues(value: unknown): ReadonlyMap<string, ReadonlySet<string>> | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const map = new Map<string, ReadonlySet<string>>();
	for (const field of value.filter(
		(f): f is AsanaObject => isObject(f) && typeof f.gid === "string",
	)) {
		const values = new Set<string>();
		const display = stringOf(field.display_value);
		if (display !== undefined) {
			values.add(display);
		}
		const options = [refOf(field.enum_value), ...refsOf(field.multi_enum_values)];
		for (const option of options) {
			if (option !== undefined) {
				values.add(option.gid);
				if (option.name !== undefined) {
					values.add(option.name);
				}
			}
		}
		map.set(stringOf(field.gid) ?? "", values);
	}
	return map;
}

/** The state predicates can see on a task (or a task body). */
function taskState(task: Readonly<AsanaObject>): ObjectState {
	const createdBy = gidOf(task.created_by);
	const name = stringOf(task.name);
	// Asana sets `due_on` (the local date) whenever `due_at` is set; the instant is more precise.
	const dueOn = stringOf(task.due_at) ?? stringOf(task.due_on);
	const createdAt = stringOf(task.created_at);
	return {
		...(name !== undefined && { name }),
		...(createdBy !== undefined && { createdBy }),
		...(typeof task.completed === "boolean" && { completed: task.completed }),
		hasParent: gidOf(task.parent) !== undefined,
		dueOn: dueOn ?? null,
		...(createdAt !== undefined && { createdAt }),
	};
}

/**
 * Derives the facts (hierarchical placement and cross-cutting attributes) of
 * Asana objects, fetching from the API as needed and caching the results.
 */
class FactsLoader {
	private readonly client: AsanaClient;
	private readonly policy: Policy;
	private readonly logger: Logger;
	private readonly objects: TtlCache<AsanaObject | null>;
	private readonly projectTtlMs: number;
	/** Fetches under way (per object and generation, and per fields for reads), so concurrent requests share a call. */
	private readonly inflight = new Map<string, Promise<AsanaObject | undefined>>();
	/**
	 * Per object, bumped by every invalidation: a fetch that started before a
	 * write is not cached after it, and later lookups do not join it.
	 */
	private readonly generations = new Map<string, number>();
	private readonly portfolios: PortfolioIndex;
	/** Whether a rule names a task or a subtree, so a task's ancestors must be known. */
	private readonly needsTaskChain: boolean;
	private readonly needs: TaskNeeds;
	/** The `opt_fields` a task's facts need under this policy (see taskFields). */
	private readonly taskFields: readonly string[];
	private readonly members = new Map<Resource, ReadonlySet<string>>();

	public constructor(options: FactsLoaderOptions) {
		this.client = options.client;
		this.policy = options.policy;
		this.needs = options.allFacts === true ? EVERY_TASK_FACT : taskNeedsOf(options.policy);
		this.taskFields = taskFields(this.needs);
		this.logger = options.logger ?? silentLogger;
		this.objects = new TtlCache(options.objectTtlMs ?? 30_000);
		this.projectTtlMs = options.projectTtlMs ?? 300_000;
		this.needsTaskChain = needsTaskChain(this.policy);
		this.portfolios = new PortfolioIndex({
			client: this.client,
			roots: portfoliosNamed(this.policy),
			ttlMs: options.portfolioTtlMs ?? 300_000,
			logger: this.logger,
		});
	}

	/**
	 * Loads an object by gid and derives its facts. Resolves to `undefined`
	 * when Asana reports it missing or inaccessible, which the gate treats
	 * exactly like an invisible object.
	 */
	public async load(type: Resource, gid: string): Promise<Loaded | undefined> {
		if (type === "workspace") {
			return { type, object: { gid, resource_type: "workspace" }, facts: workspaceFacts(gid) };
		}
		if (objectPath(type) === undefined) {
			// No GET-by-gid exists for this type; it lives at workspace level.
			return { type, object: { gid }, facts: workspaceFacts(this.policy.workspace) };
		}
		const object = await this.fetchObject(type, gid);
		if (object === undefined) {
			return undefined;
		}
		const facts = await this.fromObject(type, object);
		return facts === undefined ? undefined : { type, object, facts };
	}

	/**
	 * Reads an object afresh to answer a request for it and to judge it, in
	 * one request: the fields sent are the caller's `selection` together with
	 * what the facts need (none, for the whole object, when the caller names
	 * none), and the object comes back as Asana sent it, for the gate to check
	 * and then cut back to the caller's selection. When the response cannot
	 * carry what the facts need (the caller selects alone a member they read
	 * inside) or does not (Asana left a member out), the facts are loaded as
	 * {@link load} does. Resolves to `undefined` when Asana reports the
	 * object missing or inaccessible.
	 */
	public async read(
		type: Resource,
		gid: string,
		selection: Selection | undefined,
	): Promise<Loaded | undefined> {
		const needed = parseSelection(["name", ...this.requiredFields(type)]) ?? new Map();
		const widened = selection === undefined ? undefined : widenSelection(selection, needed);
		const complete = widened?.complete ?? true;
		const key = `${type}:${gid}`;
		const fetch = { type, gid, key, generation: this.generations.get(key) ?? 0 };
		const sent = widened === undefined ? undefined : withReferenceTypes(fieldsOf(widened.sent));
		const derivable = (object: AsanaObject): boolean => complete && this.carries(type, object);
		// Reads of one object with the same fields under way together (a batch naming it twice)
		// share one request: it was still sent after each of them arrived.
		const flight = `${key}#${fetch.generation}?${sent?.join(",") ?? ""}`;
		const read = this.shared(flight, () => this.fetchFresh(fetch, sent, derivable));
		if (!complete) {
			// The response cannot carry what the facts need: they are loaded alongside.
			return this.besides(type, gid, read);
		}
		const object = await read;
		if (object === undefined) {
			return undefined;
		}
		if (derivable(object)) {
			const facts = await this.fromObject(type, object);
			return facts === undefined ? undefined : { type, object, facts };
		}
		return this.besides(type, gid, Promise.resolve(object));
	}

	/**
	 * The object `read` brings back, judged by the facts {@link load} derives;
	 * what the read finds (absence, an error) comes first.
	 */
	private async besides(
		type: Resource,
		gid: string,
		read: Promise<AsanaObject | undefined>,
	): Promise<Loaded | undefined> {
		const [fresh, loaded] = await Promise.allSettled([read, this.load(type, gid)]);
		if (fresh.status === "rejected") {
			throw fresh.reason;
		}
		if (fresh.value === undefined) {
			return undefined;
		}
		if (loaded.status === "rejected") {
			throw loaded.reason;
		}
		return loaded.value === undefined
			? undefined
			: { type, object: fresh.value, facts: loaded.value.facts, fetched: loaded.value.object };
	}

	/**
	 * Whether an object carries every member {@link fromObject} reads for
	 * `type` (a response may lack one whose selection Asana did not honour); a
	 * task must also carry its placement ({@link carriesPlacement}), or a
	 * membership naming no section would pass for one outside any section.
	 */
	public carries(type: Resource, object: AsanaObject): boolean {
		const members = this.topMembers(type);
		if (![...members].every((member) => member in object)) {
			return false;
		}
		return type !== "task" || this.carriesPlacement(object);
	}

	/** The `opt_fields` objects of `type` must carry for this loader (and its policy) to derive their facts. */
	public requiredFields(type: Resource): readonly string[] {
		return type === "task" ? this.taskFields : requiredFields(type);
	}

	/** The top-level members of {@link requiredFields}, worked out once per type. */
	private topMembers(type: Resource): ReadonlySet<string> {
		let members = this.members.get(type);
		if (members === undefined) {
			members = new Set(this.requiredFields(type).map((field) => field.split(".")[0] ?? field));
			this.members.set(type, members);
		}
		return members;
	}

	/**
	 * Returns the first of `types` (in their order) that exists for `gid`.
	 * The first type is tried alone, since the lists put the likely one first
	 * and a hit then costs one request; the rest are tried at once, so a miss
	 * costs one more round trip instead of one per type (the client keeps
	 * them within Asana's 50 concurrent reads). The answer, and an error,
	 * are what trying one type after another would give: an error counts only
	 * when no earlier type exists.
	 */
	public async probe(gid: string, types: readonly Resource[]): Promise<Loaded | undefined> {
		const [first, ...rest] = types;
		if (first === undefined) {
			return undefined;
		}
		const loaded = await this.loadOrUnpaid(first, gid);
		if (loaded !== undefined) {
			return loaded;
		}
		const settled = await Promise.allSettled(rest.map((type) => this.loadOrUnpaid(type, gid)));
		for (const result of settled) {
			if (result.status === "rejected") {
				throw result.reason;
			}
			if (result.value !== undefined) {
				return result.value;
			}
		}
		return undefined;
	}

	/** Loads a probe candidate; a type the workspace's plan does not offer (402) is not this object's. */
	private async loadOrUnpaid(type: Resource, gid: string): Promise<Loaded | undefined> {
		try {
			return await this.load(type, gid);
		} catch (error) {
			if (error instanceof AsanaApiError && error.status === 402) {
				return undefined;
			}
			throw error;
		}
	}

	/**
	 * Whether a task carries everything its placement derives from, so that
	 * {@link fromObject} judges it as it would the loader's own fetch of it:
	 * its memberships, each naming its project and section, and, as far as
	 * its placement follows the parent chain, a `parent` member on it and on
	 * every ancestor it embeds (`null` at the root; a parent named without
	 * its placement is fetched). A member that is not there is unknown, not
	 * empty.
	 */
	public carriesPlacement(task: Readonly<AsanaObject>, depth = 0): boolean {
		if (!Array.isArray(task.memberships) || !task.memberships.every(namesPlacement)) {
			return false;
		}
		if (!this.followsParent(membershipsOf(task), depth)) {
			return true;
		}
		if (!("parent" in task)) {
			return false;
		}
		const parent = embeddedParent(task);
		return parent === undefined || this.carriesPlacement(parent, depth + 1);
	}

	/**
	 * The ancestors a task embeds that carry their placement
	 * ({@link carriesPlacement}), by gid. The loader's own fetch of a task
	 * embeds them (`parent.…memberships.*`), so a reference to one of them
	 * is judged without a fetch of its own.
	 */
	public placedAncestors(task: Readonly<AsanaObject>): ReadonlyMap<string, AsanaObject> {
		const placed = new Map<string, AsanaObject>();
		for (let parent = embeddedParent(task); parent !== undefined; parent = embeddedParent(parent)) {
			const gid = stringOf(parent.gid);
			if (gid !== undefined && this.carriesPlacement(parent)) {
				placed.set(gid, parent);
			}
		}
		return placed;
	}

	/** Loads the object a reference points at; `fallback` types are probed when it carries no known type. */
	public loadRef(ref: Ref, fallback: readonly Resource[]): Promise<Loaded | undefined> {
		const type = resourceOfType(ref.resource_type);
		return type === undefined ? this.probe(ref.gid, fallback) : this.load(type, ref.gid);
	}

	/**
	 * Derives the facts of an already-fetched object that carries the fields
	 * of {@link requiredFields}. Resolves to `undefined` when a container the
	 * object points at cannot be loaded.
	 */
	public fromObject(type: Resource, object: AsanaObject): Promise<Facts | undefined> {
		switch (type) {
			case "task": {
				return this.taskFacts(object);
			}
			case "project": {
				return this.projectFacts(object);
			}
			case "section": {
				return this.sectionFacts(object);
			}
			case "portfolio": {
				return this.portfolioFacts(object);
			}
			case "team": {
				return Promise.resolve(this.teamFacts(object));
			}
			case "goal": {
				return Promise.resolve(this.goalFacts(object));
			}
			case "user": {
				return Promise.resolve(this.userFacts(object));
			}
			case "workspace": {
				return Promise.resolve(workspaceFacts(stringOf(object.gid) ?? this.policy.workspace));
			}
			default: {
				return this.derivedFacts(type, object);
			}
		}
	}

	/** Facts of objects that live inside another object (stories, webhooks, memberships, …) or at workspace level. */
	private derivedFacts(type: Resource, object: AsanaObject): Promise<Facts | undefined> {
		const container = CONTAINER_MEMBERS[type];
		if (container === undefined) {
			return Promise.resolve(workspaceFacts(gidOf(object.workspace) ?? this.policy.workspace));
		}
		const member = container.members.find((name) => refOf(object[name]) !== undefined);
		return this.factsOfRef(
			member === undefined ? undefined : refOf(object[member]),
			container.types,
		);
	}

	/**
	 * Forgets a cached object after it was modified. A task's cached
	 * descendants go too: they carry its placement in their ancestor chain.
	 */
	public invalidate(type: Resource, gid: string): void {
		const key = `${type}:${gid}`;
		this.objects.delete(key);
		this.bump(key);
		if (type === "task" || type === "project") {
			const dependents = this.objects.deleteWhere(
				(cachedKey, object) => cachedKey.startsWith("task:") && derivesFrom(object, gid),
			);
			for (const dependent of dependents) {
				this.bump(dependent);
			}
		}
		if (type === "portfolio") {
			this.portfolios.invalidateFor(gid);
		}
	}

	/**
	 * Records a write to `key`, so that a fetch of it under way does not cache
	 * what it brings back; with none under way there is nothing to record (the
	 * cached copy is gone), which keeps the record as small as the fetches.
	 */
	private bump(key: string): void {
		if (this.fetching(key)) {
			this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
		}
	}

	private fetching(key: string): boolean {
		return [...this.inflight.keys()].some((flight) => flight.startsWith(`${key}#`));
	}

	private fetchObject(type: Resource, gid: string): Promise<AsanaObject | undefined> {
		const key = `${type}:${gid}`;
		const cached = this.objects.get(key);
		if (cached !== undefined) {
			return Promise.resolve(cached ?? undefined);
		}
		const generation = this.generations.get(key) ?? 0;
		const fetch = { type, gid, key, generation };
		return this.shared(`${key}#${generation}`, () => this.fetchUncached(fetch));
	}

	/** The fetch under way for `flight`, or a new one: concurrent requests for one object share a call. */
	private shared(
		flight: string,
		start: () => Promise<AsanaObject | undefined>,
	): Promise<AsanaObject | undefined> {
		let pending = this.inflight.get(flight);
		if (pending === undefined) {
			pending = this.landed(flight, start());
			this.inflight.set(flight, pending);
		}
		return pending;
	}

	private async landed(
		flight: string,
		pending: Promise<AsanaObject | undefined>,
	): Promise<AsanaObject | undefined> {
		try {
			return await pending;
		} finally {
			this.inflight.delete(flight);
			const key = flight.slice(0, flight.indexOf("#"));
			if (!this.fetching(key)) {
				this.generations.delete(key);
			}
		}
	}

	private fetchUncached(fetch: Fetch): Promise<AsanaObject | undefined> {
		const fields = this.requiredFields(fetch.type);
		const sent = fields.length > 0 ? [...new Set(["name", ...fields])] : undefined;
		return this.fetchFresh(fetch, sent, () => true);
	}

	/**
	 * GETs an object with `fields` (the whole object without), and caches it,
	 * or its absence, unless a write made it stale meanwhile or it is not
	 * `cacheable`.
	 */
	private async fetchFresh(
		fetch: Fetch,
		fields: readonly string[] | undefined,
		cacheable: (object: AsanaObject) => boolean,
	): Promise<AsanaObject | undefined> {
		const { type, gid, key, generation } = fetch;
		const path = objectPath(type);
		// A gid with a lone surrogate cannot be sent, and names nothing.
		if (path === undefined || !gid.isWellFormed()) {
			return undefined;
		}
		const ttl = type === "project" ? this.projectTtlMs : undefined;
		// Cache only what no write has made stale since the fetch began.
		const keep = (value: AsanaObject | null): void => {
			if ((this.generations.get(key) ?? 0) === generation) {
				this.objects.set(key, value, ttl);
			}
		};
		try {
			const object = await this.client.get<AsanaObject>(`${path}/${encodeURIComponent(gid)}`, {
				...(fields !== undefined && { opt_fields: fields }),
			});
			if (cacheable(object)) {
				keep(object);
			}
			return object;
		} catch (error) {
			if (isAbsent(error)) {
				this.logger.debug(
					`${type} ${gid}: Asana responded ${error.status}; treating as nonexistent`,
				);
				keep(null);
				return undefined;
			}
			throw error;
		}
	}

	/** Facts of the object a reference points at (the workspace's when there is none). */
	private async factsOfRef(
		ref: Ref | undefined,
		fallback: readonly Resource[],
	): Promise<Facts | undefined> {
		if (ref === undefined) {
			return workspaceFacts(this.policy.workspace);
		}
		const loaded = await this.loadRef(ref, fallback);
		return loaded?.facts;
	}

	private async projectBranch(membership: Membership, chain: readonly string[]): Promise<Branch> {
		const [team, portfolios] = await Promise.all([
			this.teamOf(membership),
			this.portfolios.containing(membership.project),
		]);
		return {
			...(team !== undefined && { team }),
			portfolios,
			project: membership.project,
			...(membership.section !== undefined && { section: membership.section }),
			taskChain: chain,
			unhomed: false,
		};
	}

	/** Whether a task's placement takes in its parent's: it has no project of its own, or a rule names tasks. */
	private followsParent(memberships: readonly Membership[], depth: number): boolean {
		return depth < MAX_PARENT_DEPTH && (memberships.length === 0 || this.needsTaskChain);
	}

	/**
	 * The team of a task's project: from the membership when the response
	 * embeds it, otherwise from the project itself; not looked up at all when
	 * no rule names a team.
	 */
	private async teamOf(membership: Membership): Promise<string | undefined> {
		if (!this.needs.team) {
			return undefined;
		}
		if (membership.team !== undefined) {
			return membership.team ?? undefined;
		}
		const project = await this.fetchObject("project", membership.project);
		return project === undefined ? undefined : gidOf(project.team);
	}

	private async resolvePlacement(
		task: AsanaObject,
		chain: readonly string[],
		depth: number,
	): Promise<Placement> {
		const memberships = membershipsOf(task);
		const parent = gidOf(task.parent);
		if (parent === undefined || !this.followsParent(memberships, depth)) {
			return { chain, memberships };
		}
		// Prefer the parent embedded in the response; fetch only when it lacks placement data.
		const parentTask = embeddedParent(task) ?? (await this.fetchObject("task", parent));
		if (parentTask === undefined) {
			return { chain, memberships };
		}
		const inherited = await this.resolvePlacement(parentTask, [...chain, parent], depth + 1);
		return {
			chain: inherited.chain,
			memberships: memberships.length > 0 ? memberships : inherited.memberships,
		};
	}

	private async taskFacts(task: AsanaObject): Promise<Facts> {
		const gid = stringOf(task.gid) ?? "";
		const placement = await this.resolvePlacement(task, [gid], 0);
		const branches: Branch[] =
			placement.memberships.length > 0
				? await Promise.all(
						placement.memberships.map((m) => this.projectBranch(m, placement.chain)),
					)
				: [{ ...WORKSPACE_BRANCH, taskChain: placement.chain, unhomed: true }];
		const customFields = customFieldValues(task.custom_fields);
		return {
			workspace: gidOf(task.workspace) ?? this.policy.workspace,
			branches,
			// Only what the response carries: the loader asks for what the policy reads.
			...("tags" in task && { tags: new Set(gidsOf(task.tags)) }),
			...("assignee" in task && { assignee: gidOf(task.assignee) ?? null }),
			...(customFields && { customFields }),
			state: taskState(task),
		};
	}

	private async projectFacts(project: AsanaObject): Promise<Facts | undefined> {
		const gid = stringOf(project.gid);
		if (gid === undefined) {
			return undefined;
		}
		const team = gidOf(project.team);
		const branch: Branch = {
			...(team !== undefined && { team }),
			portfolios: await this.portfolios.containing(gid),
			project: gid,
			taskChain: [],
			unhomed: false,
		};
		const name = stringOf(project.name);
		return {
			workspace: gidOf(project.workspace) ?? this.policy.workspace,
			branches: [branch],
			...(name !== undefined && { state: { name } }),
		};
	}

	private async sectionFacts(section: AsanaObject): Promise<Facts | undefined> {
		const gid = stringOf(section.gid);
		const project = gidOf(section.project);
		if (gid === undefined || project === undefined) {
			return undefined;
		}
		const loaded = await this.load("project", project);
		if (loaded === undefined) {
			return undefined;
		}
		const name = stringOf(section.name);
		return {
			...loaded.facts,
			branches: loaded.facts.branches.map((branch) => ({ ...branch, section: gid })),
			...(name !== undefined && { state: { name } }),
		};
	}

	private async portfolioFacts(portfolio: AsanaObject): Promise<Facts | undefined> {
		const gid = stringOf(portfolio.gid);
		if (gid === undefined) {
			return undefined;
		}
		return {
			workspace: gidOf(portfolio.workspace) ?? this.policy.workspace,
			branches: [{ ...WORKSPACE_BRANCH, portfolios: await this.portfolios.lineageOf(gid) }],
		};
	}

	private teamFacts(team: AsanaObject): Facts | undefined {
		const gid = stringOf(team.gid);
		if (gid === undefined) {
			return undefined;
		}
		return {
			workspace: gidOf(team.organization) ?? this.policy.workspace,
			branches: [{ ...WORKSPACE_BRANCH, team: gid }],
		};
	}

	private goalFacts(goal: AsanaObject): Facts {
		const team = gidOf(goal.team);
		return {
			workspace: gidOf(goal.workspace) ?? this.policy.workspace,
			branches: [{ ...WORKSPACE_BRANCH, ...(team !== undefined && { team }) }],
		};
	}

	private userFacts(user: AsanaObject): Facts {
		const workspaces = gidsOf(user.workspaces);
		// Without the opt-in `workspaces` member we cannot tell; trust the token's scope.
		const member = workspaces.length === 0 || workspaces.includes(this.policy.workspace);
		return workspaceFacts(member ? this.policy.workspace : "");
	}
}

export {
	FactsLoader,
	membershipsOf,
	PARENT_TYPES,
	readOperationOf,
	reliedMembers,
	requiredFields,
	responseSchemaOf,
	taskState,
};
export type { FactsLoaderOptions, Loaded, Membership, ReliedMember, TaskNeeds };
