// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import { AsanaClient } from "../../src/asana/client.ts";
import { Gate } from "../../src/gate/gate.ts";
import { compilePolicy } from "../../src/policy/compile.ts";
import { parsePolicy } from "../../src/policy/load.ts";
import { createFakeAsana, type FakeOptions } from "./fake-asana.ts";
import { fakeResolver } from "./fake-resolver.ts";

export type Fake = ReturnType<typeof createFakeAsana>;
export type Body = Record<string, unknown>;

/** A fresh fake Asana and a gate over it, compiled from `policy`. */
export async function setupGate(
	policy: string,
	options: FakeOptions = {},
): Promise<{ fake: Fake; gate: Gate }> {
	const fake = createFakeAsana(options);
	const client = new AsanaClient({ token: "test-token", fetch: fake.fetch, maxRetries: 0 });
	const compiled = await compilePolicy(parsePolicy(policy), fakeResolver);
	return { fake, gate: new Gate({ client, policy: compiled }) };
}

/** The `data` object of a response body. */
export const data = (body: Body): Body => body.data as Body;
/** The `data` list of a response body. */
export const items = (body: Body): Body[] => body.data as Body[];
/** The first error message of a response body. */
export const message = (body: Body): string =>
	(body.errors as { message: string }[])[0]?.message ?? "";
