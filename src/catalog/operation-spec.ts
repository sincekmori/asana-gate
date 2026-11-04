// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

/** HTTP methods the Asana REST API uses. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One operation of the Asana REST API, as extracted from the OpenAPI definition. */
export interface OperationSpec {
	readonly method: HttpMethod;
	/** The path template, e.g. `/tasks/{task_gid}`. */
	readonly path: string;
	/** The OpenAPI tag (resource group), e.g. `Tasks`. */
	readonly tag: string;
	readonly pathParams: readonly string[];
	readonly queryParams: readonly string[];
	/** Writable properties of the request body's `data` object (or multipart fields). */
	readonly bodyParams: readonly string[];
	readonly deprecated: boolean;
}
