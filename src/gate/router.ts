// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import type { HttpMethod, OperationSpec } from "../catalog/operation-spec.ts";
import { type OperationId, OPERATIONS } from "../catalog/operations.gen.ts";

/** A matched request path. */
interface RouteMatch {
	readonly operationId: OperationId;
	readonly spec: OperationSpec;
	readonly params: Readonly<Record<string, string>>;
}

interface Route {
	readonly operationId: OperationId;
	readonly spec: OperationSpec;
	readonly pattern: RegExp;
	readonly params: readonly string[];
	readonly staticSegments: number;
}

const PARAM = /\{(?<name>[^}]+)\}/u;

function compileRoute(operationId: OperationId, spec: OperationSpec): Route {
	const params: string[] = [];
	const source = spec.path
		.split("/")
		.map((segment) => {
			const name = PARAM.exec(segment)?.groups?.name;
			if (name === undefined) {
				return segment.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);
			}
			params.push(name);
			return "([^/]+)";
		})
		.join("/");
	return {
		operationId,
		spec,
		pattern: new RegExp(`^${source}$`, "u"),
		params,
		staticSegments: spec.path.split("/").filter((segment) => !segment.startsWith("{")).length,
	};
}

/** Every route, most static first so `/users/me`-like literals beat parameters. */
const ROUTES: readonly Route[] = (Object.entries(OPERATIONS) as [OperationId, OperationSpec][])
	.map(([operationId, spec]) => compileRoute(operationId, spec))
	.toSorted((a, b) => b.staticSegments - a.staticSegments);

const METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** Whether `value` is an HTTP method the API uses. */
function isHttpMethod(value: string): value is HttpMethod {
	return METHODS.has(value);
}

/**
 * Normalizes a request path: strips a query string, a trailing slash, and
 * the `https://app.asana.com/api/1.0` prefix a caller may have copied.
 */
function normalizePath(path: string): string {
	let normalized = path.trim();
	if (/^https?:\/\//u.test(normalized)) {
		normalized = URL.parse(normalized)?.pathname ?? normalized;
	}
	const query = normalized.indexOf("?");
	if (query !== -1) {
		normalized = normalized.slice(0, query);
	}
	normalized = normalized.replace(/^\/api\/1\.0(?=\/)/u, "");
	if (!normalized.startsWith("/")) {
		normalized = `/${normalized}`;
	}
	return normalized.length > 1 ? normalized.replace(/\/+$/u, "") : normalized;
}

/**
 * Whether a path parameter can be sent as the one path segment it stands
 * for: well-formed text, neither empty nor `.` or `..`, which URL resolution
 * takes as steps through the path (`/users/.` is sent as `/users/`) even
 * when they are percent-encoded.
 */
function isPathSegment(value: string): boolean {
	return value !== "" && value !== "." && value !== ".." && value.isWellFormed();
}

/** A path segment, decoded; `undefined` when it is not a well-formed escape of a {@link isPathSegment} value. */
function decoded(segment: string): string | undefined {
	try {
		const value = decodeURIComponent(segment);
		return isPathSegment(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Finds the operation a method and path address, with its path parameters. */
function matchRoute(method: HttpMethod, path: string): RouteMatch | undefined {
	const normalized = normalizePath(path);
	for (const route of ROUTES) {
		const match = route.spec.method === method ? route.pattern.exec(normalized) : null;
		if (match !== null) {
			const params: Record<string, string> = {};
			for (const [i, name] of route.params.entries()) {
				const value = decoded(match[i + 1] ?? "");
				if (value === undefined) {
					// A malformed escape, a lone surrogate or a dot segment names nothing: no route, like Asana's 404.
					return undefined;
				}
				params[name] = value;
			}
			return { operationId: route.operationId, spec: route.spec, params };
		}
	}
	return undefined;
}

/** A path template (`/tasks/{task_gid}`) with its parameters filled in, each percent-encoded. */
function fillPath(template: string, params: Readonly<Record<string, string | undefined>>): string {
	return template.replaceAll(/\{(?<name>[^}]+)\}/gu, (_match, name: string) =>
		encodeURIComponent(params[name] ?? ""),
	);
}

export { fillPath, isHttpMethod, isPathSegment, matchRoute, normalizePath };
export type { RouteMatch };
