// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { READ_OPERATIONS } from "../catalog/object-operations.ts";
import type { Resource } from "../catalog/resources.ts";
import { isObject } from "../json.ts";

/** A compact reference Asana embeds in objects. */
interface Ref {
	readonly gid: string;
	readonly resource_type?: string;
	readonly name?: string;
}

/** Any Asana object, as parsed JSON. */
type AsanaObject = Record<string, unknown>;

/** Reads a compact reference, or a bare gid string, from an object member. */
function refOf(value: unknown): Ref | undefined {
	if (typeof value === "string" && value.length > 0) {
		return { gid: value };
	}
	if (isObject(value) && typeof value.gid === "string") {
		return {
			gid: value.gid,
			...(typeof value.resource_type === "string" && { resource_type: value.resource_type }),
			...(typeof value.name === "string" && { name: value.name }),
		};
	}
	return undefined;
}

/** Reads a list of references from an object member. */
function refsOf(value: unknown): Ref[] {
	return Array.isArray(value) ? value.map((v) => refOf(v)).filter((r) => r !== undefined) : [];
}

/** The gid of a reference member, if any. */
function gidOf(value: unknown): string | undefined {
	return refOf(value)?.gid;
}

/** The gids of a reference member, a bare gid, or a list of either. */
function gidsOf(value: unknown): string[] {
	return refsOf(Array.isArray(value) ? value : [value]).map((ref) => ref.gid);
}

/** `resource_type` values that name a policy resource of another name. */
const TYPE_ALIASES: Readonly<Record<string, Resource>> = {
	project_status: "status_update",
	actor: "user",
};

/**
 * Maps Asana `resource_type` values to the policy resources the gate can judge
 * from a gid alone: those Asana reads by gid (the loader places them), access
 * requests (workspace-level, like their operations) and the aliases. Other
 * values map to nothing: a mixed list drops such an item and a reference to
 * one is probed among the types its member may name, so an object that lives
 * inside one it does not name (a custom field setting, a reaction) is never
 * taken for a workspace-level object; values the policy does not model
 * (`enum_option`) map to nothing either.
 */
const RESOURCE_TYPE_MAP: Readonly<Record<string, Resource>> = {
	...Object.fromEntries((Object.keys(READ_OPERATIONS) as Resource[]).map((type) => [type, type])),
	access_request: "access_request",
	...TYPE_ALIASES,
};

/** The policy resource an Asana `resource_type` corresponds to. */
function resourceOfType(resourceType: string | undefined): Resource | undefined {
	// `hasOwn`: a value such as `constructor` must not resolve to a member of Object.prototype.
	return resourceType !== undefined && Object.hasOwn(RESOURCE_TYPE_MAP, resourceType)
		? RESOURCE_TYPE_MAP[resourceType]
		: undefined;
}

export { gidOf, gidsOf, refOf, refsOf, resourceOfType };
export { isObject, stringOf } from "../json.ts";
export type { AsanaObject, Ref };
