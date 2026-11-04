// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { messagesOf, parseErrorEntries } from "../asana/errors.ts";
import { type Action, isAction, verbOf } from "../catalog/resources.ts";
import { isObject, type JsonObject as Json } from "../json.ts";

/**
 * Human-readable rendering of gated responses: a table for lists, key/value
 * lines for one object. `--json` bypasses this and prints the body as is.
 */

/** Members that describe placement or plumbing rather than content. */
const QUIET = new Set([
	"gid",
	"resource_type",
	"resource_subtype",
	"workspace",
	"memberships",
	"parent",
	"custom_fields",
	"allowed_actions",
	"permalink_url",
	"html_notes",
	"html_text",
]);

/** The verbs of an `allowed_actions` list, for a compact column. */
function verbsOf(actions: unknown): string {
	if (!Array.isArray(actions)) {
		return "";
	}
	return actions
		.filter((action): action is Action => typeof action === "string" && isAction(action))
		.map((action) => verbOf(action))
		.join(",");
}

/** Renders a scalar, a reference (`name` or gid) or a list of them. */
function cell(value: unknown): string {
	if (value === null || value === undefined) {
		return "";
	}
	if (Array.isArray(value)) {
		return value.map((item) => cell(item)).join(", ");
	}
	if (isObject(value)) {
		const name = value.name ?? value.title ?? value.gid;
		return typeof name === "string" ? name : JSON.stringify(value);
	}
	if (typeof value === "boolean") {
		return value ? "yes" : "no";
	}
	return typeof value === "string" ? value : JSON.stringify(value);
}

/** Content members shown first when present, in this order; timestamps go last. */
const PREFERRED = ["completed", "assignee", "due_on", "archived", "email", "status_type", "color"];

function rank(key: string): number {
	const preferred = PREFERRED.indexOf(key);
	if (preferred !== -1) {
		return preferred;
	}
	return key.endsWith("_at") ? 1000 : 100;
}

/** Columns worth showing for a list of objects: gid, a title-like member, then up to five content members. */
function columnsFor(items: readonly Json[]): string[] {
	const seen = new Set<string>();
	for (const item of items) {
		for (const key of Object.keys(item)) {
			if (!QUIET.has(key)) {
				seen.add(key);
			}
		}
	}
	const title = ["name", "title", "text", "email"].find((key) => seen.has(key));
	const rest = [...seen]
		.filter((key) => key !== title)
		.toSorted((a, b) => rank(a) - rank(b))
		.slice(0, 5);
	return ["gid", ...(title === undefined ? [] : [title]), ...rest, "allowed"];
}

function renderTable(rows: readonly string[][]): string {
	const widths =
		rows[0]?.map((_, i) => Math.max(...rows.map((row) => (row[i] ?? "").length))) ?? [];
	return rows
		.map((row) =>
			row
				.map((text, i) => text.padEnd(widths[i] ?? 0))
				.join("  ")
				.trimEnd(),
		)
		.join("\n");
}

/** Renders a list response as a table, with a pagination hint. */
function renderList(body: Json): string {
	const items = Array.isArray(body.data)
		? body.data.filter((item): item is Json => isObject(item))
		: [];
	if (items.length === 0) {
		return "(no results)";
	}
	const columns = columnsFor(items);
	const header = columns.map((column) => column.toUpperCase());
	const rows = items.map((item) =>
		columns.map((column) => {
			if (column === "allowed") {
				return verbsOf(item.allowed_actions);
			}
			return cell(item[column]).replaceAll(/\s+/gu, " ").slice(0, 60);
		}),
	);
	const next = isObject(body.next_page) ? body.next_page.offset : undefined;
	const hint = typeof next === "string" ? `\n(more: pass --offset ${next})` : "";
	return `${renderTable([header, ...rows])}${hint}`;
}

/** Renders one object as `key: value` lines. */
function renderObject(object: Json): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(object).filter(
		([member]) => member !== "resource_type",
	)) {
		if (key === "allowed_actions") {
			lines.push(`allowed_actions: ${cell(value)}`);
		} else if (isObject(value) && typeof value.gid === "string") {
			lines.push(`${key}: ${cell(value)} (${value.gid})`);
		} else if (Array.isArray(value) && value.every((item) => isObject(item))) {
			lines.push(
				`${key}: ${value.map((item) => (typeof item.gid === "string" ? `${cell(item)} (${item.gid})` : cell(item))).join(", ")}`,
			);
		} else if (isObject(value) || Array.isArray(value)) {
			lines.push(`${key}: ${JSON.stringify(value)}`);
		} else {
			lines.push(`${key}: ${cell(value)}`);
		}
	}
	return lines.join("\n");
}

/** Renders an error body (`{ errors: [...] }`) as one line per error. */
function renderErrors(status: number, body: Json): string {
	return `${status} ${messagesOf(parseErrorEntries(body, status))}`;
}

/** One action's result in a batch response. */
interface BatchItem extends Json {
	readonly status_code: number;
	readonly body: Json;
}

/** Whether a list is a batch response: one `status_code` and `body` per action. */
function isBatch(items: readonly Json[]): items is readonly BatchItem[] {
	return (
		items.length > 0 &&
		items.every((item) => typeof item.status_code === "number" && isObject(item.body))
	);
}

/** Renders a batch response as one line per action: its number, status, and the object or error it produced. */
function renderBatch(items: readonly BatchItem[]): string {
	return items
		.map((item, index) => {
			if (isObject(item.body.data)) {
				const gid = typeof item.body.data.gid === "string" ? item.body.data.gid : "";
				return `${index + 1}. ${item.status_code} ${gid} ${cell(item.body.data.name)}`.trimEnd();
			}
			return `${index + 1}. ${renderErrors(item.status_code, item.body)}`;
		})
		.join("\n");
}

/** Renders a gated response for people. */
function renderBody(body: Json): string {
	if (Array.isArray(body.data)) {
		const items = body.data.filter((item): item is Json => isObject(item));
		return isBatch(items) ? renderBatch(items) : renderList(body);
	}
	if (isObject(body.data)) {
		return Object.keys(body.data).length === 0 ? "ok" : renderObject(body.data);
	}
	return JSON.stringify(body, null, 2);
}

export { renderBody, renderErrors };
