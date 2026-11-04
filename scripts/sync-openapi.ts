import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { parse } from "yaml";

import { isObject, type JsonObject } from "../src/json.ts";
import { envValue } from "../src/system.ts";

// Regenerates the two structural snapshots of Asana's public OpenAPI definition:
//
//   src/catalog/operations.gen.ts  every operation (method, path, parameters, body members, deprecation)
//   src/catalog/schemas.gen.ts     the response schema of every operation, as property names two levels deep
//
// Only structure is recorded — no summaries, descriptions or examples — so a
// diff of these files means the API itself changed, never just its wording.
// src/catalog/classification.ts must classify every operation (a missing entry
// is a type error), and a test checks the fields the gate reads against the
// schemas. Refresh after Asana updates the API:
//
//   pnpm sync-openapi && pnpm format && node scripts/openapi-report.ts
//
// Pass --source <path or URL> to read a local or alternative copy of the spec.

const DEFAULT_SOURCE = "https://raw.githubusercontent.com/Asana/openapi/master/defs/asana_oas.yaml";
const COMMITS_API =
	"https://api.github.com/repos/Asana/openapi/commits?path=defs/asana_oas.yaml&per_page=1";
const METHOD_ORDER = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** Resolves local `#/…` JSON references inside the spec (following chains of them), or returns the value as-is. */
function makeDeref(spec: JsonObject): (value: unknown) => unknown {
	const resolveOnce = (ref: string): unknown => {
		let current: unknown = spec;
		for (const segment of ref.replace(/^#\//u, "").split("/")) {
			current = isObject(current) ? current[segment] : undefined;
		}
		return current;
	};
	return (value) => {
		let current = value;
		const seen = new Set<string>();
		while (isObject(current) && typeof current.$ref === "string" && !seen.has(current.$ref)) {
			seen.add(current.$ref);
			current = resolveOnce(current.$ref);
		}
		return current;
	};
}

const refName = (value: unknown): string | undefined =>
	isObject(value) && typeof value.$ref === "string" ? value.$ref.split("/").at(-1) : undefined;

/** Property names of a schema, following `allOf`; `writableOnly` skips `readOnly` members. */
function propertiesOf(
	schema: unknown,
	deref: (value: unknown) => unknown,
	writableOnly: boolean,
): Map<string, unknown> {
	const resolved = deref(schema);
	const names = new Map<string, unknown>();
	if (!isObject(resolved)) {
		return names;
	}
	for (const variants of [resolved.allOf, resolved.oneOf, resolved.anyOf]) {
		for (const part of Array.isArray(variants) ? variants : []) {
			for (const [name, property] of propertiesOf(part, deref, writableOnly)) {
				names.set(name, property);
			}
		}
	}
	if (isObject(resolved.properties)) {
		for (const [name, property] of Object.entries(resolved.properties)) {
			const prop = deref(property);
			if (!(writableOnly && isObject(prop) && prop.readOnly === true)) {
				names.set(name, property);
			}
		}
	}
	return names;
}

interface Operation {
	operationId: string;
	method: string;
	path: string;
	tag: string;
	pathParams: string[];
	queryParams: string[];
	bodyParams: string[];
	deprecated: boolean;
	responseSchema: string | null;
}

/** The schema name of an operation's success response (`data`, or the items of `data`). */
function responseSchemaOf(op: JsonObject, deref: (value: unknown) => unknown): string | null {
	const responses = isObject(op.responses) ? op.responses : {};
	const success = deref(responses["200"] ?? responses["201"]);
	const content =
		isObject(success) && isObject(success.content)
			? success.content["application/json"]
			: undefined;
	const schema = isObject(content) ? deref(content.schema) : undefined;
	const data = isObject(schema) && isObject(schema.properties) ? schema.properties.data : undefined;
	const direct = refName(data);
	if (direct !== undefined) {
		return direct;
	}
	const items = isObject(data) ? refName(data.items) : undefined;
	return items ?? null;
}

function extractOperations(spec: JsonObject): Operation[] {
	const deref = makeDeref(spec);
	const operations: Operation[] = [];
	const paths = isObject(spec.paths) ? spec.paths : {};
	for (const [path, item] of Object.entries(paths).filter((entry): entry is [string, JsonObject] =>
		isObject(entry[1]),
	)) {
		const shared = Array.isArray(item.parameters) ? item.parameters.map((p) => deref(p)) : [];
		const methods = ["get", "post", "put", "patch", "delete"].filter((method) => {
			const op = item[method];
			return isObject(op) && typeof op.operationId === "string";
		});
		for (const method of methods) {
			const op = item[method] as JsonObject & { operationId: string };
			const own = Array.isArray(op.parameters) ? op.parameters.map((p) => deref(p)) : [];
			const params = [...shared, ...own].filter((p) => isObject(p));
			const body = deref(op.requestBody);
			let bodyParams: string[] = [];
			if (isObject(body) && isObject(body.content)) {
				const media = isObject(body.content["application/json"])
					? body.content["application/json"]
					: body.content["multipart/form-data"];
				const schema = isObject(media) ? deref(media.schema) : undefined;
				const data =
					isObject(schema) && isObject(schema.properties) ? schema.properties.data : undefined;
				bodyParams = [...propertiesOf(data ?? schema, deref, true).keys()];
			}
			operations.push({
				operationId: op.operationId,
				method: method.toUpperCase(),
				path,
				tag: Array.isArray(op.tags) && typeof op.tags[0] === "string" ? op.tags[0] : "",
				pathParams: params.filter((p) => p.in === "path").map((p) => String(p.name)),
				queryParams: params.filter((p) => p.in === "query").map((p) => String(p.name)),
				bodyParams,
				deprecated: op.deprecated === true,
				responseSchema: responseSchemaOf(op, deref),
			});
		}
	}
	operations.sort(
		(a, b) =>
			a.tag.localeCompare(b.tag) ||
			a.path.localeCompare(b.path) ||
			METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method),
	);
	return operations;
}

type Shape = Record<string, Record<string, null> | null>;

/** A schema's property names, and for object-valued members their property names in turn. */
function shapeOf(name: string, spec: JsonObject): Shape {
	const deref = makeDeref(spec);
	const schemas =
		isObject(spec.components) && isObject(spec.components.schemas) ? spec.components.schemas : {};
	const shape: Shape = {};
	for (const [member, property] of propertiesOf(schemas[name], deref, false)) {
		const prop = deref(property);
		const target = isObject(prop) && isObject(prop.items) ? prop.items : property;
		const nested = propertiesOf(target, deref, false);
		shape[member] =
			nested.size === 0
				? null
				: Object.fromEntries([...nested.keys()].toSorted().map((n) => [n, null]));
	}
	return Object.fromEntries(Object.entries(shape).toSorted(([a], [b]) => a.localeCompare(b)));
}

async function readSource(source: string): Promise<string> {
	if (/^https?:\/\//u.test(source)) {
		const response = await fetch(source);
		if (!response.ok) {
			throw new Error(`fetching ${source} failed: ${response.status} ${response.statusText}`);
		}
		return response.text();
	}
	return readFile(source, "utf8");
}

/** The latest upstream commit touching the spec, when reachable; undefined otherwise. */
async function upstreamCommit(): Promise<{ sha: string; date: string } | undefined> {
	try {
		// The refresh workflow passes its token; a local run goes unauthenticated.
		// oxlint-disable-next-line node/no-process-env
		const token = envValue(process.env, "GITHUB_TOKEN");
		const response = await fetch(COMMITS_API, {
			headers: {
				accept: "application/vnd.github+json",
				...(token !== undefined && { authorization: `Bearer ${token}` }),
			},
		});
		if (!response.ok) {
			return undefined;
		}
		const commits = (await response.json()) as {
			sha: string;
			commit: { committer: { date: string } };
		}[];
		const [latest] = commits;
		return latest === undefined
			? undefined
			: { sha: latest.sha, date: latest.commit.committer.date };
	} catch {
		return undefined;
	}
}

function header(source: string, commit: { sha: string; date: string } | undefined): string[] {
	return [
		"// Generated by scripts/sync-openapi.ts — do not edit by hand.",
		`// Source: ${source}`,
		commit ? `// Upstream commit: ${commit.sha} (${commit.date})` : "// Upstream commit: unknown",
		"",
	];
}

function renderOperations(operations: Operation[], head: string[]): string {
	const lines = [
		...head,
		'import type { OperationSpec } from "./operation-spec.ts";',
		"",
		"/** Every operation of the Asana REST API, keyed by its OpenAPI operationId. */",
		"export const OPERATIONS = {",
	];
	for (const op of operations) {
		const { operationId, responseSchema: _responseSchema, ...spec } = op;
		lines.push(`\t${JSON.stringify(operationId)}: ${JSON.stringify(spec)},`);
	}
	lines.push(
		"} as const satisfies Record<string, OperationSpec>;",
		"",
		"/** The operationId of any Asana REST API operation. */",
		"export type OperationId = keyof typeof OPERATIONS;",
		"",
	);
	return lines.join("\n");
}

function renderSchemas(operations: Operation[], spec: JsonObject, head: string[]): string {
	const names = [
		...new Set(operations.map((op) => op.responseSchema).filter((n): n is string => n !== null)),
	].toSorted();
	const lines = [
		...head,
		'import type { OperationId } from "./operations.gen.ts";',
		"",
		"/** A response schema: property names, and the property names of object-valued members. */",
		"export type SchemaShape = Readonly<Record<string, Readonly<Record<string, null>> | null>>;",
		"",
		"/** The success response schema of every operation (the item schema for lists), or null. */",
		"export const RESPONSE_SCHEMAS = {",
	];
	for (const op of operations) {
		lines.push(`\t${JSON.stringify(op.operationId)}: ${JSON.stringify(op.responseSchema)},`);
	}
	lines.push(
		"} as const satisfies Record<OperationId, string | null>;",
		"",
		"/** The response schemas, as property names two levels deep. */",
		"export const SCHEMAS = {",
	);
	for (const name of names) {
		lines.push(`\t${JSON.stringify(name)}: ${JSON.stringify(shapeOf(name, spec))},`);
	}
	lines.push("} as const satisfies Record<string, SchemaShape>;", "");
	return lines.join("\n");
}

const { values } = parseArgs({
	options: {
		source: { type: "string", default: DEFAULT_SOURCE },
		"out-dir": { type: "string", default: join(import.meta.dirname, "..", "src", "catalog") },
	},
});
const text = await readSource(values.source);
const spec: unknown = parse(text);
if (!isObject(spec)) {
	throw new Error("the OpenAPI document is not an object");
}
const operations = extractOperations(spec);
const commit = values.source === DEFAULT_SOURCE ? await upstreamCommit() : undefined;
const head = header(values.source, commit);
await writeFile(join(values["out-dir"], "operations.gen.ts"), renderOperations(operations, head));
await writeFile(join(values["out-dir"], "schemas.gen.ts"), renderSchemas(operations, spec, head));
console.log(`wrote ${operations.length} operations to ${values["out-dir"]}`);
