// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import * as z from "zod";

import { DurationSchema, resolveDateBound } from "./durations.ts";

/** Where editors fetch the policy JSON Schema from. */
const POLICY_SCHEMA_URL =
	"https://raw.githubusercontent.com/sincekmori/asana-gate/main/schema.json";

/** Matches an Asana gid (a string of digits). */
const GID_PATTERN = /^\d+$/u;

/** Whether a text is a gid. */
const isGid = (ref: string): boolean => GID_PATTERN.test(ref);

/**
 * How a policy names an object: by its gid, which alone tells one object
 * from another (two projects may share a name). A gid goes in quotes, or
 * YAML reads it as a number.
 */
const GID_HINT = 'expected a gid in quotes, such as "1200000000000123"';
const GidSchema = z.string({ error: GID_HINT }).regex(GID_PATTERN, GID_HINT);
const GidArraySchema = z.array(GidSchema).min(1);
const GidListSchema = z
	.union([GidSchema, GidArraySchema], { error: `${GID_HINT}, or a list of them` })
	.describe("One gid, or a list of gids (any of them matches)");
/** How a policy names a user: the token's own (`me`), or a gid. */
const USER_HINT = 'expected "me" or a gid in quotes';
const UserSchema = z.union([z.literal("me"), GidSchema], { error: USER_HINT });
const UserListSchema = z.union([UserSchema, z.array(UserSchema).min(1)], {
	error: `${USER_HINT}, or a list of them`,
});
const ScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
const CustomFieldValueListSchema = z.union([ScalarSchema, z.array(ScalarSchema).min(1)]);
const CustomFieldPredicateSchema = z.record(GidSchema, CustomFieldValueListSchema);
const NonEmptyString = z.string().min(1);
const FieldNamesSchema = z.array(NonEmptyString).min(1);
const NamePredicateSchema = z
	.strictObject({
		prefix: z.string().optional(),
		suffix: z.string().optional(),
		contains: z.string().optional(),
		matches: z.string().optional().describe("A regular expression"),
	})
	.describe("A predicate on an object's name");
const ScalarListSchema = z.array(ScalarSchema);
const BoundSchema = z
	.union([
		z.number(),
		z
			.string()
			.refine(
				(text) => resolveDateBound(text, new Date()) !== undefined,
				"a date: YYYY-MM-DD, ISO 8601, today, now, +7d or -1d",
			),
	])
	.describe("A number, or a date: YYYY-MM-DD, ISO 8601, today, now, +7d, -1d");
const FieldRequirementSchema = z
	.strictObject({
		present: z.boolean().optional().describe("Required on create; cannot be cleared on update"),
		prefix: z.string().optional(),
		suffix: z.string().optional(),
		contains: z.string().optional(),
		matches: z.string().optional().describe("A regular expression the value must match"),
		not_matches: z.string().optional().describe("A regular expression the value must not match"),
		in: ScalarListSchema.optional().describe(
			"Allowed values (gids, where the member names objects)",
		),
		not_in: ScalarListSchema.optional(),
		min_length: z.number().int().nonnegative().optional(),
		max_length: z.number().int().nonnegative().optional(),
		min: BoundSchema.optional(),
		max: BoundSchema.optional(),
	})
	.describe("What a request member must satisfy");
const RequirementSchema = z.union([z.literal(true), FieldRequirementSchema]);
const RequirementOrNestedSchema = z.union([
	RequirementSchema,
	z.record(GidSchema, RequirementSchema),
]);
// Only `custom_fields` nests, by the gid of each field; any other member takes a
// requirement directly, so a misspelled operator is an error.
const ResourceRequirementsSchema = z
	.object({ custom_fields: RequirementOrNestedSchema.optional() })
	.catchall(RequirementSchema);
const RequireSchema = z
	.record(NonEmptyString, ResourceRequirementsSchema)
	.describe(
		"Per resource and request member, what create and update requests must satisfy (`true` means present); `custom_fields` nests by field gid",
	);
const ValueSchema = z.union([ScalarSchema, ScalarListSchema]);
const FieldApplicationSchema = z
	.strictObject({
		default: ValueSchema.optional().describe("Set when the member is absent or empty"),
		value: ValueSchema.optional().describe("Always set, whatever the request says"),
		prefix: z.string().optional().describe("Prepended unless already present"),
		suffix: z.string().optional().describe("Appended unless already present"),
		add: ScalarListSchema.optional().describe("Values a list member must contain"),
	})
	.describe("How a request member is completed or rewritten");
const ApplicationSchema = z.union([ValueSchema, FieldApplicationSchema]);
const ApplicationOrNestedSchema = z.union([
	ApplicationSchema,
	z.record(GidSchema, ApplicationSchema),
]);
const ResourceApplicationsSchema = z
	.object({ custom_fields: ApplicationOrNestedSchema.optional() })
	.catchall(ApplicationSchema);
const ApplySchema = z
	.record(NonEmptyString, ResourceApplicationsSchema)
	.describe(
		"Per resource and request member, how create and update requests are completed (a bare value is a default); `custom_fields` nests by field gid",
	);
const FieldListSchema = z.record(NonEmptyString, FieldNamesSchema);
const LimitSchema = z
	.record(NonEmptyString, z.strictObject({ max: z.number().int().positive(), per: DurationSchema }))
	.describe("Per action, how many requests this scope allows per period");

/** The `where` clause of a rule: the scope it applies to. All keys are ANDed. */
const WhereSchema = z.strictObject({
	team: GidListSchema.optional().describe("Team(s): the team itself and every project in it"),
	portfolio: GidListSchema.optional().describe(
		"Portfolio(s): the portfolio itself and every project in it, including nested portfolios",
	),
	project: GidListSchema.optional().describe("Project(s): the project and everything inside it"),
	section: GidListSchema.optional().describe("Section(s): the section and the tasks in it"),
	task: GidListSchema.optional().describe("Task gid(s): exactly these tasks"),
	subtree: GidListSchema.optional().describe("Task gid(s): these tasks and all of their subtasks"),
	unhomed: z.literal(true).optional().describe("Tasks that belong to no project"),
	tag: GidListSchema.optional().describe("Cross-cutting filter: tasks carrying any of these tags"),
	assignee: UserListSchema.optional().describe(
		'Cross-cutting filter: tasks assigned to any of these users ("me" or a gid)',
	),
	custom_field: CustomFieldPredicateSchema.optional().describe(
		"Cross-cutting filter: tasks whose custom field (by gid) holds any of the given values: the gid of an option, a user or another object the field holds, or its text",
	),
	created_by: UserListSchema.optional().describe(
		'State filter: tasks created by any of these users ("me" or a gid)',
	),
	completed: z.boolean().optional().describe("State filter: whether the task is completed"),
	has_parent: z.boolean().optional().describe("State filter: whether the task is a subtask"),
	name: NamePredicateSchema.optional().describe("State filter: the object's name"),
	overdue: z.boolean().optional().describe("State filter: whether the task's due date has passed"),
	due_within: DurationSchema.optional().describe(
		"State filter: tasks due within this duration from now",
	),
	created_within: DurationSchema.optional().describe(
		"State filter: tasks created within this duration",
	),
});

/** One rule of a policy. */
const RuleSchema = z
	.strictObject({
		where: WhereSchema.optional().describe(
			"The scope this rule applies to; omit for the whole workspace",
		),
		allow: z.array(NonEmptyString).optional().describe("Actions to allow in this scope"),
		deny: z.array(NonEmptyString).optional().describe("Actions to deny in this scope"),
		fields: z
			.record(NonEmptyString, FieldNamesSchema)
			.optional()
			.describe(
				"Per resource, the only fields an `update` may touch in this scope (applies to the rule's `allow` of `<resource>:update`)",
			),
		require: RequireSchema.optional(),
		apply: ApplySchema.optional(),
		forbid: FieldListSchema.optional().describe(
			"Per resource, request members that may not be set",
		),
		redact: FieldListSchema.optional().describe("Per resource, members removed from responses"),
		limit: LimitSchema.optional(),
		confirm: z
			.array(NonEmptyString)
			.optional()
			.describe(
				"Actions that need a person's confirmation in this scope (via MCP elicitation or a CLI prompt)",
			),
	})
	.superRefine((rule, ctx) => {
		const clauses = [
			rule.allow,
			rule.deny,
			rule.require,
			rule.apply,
			rule.forbid,
			rule.redact,
			rule.limit,
			rule.confirm,
		];
		if (clauses.every((clause) => clause === undefined)) {
			ctx.addIssue({
				code: "custom",
				message:
					"a rule needs at least one of allow, deny, require, apply, forbid, redact, limit or confirm",
			});
		}
		if (rule.fields !== undefined && rule.allow === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["fields"],
				message: "`fields` restricts an `allow`; this rule has none",
			});
		}
	});

/** A whole policy file. */
const PolicyFileSchema = z.strictObject({
	$schema: z.string().optional(),
	version: z.literal(1),
	workspace: GidSchema.optional().describe(
		"The gid of the one workspace this policy governs; a file that bounds the project's policy may leave it out and is then in force wherever that one is",
	),
	rules: z.array(RuleSchema).describe("The rules; order does not matter (specificity does)"),
});

type PolicyWhere = z.infer<typeof WhereSchema>;
type PolicyRequirement = z.infer<typeof FieldRequirementSchema>;
type PolicyApplication = z.infer<typeof FieldApplicationSchema>;
type PolicyRule = z.infer<typeof RuleSchema>;
type PolicyFile = z.infer<typeof PolicyFileSchema>;

export { GidSchema, isGid, POLICY_SCHEMA_URL, PolicyFileSchema, RuleSchema, WhereSchema };
export type { PolicyApplication, PolicyFile, PolicyRequirement, PolicyRule, PolicyWhere };
