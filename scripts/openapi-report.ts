import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { CLASSIFICATION, type OperationRule } from "../src/catalog/classification.ts";
import { reliedMembers } from "../src/gate/facts.ts";

// Compares the committed OpenAPI snapshots (git HEAD) with the working tree
// after `pnpm sync-openapi`, and prints a Markdown report of what changed in
// the Asana API — structurally, never cosmetically — and what asana-gate must
// do about it. The weekly refresh workflow puts this report in its PR.
//
//   pnpm sync-openapi && node scripts/openapi-report.ts

const ROOT = join(import.meta.dirname, "..");
const FILES = {
	operations: "src/catalog/operations.gen.ts",
	schemas: "src/catalog/schemas.gen.ts",
};

type Json = Record<string, unknown>;

/**
 * Loads a generated module from its source text and returns the named export.
 * The text is written to a temporary file and imported, so the formatter's
 * choices (quoted keys, line breaks) do not matter.
 */
async function constant(text: string, name: string): Promise<Json> {
	if (text === "") {
		return {};
	}
	const dir = await mkdtemp(join(tmpdir(), "asana-gate-openapi-"));
	const file = join(dir, `${name.toLowerCase()}.ts`);
	await writeFile(file, text);
	try {
		const module = (await import(pathToFileURL(file).href)) as Record<string, Json>;
		return module[name] ?? {};
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** The committed version of a file, or "" before the first commit. */
async function fromHead(path: string): Promise<string> {
	const child = spawn("git", ["show", `HEAD:${path}`], {
		cwd: ROOT,
		stdio: ["ignore", "pipe", "ignore"],
	});
	const chunks: Buffer[] = [];
	for await (const chunk of child.stdout) {
		chunks.push(chunk as Buffer);
	}
	const [code] = (await once(child, "close")) as [number | null];
	return code === 0 ? Buffer.concat(chunks).toString("utf8") : "";
}

const sortedKeys = (object: Json): string[] => Object.keys(object).toSorted();
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

interface Report {
	addedOperations: string[];
	/** Added operations the classification already covers: plain reads, updates and deletes of one object. */
	derivedOperations: string[];
	removedOperations: string[];
	changedOperations: string[];
	deprecatedOperations: string[];
	addedSchemas: string[];
	removedSchemas: string[];
	changedSchemas: { name: string; added: string[]; removed: string[] }[];
	actionRequired: string[];
}

type Snapshot = { operations: Json; schemas: Json };

function compareOperations(before: Snapshot, after: Snapshot, report: Report): void {
	for (const id of sortedKeys(after.operations)) {
		const now = after.operations[id] as Json;
		const was = before.operations[id] as Json | undefined;
		const line = `\`${id}\` (${String(now.method)} ${String(now.path)})`;
		const rule = (CLASSIFICATION as Partial<Record<string, OperationRule>>)[id];
		if (was === undefined) {
			report.addedOperations.push(line);
			if (rule !== undefined) {
				report.derivedOperations.push(`${line} as \`${String(rule.action)}\``);
			}
		} else if (!same(was, now)) {
			const changes = ["method", "path", "pathParams", "queryParams", "bodyParams", "deprecated"]
				.filter((key) => !same(was[key], now[key]))
				.map((key) => `${key}: ${JSON.stringify(was[key])} → ${JSON.stringify(now[key])}`);
			report.changedOperations.push(`${line}: ${changes.join("; ")}`);
			if (was.deprecated !== true && now.deprecated === true) {
				report.deprecatedOperations.push(line);
			}
		}
	}
	for (const id of sortedKeys(before.operations).filter((gone) => !(gone in after.operations))) {
		const was = before.operations[id] as Json;
		report.removedOperations.push(`\`${id}\` (${String(was.method)} ${String(was.path)})`);
	}
}

/** Per response schema, the members the gate reads from objects of that schema. */
function reliedBySchema(): Map<string, Set<string>> {
	const relied = new Map<string, Set<string>>();
	for (const { schema, member } of reliedMembers()) {
		relied.set(schema, (relied.get(schema) ?? new Set<string>()).add(member));
	}
	return relied;
}

function compareSchemas(before: Snapshot, after: Snapshot, report: Report): void {
	const relied = reliedBySchema();
	for (const name of sortedKeys(after.schemas)) {
		const now = after.schemas[name] as Json;
		const was = before.schemas[name] as Json | undefined;
		if (was === undefined) {
			report.addedSchemas.push(`\`${name}\``);
		} else if (!same(was, now)) {
			const added = sortedKeys(now).filter((member) => !(member in was));
			const removed = sortedKeys(was).filter((member) => !(member in now));
			const nested = sortedKeys(now).filter(
				(member) => member in was && !same(was[member], now[member]),
			);
			report.changedSchemas.push({
				name,
				added: [...added, ...nested.map((member) => `${member} (members changed)`)],
				removed,
			});
			for (const key of [...removed, ...nested].filter(
				(member) => relied.get(name)?.has(member) === true,
			)) {
				report.actionRequired.push(
					`\`${name}.${key}\` changed, and the gate reads it to place objects (see src/gate/facts.ts)`,
				);
			}
		}
	}
	for (const name of sortedKeys(before.schemas).filter((gone) => !(gone in after.schemas))) {
		report.removedSchemas.push(`\`${name}\``);
	}
}

function compare(before: Snapshot, after: Snapshot): Report {
	const report: Report = {
		addedOperations: [],
		derivedOperations: [],
		removedOperations: [],
		changedOperations: [],
		deprecatedOperations: [],
		addedSchemas: [],
		removedSchemas: [],
		changedSchemas: [],
		actionRequired: [],
	};
	compareOperations(before, after, report);
	compareSchemas(before, after, report);
	const unclassified = report.addedOperations.length - report.derivedOperations.length;
	if (unclassified > 0) {
		report.actionRequired.push(
			`classify ${unclassified} new operation(s) in src/catalog/classification.ts (typecheck fails until then)`,
		);
	}
	if (report.derivedOperations.length > 0) {
		report.actionRequired.push(
			`confirm the action of ${report.derivedOperations.length} new operation(s) classified from their path, or classify them by hand (see ClassifiedOtherwise in src/catalog/classification.ts)`,
		);
	}
	if (report.removedOperations.length > 0) {
		report.actionRequired.push(
			`drop the removed operation(s) src/catalog/classification.ts names (typecheck fails until then)`,
		);
	}
	if (report.changedOperations.length > 0) {
		report.actionRequired.push(
			"review the changed operations: their parameters decide how the gate finds the scope of a request",
		);
	}
	return report;
}

function section(title: string, lines: string[]): string[] {
	return lines.length === 0 ? [] : [`### ${title}`, "", ...lines.map((line) => `- ${line}`), ""];
}

function render(report: Report): string {
	const total =
		report.addedOperations.length +
		report.removedOperations.length +
		report.changedOperations.length +
		report.addedSchemas.length +
		report.removedSchemas.length +
		report.changedSchemas.length;
	if (total === 0) {
		return "No structural changes in the Asana OpenAPI definition.\n";
	}
	const lines = ["## Asana OpenAPI changes", ""];
	if (report.actionRequired.length > 0) {
		lines.push("### Action required", "", ...report.actionRequired.map((line) => `- ${line}`), "");
	} else {
		lines.push("No action required: the changes do not touch anything asana-gate relies on.", "");
	}
	lines.push(
		...section("Added operations", report.addedOperations),
		...section("Added operations classified from their path", report.derivedOperations),
		...section("Removed operations", report.removedOperations),
		...section("Newly deprecated operations", report.deprecatedOperations),
		...section("Changed operations", report.changedOperations),
		...section("Added response schemas", report.addedSchemas),
		...section("Removed response schemas", report.removedSchemas),
		...section(
			"Changed response schemas",
			report.changedSchemas.map(
				(s) =>
					`\`${s.name}\`${s.added.length > 0 ? ` added: ${s.added.join(", ")}` : ""}${s.removed.length > 0 ? ` removed: ${s.removed.join(", ")}` : ""}`,
			),
		),
	);
	return lines.join("\n");
}

const before = {
	operations: await constant(await fromHead(FILES.operations), "OPERATIONS"),
	schemas: await constant(await fromHead(FILES.schemas), "SCHEMAS"),
};
const after = {
	operations: await constant(await readFile(join(ROOT, FILES.operations), "utf8"), "OPERATIONS"),
	schemas: await constant(await readFile(join(ROOT, FILES.schemas), "utf8"), "SCHEMAS"),
};
console.log(render(compare(before, after)));
