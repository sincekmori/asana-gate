// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import * as z from "zod";

import { ASANA_LIMITS } from "../asana/client.ts";
import { LOG_LEVELS } from "../log.ts";
import { DurationSchema } from "../policy/durations.ts";

/** Where editors fetch the settings JSON Schema from. */
const SETTINGS_SCHEMA_URL =
	"https://raw.githubusercontent.com/sincekmori/asana-gate/main/settings.schema.json";

const TokenSchema = z.strictObject({
	env: z.string().min(1).describe("The environment variable holding the Personal Access Token"),
	command: z
		.string()
		.min(1)
		.optional()
		.describe(
			"A command whose standard output is the token (a secret manager's CLI, for example); honored from user and managed settings only",
		),
	file: z
		.string()
		.optional()
		.describe(
			"A file holding the token on its first line; relative to the settings file. Without it, the project's .asana-gate/token and then ~/.asana-gate/token are tried",
		),
});
const LogSchema = z.strictObject({
	level: z.enum(LOG_LEVELS),
	file: z
		.string()
		.nullable()
		.optional()
		.describe(
			"A file log lines are appended to besides stderr, relative to the settings file (default: ~/.asana-gate/logs/asana-gate.log); null for none",
		),
});
const CacheSchema = z.strictObject({
	enabled: z
		.boolean()
		.describe(
			"Whether the names and gids of the workspace's structure are cached on disk between runs",
		),
	dir: z.string().describe("Where the cache lives; relative to the settings file"),
	ttl: DurationSchema.describe("How long a cached listing is trusted before it is read again"),
});
const ConcurrencySchema = z.strictObject({
	reads: z
		.number()
		.int()
		.min(1)
		.max(ASANA_LIMITS.reads)
		.describe(`Concurrent GET requests (Asana allows ${ASANA_LIMITS.reads})`),
	writes: z
		.number()
		.int()
		.min(1)
		.max(ASANA_LIMITS.writes)
		.describe(`Concurrent POST, PUT and DELETE requests (Asana allows ${ASANA_LIMITS.writes})`),
});
const RetriesSchema = z.strictObject({
	max: z
		.number()
		.int()
		.min(0)
		.describe("Retries after a 429, or after a 5xx for anything but a POST"),
	maxWait: DurationSchema.describe(
		"The longest wait before a retry; a longer Retry-After is cut to it",
	),
});
/** A flag of Asana's deprecation framework, as the `Asana-Enable` and `Asana-Disable` headers name one. */
const FlagSchema = z
	.string()
	.regex(/^[a-z0-9_]+$/u, "a flag is lowercase letters, digits and underscores");
const AsanaSchema = z.strictObject({
	enable: z
		.array(FlagSchema)
		.describe(
			"Flags sent in the Asana-Enable header of every request: an early-access opt-in such as ai_teammate_actors (the Agents endpoints), or an announced change taken before its date",
		),
	disable: z
		.array(FlagSchema)
		.describe(
			"Flags sent in the Asana-Disable header of every request: an announced change kept off while Asana still allows it",
		),
});
const McpSchema = z.strictObject({
	transport: z.enum(["stdio", "http"]),
	host: z.string().describe("The HTTP bind address"),
	port: z.number().int().min(1).max(65_535),
	allowedHosts: z
		.array(z.string())
		.describe("Extra host names accepted in Host and Origin headers"),
	authTokenEnv: z
		.string()
		.min(1)
		.describe("The environment variable with the bearer token HTTP clients must present"),
});

/** The settings in force, every member resolved. */
const SettingsSchema = z.strictObject({
	policy: z.string().optional().describe("The policy file"),
	token: TokenSchema,
	log: LogSchema,
	cache: CacheSchema,
	concurrency: ConcurrencySchema,
	retries: RetriesSchema,
	asana: AsanaSchema,
	mcp: McpSchema,
});

/** What one settings file (or layer) may say; everything is optional, and layers are merged. */
const SettingsFileSchema = z.strictObject({
	$schema: z.string().optional(),
	policy: z.string().optional().describe("The policy file, relative to this settings file"),
	token: TokenSchema.partial().optional(),
	log: LogSchema.partial().optional(),
	cache: CacheSchema.partial().optional(),
	concurrency: ConcurrencySchema.partial().optional(),
	retries: RetriesSchema.partial().optional(),
	asana: AsanaSchema.partial().optional(),
	mcp: McpSchema.partial().optional(),
});

type Settings = z.infer<typeof SettingsSchema>;
type SettingsFile = z.infer<typeof SettingsFileSchema>;

export { SETTINGS_SCHEMA_URL, SettingsFileSchema, SettingsSchema };
export type { Settings, SettingsFile };
