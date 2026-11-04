// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import type { OperationSpec } from "./operation-spec.ts";
import { type OperationId, OPERATIONS } from "./operations.gen.ts";
import { isResource, RESOURCE_VERBS, type Resource, type Verb } from "./resources.ts";

/** The verb of a plain `GET`, `PUT` or `DELETE` of one object. */
const OBJECT_VERBS = { GET: "read", PUT: "update", DELETE: "delete" } as const;

/** `/<resource>s/{<resource>_gid}`. */
const OBJECT_PATH = /^\/[^/]+\/\{(?<resource>\w+)_gid\}$/u;

/**
 * Whether an operation is a plain read, update or delete of one object,
 * `GET|PUT|DELETE /<resource>s/{<resource>_gid}` of a resource with that verb
 * ({@link objectOperationOf} at run time).
 */
type IsObjectOperation<Spec> = Spec extends {
	readonly method: infer Method extends keyof typeof OBJECT_VERBS;
	readonly path: `/${infer Plural}/{${infer Type}_gid}`;
}
	? Plural extends `${string}/${string}`
		? false
		: Type extends Resource
			? (typeof OBJECT_VERBS)[Method] extends (typeof RESOURCE_VERBS)[Type][number]
				? true
				: false
			: false
	: false;

/** The operations {@link IsObjectOperation} holds for. */
type ObjectOperationId = {
	[Id in OperationId]: IsObjectOperation<(typeof OPERATIONS)[Id]> extends true ? Id : never;
}[OperationId];

/** What a plain read, update or delete of one object acts on. */
interface ObjectOperation {
	readonly resource: Resource;
	readonly verb: (typeof OBJECT_VERBS)[keyof typeof OBJECT_VERBS];
}

/** The resource and verb of `spec`, when it is a plain read, update or delete of one object. */
function objectOperationOf(spec: OperationSpec): ObjectOperation | undefined {
	const type = OBJECT_PATH.exec(spec.path)?.groups?.resource;
	const verb = Object.hasOwn(OBJECT_VERBS, spec.method)
		? OBJECT_VERBS[spec.method as keyof typeof OBJECT_VERBS]
		: undefined;
	if (type === undefined || verb === undefined || !isResource(type)) {
		return undefined;
	}
	const verbs: readonly Verb[] = RESOURCE_VERBS[type];
	return verbs.includes(verb) ? { resource: type, verb } : undefined;
}

/**
 * Per resource, the operation that reads one object by gid. Its path is where
 * the loader fetches objects, and its response schema is what a test checks
 * the fields the gate reads against, so a renamed member in Asana's
 * definition fails the build instead of silently making objects unplaceable.
 */
const READ_OPERATIONS: Readonly<Partial<Record<Resource, OperationId>>> = Object.fromEntries(
	(Object.keys(OPERATIONS) as OperationId[]).flatMap((id) => {
		const operation = objectOperationOf(OPERATIONS[id]);
		return operation?.verb === "read" ? [[operation.resource, id] as const] : [];
	}),
);

export { objectOperationOf, READ_OPERATIONS };
export type { ObjectOperationId };
