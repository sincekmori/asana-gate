// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { AsanaClient } from "../../src/asana/client.ts";
import { Gate } from "../../src/gate/gate.ts";
import { compilePolicy, type PolicyContext } from "../../src/policy/compile.ts";
import { parsePolicy } from "../../src/policy/load.ts";
import { createFakeAsana, type FakeOptions } from "./fake-asana.ts";
import { CONTEXT } from "./world.ts";

export type Fake = ReturnType<typeof createFakeAsana>;
export type Body = Record<string, unknown>;

/** How {@link setupGate} builds the gate: the fake's options, and what a test puts in place of the defaults. */
export interface SetupOptions extends FakeOptions {
	/** Whom the policy is compiled for (default: the fake world's own user). */
	readonly context?: PolicyContext;
	/** The `fetch` the client sends with, made from the fake (default: the fake's own). */
	readonly fetch?: (fake: Fake) => typeof globalThis.fetch;
}

/** A fresh fake Asana and a gate over it, compiled from `policy`. */
export function setupGate(
	policy: string,
	options: SetupOptions = {},
): Promise<{ fake: Fake; gate: Gate }> {
	const fake = createFakeAsana(options);
	const fetch = options.fetch?.(fake) ?? fake.fetch;
	const client = new AsanaClient({ token: "test-token", fetch, maxRetries: 0 });
	const compiled = compilePolicy(parsePolicy(policy), options.context ?? CONTEXT);
	return Promise.resolve({ fake, gate: new Gate({ client, policy: compiled }) });
}

/** The `data` object of a response body. */
export const data = (body: Body): Body => body.data as Body;
/** The `data` list of a response body. */
export const items = (body: Body): Body[] => body.data as Body[];
/** The first error message of a response body. */
export const message = (body: Body): string =>
	(body.errors as { message: string }[])[0]?.message ?? "";
