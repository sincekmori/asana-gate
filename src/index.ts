// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

export { AsanaClient, ASANA_API_BASE_URL } from "./asana/client.ts";
export type { AsanaClientOptions, AsanaRequest, AsanaResponse } from "./asana/client.ts";
export { AsanaApiError } from "./asana/errors.ts";
export type { AsanaErrorEntry } from "./asana/errors.ts";
export { CLASSIFICATION } from "./catalog/classification.ts";
export type { OperationRule, ScopeKind } from "./catalog/classification.ts";
export type { HttpMethod, OperationSpec } from "./catalog/operation-spec.ts";
export { OPERATIONS } from "./catalog/operations.gen.ts";
export type { OperationId } from "./catalog/operations.gen.ts";
export {
	ALL_ACTIONS,
	EXPLICIT_ONLY_ACTIONS,
	FIELD_VERBS,
	isAction,
	isResource,
	RESOURCE_VERBS,
	RESOURCES,
} from "./catalog/resources.ts";
export type { Action, Resource, Verb } from "./catalog/resources.ts";
export { GateError } from "./gate/errors.ts";
export { FactsLoader } from "./gate/facts.ts";
export type { FactsLoaderOptions, Loaded } from "./gate/facts.ts";
export { Gate } from "./gate/gate.ts";
export type { GateOptions, GateRequest, GateResponse } from "./gate/gate.ts";
export { FileListingCache } from "./gate/listing-cache.ts";
export type { ListingCache } from "./gate/listing-cache.ts";
export { AsanaNameResolver } from "./gate/resolver.ts";
export type { ResolverOptions } from "./gate/resolver.ts";
export { matchRoute } from "./gate/router.ts";
export type { RouteMatch } from "./gate/router.ts";
export { createLogger, silentLogger } from "./log.ts";
export type { Logger, LogLevel } from "./log.ts";
export { createAsanaGateServer } from "./mcp/server.ts";
export { serveHttp, serveOverStdio } from "./mcp/serve.ts";
export type { HttpOptions, Serving } from "./mcp/serve.ts";
export { expandActionPattern, expandActionPatterns } from "./policy/actions.ts";
export { compilePolicies, compilePolicy } from "./policy/compile.ts";
export type { CustomFieldDefinition, NameResolver, PolicySource } from "./policy/compile.ts";
export {
	allowedActions,
	decide,
	explainResource,
	isAllowed,
	isVisible,
	workspaceFacts,
} from "./policy/evaluate.ts";
export type { Branch, Decision, Explanation, Facts } from "./policy/evaluate.ts";
export { fieldAllowlist } from "./policy/fields.ts";
export { loadPolicyFile, parsePolicy } from "./policy/load.ts";
export { referencesOf } from "./policy/references.ts";
export type { Reference } from "./policy/references.ts";
export { PolicyFileSchema, RuleSchema, WhereSchema } from "./policy/schema.ts";
export type { PolicyFile, PolicyRule, PolicyWhere } from "./policy/schema.ts";
export { PolicyError } from "./policy/types.ts";
export type {
	CompiledRule,
	CompiledWhere,
	LayerRole,
	Me,
	Policy,
	PolicyLayer,
} from "./policy/types.ts";
export { loadSettings, SettingsError } from "./settings/load.ts";
export type { LoadedSettings, LoadOptions } from "./settings/load.ts";
export { findProjectDir, homeDir, managedDir } from "./settings/paths.ts";
export { SettingsFileSchema, SettingsSchema } from "./settings/schema.ts";
export type { Settings, SettingsFile } from "./settings/schema.ts";
