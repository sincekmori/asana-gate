import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as z from "zod";

import { POLICY_SCHEMA_URL, PolicyFileSchema } from "../src/policy/schema.ts";
import { SETTINGS_SCHEMA_URL, SettingsFileSchema } from "../src/settings/schema.ts";

// Emits schema.json and settings.schema.json (both shipped in the npm package)
// from the zod schemas, so a policy or settings file's `$schema` pointer gets
// editor validation and autocompletion. Regenerate after changing
// src/policy/schema.ts or src/settings/schema.ts:
//
//   pnpm generate-schema && pnpm format
//
// A test asserts the committed files match this output, so a stale schema
// cannot reach a release.

/** The shipped JSON Schemas by file name: the zod schema each is made from, and how it is titled. */
const JSON_SCHEMAS = {
	"schema.json": {
		schema: PolicyFileSchema,
		id: POLICY_SCHEMA_URL,
		title: "asana-gate policy",
		description:
			"An asana-gate policy: the one workspace it governs and the ordered rules that allow or deny actions in scopes.",
	},
	"settings.schema.json": {
		schema: SettingsFileSchema,
		id: SETTINGS_SCHEMA_URL,
		title: "asana-gate settings",
		description:
			"One layer of asana-gate settings (user, project, project-local or managed); every member is optional and layers are merged.",
	},
};

type JsonSchemaFile = keyof typeof JSON_SCHEMAS;

/** The file names of the shipped JSON Schemas. */
const JSON_SCHEMA_FILES = Object.keys(JSON_SCHEMAS) as JsonSchemaFile[];

/** The JSON Schema written to `file`. */
function jsonSchemaOf(file: JsonSchemaFile): z.core.JSONSchema.BaseSchema {
	const { schema, id, title, description } = JSON_SCHEMAS[file];
	return { ...z.toJSONSchema(schema, { io: "input" }), $id: id, title, description };
}

if (process.argv[1] === import.meta.filename) {
	const root = join(import.meta.dirname, "..");
	await Promise.all(
		JSON_SCHEMA_FILES.map((file) =>
			writeFile(join(root, file), `${JSON.stringify(jsonSchemaOf(file), undefined, 2)}\n`),
		),
	);
	console.log(`wrote ${JSON_SCHEMA_FILES.join(" and ")} to ${root}`);
}

export { JSON_SCHEMA_FILES, jsonSchemaOf };
