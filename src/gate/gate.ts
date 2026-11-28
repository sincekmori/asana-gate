// Copyright 2026 Shinsuke Mori
// SPDX-License-Identifier: Apache-2.0

import type { AsanaClient } from "../asana/client.ts";
import type { Resource } from "../catalog/resources.ts";
import { type Logger, silentLogger } from "../log.ts";
import type { Policy } from "../policy/types.ts";
import {
	type ExecuteOptions,
	type GateRequest,
	type GateResponse,
	Passage,
	placementDecidesFor,
	type Planned,
	type Shared,
} from "./passage.ts";

/** Options for {@link Gate}. */
interface GateOptions {
	client: AsanaClient;
	policy: Policy;
	logger?: Logger;
	/** How many extra pages a filtered list may fetch to fill up to the requested size. */
	maxRefillPages?: number;
}

/**
 * The gate in front of Asana: every request passes it on its own
 * ({@link Passage}), under one policy. Between requests it keeps nothing of
 * what Asana said, only how often each limited action ran.
 */
class Gate {
	public readonly policy: Policy;
	public readonly client: AsanaClient;
	private readonly shared: Shared;

	public constructor(options: GateOptions) {
		this.client = options.client;
		this.policy = options.policy;
		this.shared = {
			policy: this.policy,
			client: this.client,
			logger: options.logger ?? silentLogger,
			maxRefillPages: options.maxRefillPages ?? 3,
			placementDecides: placementDecidesFor(this.policy),
			usage: new Map(),
		};
	}

	/** Runs a request through the policy and Asana; refusals and Asana errors become responses. */
	public execute(request: GateRequest, options: ExecuteOptions = {}): Promise<GateResponse> {
		return new Passage(this.shared).execute(request, options);
	}

	/** Classifies and plans a request without sending it; throws a `GateError` when it is refused. */
	public plan(request: GateRequest): Promise<Planned> {
		return new Passage(this.shared).plan(request);
	}

	/** Plans a request and evaluates every check ({@link Passage.authorize}); throws a `GateError` when it is refused. */
	public authorize(request: GateRequest, options: ExecuteOptions = {}): Promise<Planned> {
		return new Passage(this.shared).authorize(request, options);
	}

	/** How the policy treats one object, as an agent may ask ({@link Passage.explain}). */
	public explain(type: Resource, gid: string): ReturnType<Passage["explain"]> {
		return new Passage(this.shared).explain(type, gid);
	}
}

export { Gate };
export type { GateOptions };
export type {
	ConfirmHandler,
	ExecuteOptions,
	GateRequest,
	GateResponse,
	Planned,
} from "./passage.ts";
